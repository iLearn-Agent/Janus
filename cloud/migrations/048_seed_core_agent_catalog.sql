INSERT INTO cloud_agent_versions_v3(id,agent_family_id,content_hash,payload_json)
VALUES
  ('general_agent_v1','general_agent','','{}'::jsonb),
  ('ppt_v1','ppt','','{}'::jsonb),
  ('secretary_agent_v1','secretary_agent','','{}'::jsonb)
ON CONFLICT(id) DO NOTHING;

INSERT INTO cloud_agent_families_v3(
  id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,
  default_for_new_user,quota_cost,classification_version,payload_json
) VALUES
  ('general_agent','general','General Agent','agent','active',true,'general_agent_v1','employee',true,true,1,
    'employee_recruitment_phase_a_v1','{}'::jsonb),
  ('ppt','ppt_department','PPT Agent','agent','active',true,'ppt_v1','employee',true,false,1,
    'employee_recruitment_phase_a_v1','{}'::jsonb),
  ('secretary_agent','secretary_department','uBuddy','agent','active',true,'secretary_agent_v1','system',false,false,0,
    'employee_recruitment_phase_a_v1','{}'::jsonb)
ON CONFLICT(id) DO NOTHING;
