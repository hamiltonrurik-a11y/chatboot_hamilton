require 'rails_helper'

RSpec.describe PipelineItem do
  let(:account) { create(:account) }
  let(:pipeline) { create(:pipeline, account: account) }
  let(:stage) { create(:pipeline_stage, pipeline: pipeline, account: account) }
  let(:contact) { create(:contact, account: account) }

  after do
    Current.account = nil
  end

  describe 'validations' do
    it { is_expected.to validate_presence_of(:contact_id) }
    it { is_expected.to validate_presence_of(:pipeline_stage_id) }

    describe 'assignee_must_be_pipeline_member' do
      it 'is invalid when assignee is not a pipeline member' do
        agent = create(:user, account: account, role: :agent)
        item = build(:pipeline_item, pipeline_stage: stage, account: account, contact: contact, assignee: agent)

        expect(item).to be_invalid
        expect(item.errors[:assignee_id]).to be_present
      end

      it 'is valid when assignee is a pipeline member' do
        agent = create(:user, account: account, role: :agent)
        create(:pipeline_member, pipeline: pipeline, user: agent)
        item = build(:pipeline_item, pipeline_stage: stage, account: account, contact: contact, assignee: agent)

        expect(item).to be_valid
      end

      it 'is valid when assignee is an administrator, even without pipeline membership' do
        Current.account = account
        admin = create(:user, account: account, role: :administrator)
        item = build(:pipeline_item, pipeline_stage: stage, account: account, contact: contact, assignee: admin)

        expect(item).to be_valid
      end
    end

    describe 'labels_must_be_pipeline_type' do
      it 'is invalid when a label is not a pipeline label' do
        create(:label, account: account, title: 'general_label', label_type: :general_label)
        item = build(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)
        item.label_list = ['general_label']

        expect(item).to be_invalid
        expect(item.errors[:label_list]).to be_present
      end

      it 'is valid when the label is a pipeline label' do
        create(:label, account: account, title: 'pipeline_label', label_type: :pipeline_label)
        item = build(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)
        item.label_list = ['pipeline_label']

        expect(item).to be_valid
      end
    end

    describe 'conversation_must_belong_to_contact' do
      it 'is invalid when the conversation belongs to a different contact' do
        other_contact = create(:contact, account: account)
        conversation = create(:conversation, account: account, contact: other_contact)
        item = build(:pipeline_item, pipeline_stage: stage, account: account, contact: contact, conversation: conversation)

        expect(item).to be_invalid
        expect(item.errors[:conversation_id]).to be_present
      end

      it 'is valid when the conversation belongs to the same contact' do
        conversation = create(:conversation, account: account, contact: contact)
        item = build(:pipeline_item, pipeline_stage: stage, account: account, contact: contact, conversation: conversation)

        expect(item).to be_valid
      end
    end

    describe 'contact_id uniqueness scoped to pipeline_id' do
      it 'is invalid when the contact already has a card in the same pipeline' do
        other_stage = create(:pipeline_stage, pipeline: pipeline, account: account)
        create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)
        duplicate = build(:pipeline_item, pipeline_stage: other_stage, account: account, contact: contact)

        expect(duplicate).to be_invalid
        expect(duplicate.errors[:contact_id]).to include(I18n.t('errors.pipeline_item.duplicate_contact_in_pipeline'))
      end

      it 'is valid when the contact has cards in different pipelines' do
        other_pipeline = create(:pipeline, account: account)
        other_stage = create(:pipeline_stage, pipeline: other_pipeline, account: account)
        create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)
        item = build(:pipeline_item, pipeline_stage: other_stage, account: account, contact: contact)

        expect(item).to be_valid
      end
    end
  end

  describe '#set_pipeline_id_from_stage' do
    it 'syncs pipeline_id from the pipeline_stage on create' do
      item = create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)

      expect(item.pipeline_id).to eq(pipeline.id)
    end

    it 'resyncs pipeline_id when pipeline_stage_id changes to a stage of another pipeline' do
      other_pipeline = create(:pipeline, account: account)
      other_stage = create(:pipeline_stage, pipeline: other_pipeline, account: account)
      item = create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)

      item.update!(pipeline_stage: other_stage)

      expect(item.pipeline_id).to eq(other_pipeline.id)
    end
  end

  describe 'event dispatching' do
    before do
      allow(Rails.configuration.dispatcher).to receive(:dispatch)
    end

    it 'dispatches PIPELINE_ITEM_CREATED after create' do
      item = create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)

      expect(Rails.configuration.dispatcher).to have_received(:dispatch)
        .with(Events::Types::PIPELINE_ITEM_CREATED, kind_of(Time), pipeline_item: item, performed_by: nil)
    end

    it 'dispatches PIPELINE_ITEM_STAGE_CHANGED after the stage changes' do
      item = create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)
      other_stage = create(:pipeline_stage, pipeline: pipeline, account: account)

      item.update!(pipeline_stage: other_stage)

      expect(Rails.configuration.dispatcher).to have_received(:dispatch)
        .with(Events::Types::PIPELINE_ITEM_STAGE_CHANGED, kind_of(Time), pipeline_item: item,
                                                                         performed_by: nil, previous_stage_id: stage.id)
    end

    it 'does not dispatch PIPELINE_ITEM_STAGE_CHANGED for updates that do not touch the stage' do
      item = create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)

      item.update!(title: 'Updated title')

      expect(Rails.configuration.dispatcher).not_to have_received(:dispatch)
        .with(Events::Types::PIPELINE_ITEM_STAGE_CHANGED, anything, anything)
    end

    it 'dispatches PIPELINE_ITEM_UPDATED when the stage changes' do
      item = create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)
      other_stage = create(:pipeline_stage, pipeline: pipeline, account: account)

      item.update!(pipeline_stage: other_stage)

      expect(Rails.configuration.dispatcher).to have_received(:dispatch)
        .with(Events::Types::PIPELINE_ITEM_UPDATED, kind_of(Time),
              pipeline_item: item, performed_by: nil, changed_attributes: kind_of(Hash))
    end

    it 'dispatches PIPELINE_ITEM_UPDATED when the assignee changes' do
      agent = create(:user, account: account, role: :agent)
      create(:pipeline_member, pipeline: pipeline, user: agent)
      item = create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)

      item.update!(assignee: agent)

      expect(Rails.configuration.dispatcher).to have_received(:dispatch)
        .with(Events::Types::PIPELINE_ITEM_UPDATED, kind_of(Time),
              pipeline_item: item, performed_by: nil, changed_attributes: kind_of(Hash))
    end

    it 'dispatches PIPELINE_ITEM_UPDATED when the team changes' do
      team = create(:team, account: account)
      item = create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)

      item.update!(team: team)

      expect(Rails.configuration.dispatcher).to have_received(:dispatch)
        .with(Events::Types::PIPELINE_ITEM_UPDATED, kind_of(Time),
              pipeline_item: item, performed_by: nil, changed_attributes: kind_of(Hash))
    end

    it 'dispatches PIPELINE_ITEM_UPDATED when visible card fields change without moving stage' do
      item = create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)

      item.update!(title: 'Updated title', value: 150, notes: 'Confirmed order', custom_attributes: { 'status' => 'confirmed' })

      expect(Rails.configuration.dispatcher).to have_received(:dispatch)
        .with(Events::Types::PIPELINE_ITEM_UPDATED, kind_of(Time),
              pipeline_item: item, performed_by: nil, changed_attributes: kind_of(Hash))
      expect(Rails.configuration.dispatcher).not_to have_received(:dispatch)
        .with(Events::Types::PIPELINE_ITEM_STAGE_CHANGED, anything, anything)
    end

    it 'dispatches PIPELINE_ITEM_UPDATED for label changes used by board filters' do
      create(:label, account: account, title: 'priority', label_type: :pipeline_label)
      item = create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)

      item.update!(label_list: ['priority'])

      expect(Rails.configuration.dispatcher).to have_received(:dispatch)
        .with(Events::Types::PIPELINE_ITEM_UPDATED, kind_of(Time),
              pipeline_item: item, performed_by: nil, changed_attributes: kind_of(Hash))
    end

    it 'does not dispatch PIPELINE_ITEM_UPDATED for internal stale-alert bookkeeping alone' do
      item = create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)

      item.update!(stale_alert_sent_at: Time.current)

      expect(Rails.configuration.dispatcher).not_to have_received(:dispatch)
        .with(Events::Types::PIPELINE_ITEM_UPDATED, anything, anything)
    end
  end

  describe '#push_event_data' do
    let(:agent) { create(:user, account: account, role: :agent) }
    let(:team) { create(:team, account: account) }
    let(:item) do
      create(:pipeline_member, pipeline: pipeline, user: agent)
      create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact,
                             assignee: agent, team: team, title: 'Deal', value: 100)
    end

    it 'includes the card fields and pipeline/stage names' do
      data = item.push_event_data

      expect(data[:id]).to eq(item.id)
      expect(data[:title]).to eq('Deal')
      expect(data[:pipeline_stage_id]).to eq(stage.id)
      expect(data[:pipeline_id]).to eq(pipeline.id)
      expect(data[:pipeline_name]).to eq(pipeline.name)
      expect(data[:pipeline_stage_name]).to eq(stage.name)
      expect(data[:updated_at]).to eq(item.updated_at.to_i)
      expect(data[:updated_at_usec]).to eq((item.updated_at.to_r * 1_000_000).to_i)
    end

    it 'builds the contact sub-hash with avatar_url (not Contact#push_event_data\'s thumbnail)' do
      data = item.push_event_data

      expect(data[:contact]).to eq(
        id: contact.id, name: contact.name, email: contact.email,
        phone_number: contact.phone_number, avatar_url: contact.avatar_url
      )
      expect(data[:contact]).not_to have_key(:thumbnail)
    end

    it 'includes the assignee and team' do
      data = item.push_event_data

      expect(data[:assignee][:id]).to eq(agent.id)
      expect(data[:team][:id]).to eq(team.id)
    end

    it 'returns nil assignee/team when absent' do
      item = create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)

      data = item.push_event_data

      expect(data[:assignee]).to be_nil
      expect(data[:team]).to be_nil
    end
  end

  describe '#webhook_data' do
    let(:agent) { create(:user, account: account, role: :agent) }
    let(:team) { create(:team, account: account) }
    let(:conversation) { create(:conversation, account: account, contact: contact) }
    let(:item) do
      create(:pipeline_member, pipeline: pipeline, user: agent)
      create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact, conversation: conversation,
                             assignee: agent, team: team, title: 'Deal', value: 100, notes: 'follow up')
    end

    it 'returns the expected flat hash' do
      data = item.webhook_data

      expect(data).to eq(
        id: item.id,
        title: 'Deal',
        value: item.value,
        notes: 'follow up',
        pipeline_id: pipeline.id,
        pipeline_name: pipeline.name,
        pipeline_stage_id: stage.id,
        pipeline_stage_name: stage.name,
        assignee_id: agent.id,
        assignee_name: agent.name,
        team_id: team.id,
        team_name: team.name,
        contact_id: contact.id,
        conversation_id: conversation.id,
        created_at: item.created_at,
        updated_at: item.updated_at
      )
    end

    it 'returns nil assignee/team names when absent' do
      item_without_assignee = create(:pipeline_item, pipeline_stage: stage, account: account, contact: contact)

      data = item_without_assignee.webhook_data

      expect(data[:assignee_id]).to be_nil
      expect(data[:assignee_name]).to be_nil
      expect(data[:team_id]).to be_nil
      expect(data[:team_name]).to be_nil
    end
  end
end
