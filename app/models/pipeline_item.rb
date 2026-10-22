# == Schema Information
#
# Table name: pipeline_items
#
#  id                      :bigint           not null, primary key
#  custom_attributes       :jsonb            not null
#  notes                   :text
#  position                :integer          default(0), not null
#  stage_changed_at        :datetime
#  stale_alert_sent_at     :datetime
#  title                   :string(255)
#  value                   :decimal(15, 2)   default(0.0)
#  created_at              :datetime         not null
#  updated_at              :datetime         not null
#  account_id              :bigint           not null
#  assignee_id             :bigint
#  contact_id              :bigint           not null
#  conversation_id         :bigint
#  pipeline_id             :bigint           not null
#  pipeline_lost_reason_id :bigint
#  pipeline_stage_id       :bigint           not null
#  team_id                 :bigint
#
# Indexes
#
#  index_pipeline_items_on_account_id                            (account_id)
#  index_pipeline_items_on_account_id_and_contact_id             (account_id,contact_id)
#  index_pipeline_items_on_assignee_id                           (assignee_id)
#  index_pipeline_items_on_contact_id                            (contact_id)
#  index_pipeline_items_on_conversation_id                       (conversation_id)
#  index_pipeline_items_on_pipeline_id                           (pipeline_id)
#  index_pipeline_items_on_pipeline_id_and_contact_id            (pipeline_id,contact_id) UNIQUE
#  index_pipeline_items_on_pipeline_lost_reason_id               (pipeline_lost_reason_id)
#  index_pipeline_items_on_pipeline_stage_id                     (pipeline_stage_id)
#  index_pipeline_items_on_pipeline_stage_id_and_position        (pipeline_stage_id,position)
#  index_pipeline_items_on_stage_changed_at_pending_stale_alert  (stage_changed_at) WHERE ((stale_alert_sent_at IS NULL) AND (assignee_id IS NOT NULL))
#  index_pipeline_items_on_team_id                               (team_id)
#
# Foreign Keys
#
#  fk_rails_...  (assignee_id => users.id)
#  fk_rails_...  (pipeline_id => pipelines.id)
#  fk_rails_...  (pipeline_lost_reason_id => pipeline_lost_reasons.id)
#  fk_rails_...  (team_id => teams.id)
#
class PipelineItem < ApplicationRecord
  include Labelable

  belongs_to :account
  belongs_to :pipeline_stage
  belongs_to :contact
  belongs_to :conversation, optional: true
  belongs_to :assignee, class_name: 'User', optional: true
  belongs_to :team, optional: true
  # Own FK column so pipeline_id can be queried/indexed directly (card-uniqueness scope, kanban
  # real-time filter) without joining through pipeline_stage. Intentionally not the public read
  # path for #pipeline, though - see the `delegate` below, which overrides this association's
  # own reader on purpose.
  belongs_to :pipeline, optional: true
  belongs_to :pipeline_lost_reason, optional: true

  has_many :tasks, dependent: :nullify

  validates :contact_id, presence: true
  validates :pipeline_stage_id, presence: true
  validates :contact_id, uniqueness: {
    scope: :pipeline_id,
    message: ->(_object, _data) { I18n.t('errors.pipeline_item.duplicate_contact_in_pipeline') }
  }
  # Not cleared automatically when a card leaves the lost stage (e.g. reopened) - it's kept as
  # informational history of the last recorded reason, not a hard constraint.
  validates :pipeline_lost_reason_id, presence: true, if: -> { pipeline_stage&.lost? }
  validate :assignee_must_be_pipeline_member
  validate :labels_must_be_pipeline_type
  validate :conversation_must_belong_to_contact, if: -> { conversation_id.present? }

  before_validation :set_pipeline_id_from_stage
  before_save :touch_stage_changed_at, if: :pipeline_stage_id_changed?
  # unless: :position_changed? so a caller that explicitly assigns a position (none does today,
  # per the task 24 audit) isn't silently overridden. Note this checks against the column
  # default (0), not "was a key passed" - a caller that explicitly passes `position: 0` would
  # still be overridden, since that's indistinguishable from never touching it. No current
  # caller does that.
  before_create :assign_position, unless: :position_changed?

  after_create_commit :dispatch_created_event
  after_update_commit :dispatch_stage_changed_event, if: :saved_change_to_pipeline_stage_id?
  after_update_commit :dispatch_updated_event, if: :broadcast_relevant_change?

  # Deliberately overrides the belongs_to :pipeline reader above: pipeline_stage is the
  # source of truth for which pipeline a card is in (pipeline_id is kept in sync via
  # set_pipeline_id_from_stage below, purely for the FK/index use cases). Keeping both is
  # intentional, not an oversight - see the comment on the belongs_to.
  delegate :pipeline, to: :pipeline_stage

  # Exposed in email templates through liquid (see ApplicationRecord#droppables) - needed for
  # the pipeline_item_stale mailer (app/mailers/agent_notifications/conversation_notifications_mailer.rb).
  def droppables
    super + ['PipelineItem']
  end

  def push_event_data
    {
      id: id,
      title: title,
      value: json_safe_value,
      notes: notes,
      position: position,
      pipeline_stage_id: pipeline_stage_id,
      pipeline_id: pipeline_stage.pipeline_id,
      pipeline_name: pipeline_stage.pipeline.name,
      pipeline_stage_name: pipeline_stage.name,
      conversation_id: conversation_id,
      created_at: created_at.to_i,
      updated_at: updated_at.to_i,
      updated_at_usec: (updated_at.to_r * 1_000_000).to_i,
      contact: contact_push_event_data,
      assignee: assignee&.push_event_data,
      team: team&.push_event_data,
      label_list: label_list,
      custom_attributes: custom_attributes
    }
  end

  # ActionCableBroadcastJob is enqueued via Sidekiq's strict_args mode, which rejects
  # BigDecimal (the raw type for a decimal column) as a non-native-JSON job argument.
  def json_safe_value
    value&.to_f
  end

  def webhook_data
    {
      id: id,
      title: title,
      value: json_safe_value,
      notes: notes,
      pipeline_id: pipeline_id,
      pipeline_name: pipeline&.name,
      pipeline_stage_id: pipeline_stage_id,
      pipeline_stage_name: pipeline_stage&.name,
      assignee_id: assignee_id,
      assignee_name: assignee&.name,
      team_id: team_id,
      team_name: team&.name,
      contact_id: contact_id,
      conversation_id: conversation_id,
      created_at: created_at,
      updated_at: updated_at
    }
  end

  # acts_as_taggable_on's #label_list always re-queries tags (it builds `base_tags.where(...)`
  # from scratch, ignoring any preloaded association), so it N+1s under any eager load. This
  # reads the same rows off the preloaded `taggings: :tag` association instead - used by the
  # API jbuilder, which eager loads that association for exactly this reason.
  def preloaded_label_list
    taggings.select { |tagging| tagging.context == 'labels' && tagging.tagger_id.nil? }.filter_map(&:tag).map(&:name)
  end

  # Deliberately not Contact#push_event_data: that uses `thumbnail`, but the Kanban UI
  # (mirroring the pipeline_item API jbuilder) expects `avatar_url`.
  def contact_push_event_data
    {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone_number: contact.phone_number,
      avatar_url: contact.avatar_url
    }
  end

  private

  def dispatch_created_event
    Rails.configuration.dispatcher.dispatch(
      Events::Types::PIPELINE_ITEM_CREATED, Time.zone.now,
      pipeline_item: self, performed_by: Current.executed_by
    )
  end

  def dispatch_stage_changed_event
    Rails.configuration.dispatcher.dispatch(
      Events::Types::PIPELINE_ITEM_STAGE_CHANGED, Time.zone.now,
      pipeline_item: self, performed_by: Current.executed_by,
      previous_stage_id: saved_change_to_pipeline_stage_id.first
    )
  end

  # Broader than saved_change_to_pipeline_stage_id? on purpose - see PIPELINE_ITEM_UPDATED's
  # comment in lib/events/types.rb.
  def broadcast_relevant_change?
    visible_attributes = %w[pipeline_stage_id assignee_id team_id title value notes position conversation_id custom_attributes pipeline_lost_reason_id]
    previous_changes.keys.intersect?(visible_attributes) || saved_change_to_label_list?
  end

  def dispatch_updated_event
    Rails.configuration.dispatcher.dispatch(
      Events::Types::PIPELINE_ITEM_UPDATED, Time.zone.now,
      pipeline_item: self, performed_by: Current.executed_by,
      changed_attributes: previous_changes
    )
  end

  def set_pipeline_id_from_stage
    return if pipeline_stage_id.blank?

    self.pipeline_id = pipeline_stage.pipeline_id if pipeline_stage_id_changed? || pipeline_id.blank?
  end

  # Every card used to nurse in at position 0 (the column default, task 24) - a card born on
  # a page the client hadn't loaded looked identical, position-wise, to one just dragged to the
  # very top, so reordering the loaded prefix pushed every untouched, unloaded card above it on
  # the next fetch. New cards now go to the end of their stage instead.
  def assign_position
    self.position = pipeline_stage.next_position
  end

  def touch_stage_changed_at
    self.stage_changed_at = Time.zone.now
    # Card moved again - it may go stale in its new stage and deserves a fresh alert then.
    self.stale_alert_sent_at = nil
  end

  def labels_must_be_pipeline_type
    return if label_list.blank?

    allowed = account.labels.pipeline_label.pluck(:title)
    invalid = label_list - allowed
    errors.add(:label_list, "invalid pipeline labels: #{invalid.join(', ')}") if invalid.any?
  end

  def conversation_must_belong_to_contact
    return if conversation&.contact_id == contact_id

    errors.add(:conversation_id, I18n.t('errors.pipeline_item.conversation_contact_mismatch'))
  end

  def assignee_must_be_pipeline_member
    return if assignee_id.blank?
    return if assignee.administrator?
    return if pipeline.members.exists?(id: assignee_id)

    errors.add(:assignee_id, I18n.t('errors.pipeline_item.assignee_not_member'))
  end
end
