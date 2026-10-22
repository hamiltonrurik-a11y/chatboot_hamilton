json.id resource.id
json.title resource.title
json.value resource.value
json.notes resource.notes
json.position resource.position
json.pipeline_stage_id resource.pipeline_stage_id
json.pipeline_lost_reason_id resource.pipeline_lost_reason_id
json.pipeline_id resource.pipeline_stage.pipeline_id
json.pipeline_name resource.pipeline_stage.pipeline.name
json.pipeline_stage_name resource.pipeline_stage.name
json.conversation_id resource.conversation_id
json.created_at resource.created_at.to_i
json.updated_at resource.updated_at.to_i
json.updated_at_usec (resource.updated_at.to_r * 1_000_000).to_i
json.contact do
  json.id resource.contact.id
  json.name resource.contact.name
  json.email resource.contact.email
  json.phone_number resource.contact.phone_number
  json.avatar_url resource.contact.avatar_url
end
if resource.assignee
  json.assignee resource.assignee, partial: 'api/v1/models/agent', as: :resource
else
  json.assignee nil
end
if resource.team
  json.team resource.team, partial: 'api/v1/models/team', as: :resource
else
  json.team nil
end
if resource.pipeline_lost_reason
  json.pipeline_lost_reason resource.pipeline_lost_reason, partial: 'api/v1/models/pipeline_lost_reason', as: :resource
else
  json.pipeline_lost_reason nil
end
json.label_list resource.preloaded_label_list
json.custom_attributes resource.custom_attributes
json.overdue_tasks_count local_assigns[:overdue_tasks_counts]&.fetch(resource.id, 0) || 0
