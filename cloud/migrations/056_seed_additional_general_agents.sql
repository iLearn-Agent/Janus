INSERT INTO cloud_agent_versions_v3(id,agent_family_id,content_hash,payload_json)
VALUES
  ('general_agent_1_v1','general_agent_1','','{}'::jsonb),
  ('general_agent_2_v1','general_agent_2','','{}'::jsonb),
  ('general_agent_3_v1','general_agent_3','','{}'::jsonb)
ON CONFLICT(id) DO UPDATE SET agent_family_id=excluded.agent_family_id;

INSERT INTO cloud_agent_families_v3(
  id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,
  default_for_new_user,quota_cost,classification_version,payload_json
) VALUES
  ('general_agent_1','general','通用 Agent 1','agent','active',true,'general_agent_1_v1','employee',true,false,1,
    'employee_recruitment_phase_a_v1',
    '{"metadata":{"summary":"可从人才市场招募的通用执行 Agent，独立处理问答、分析、写作、代码和文件任务。","description":"可从人才市场招募的通用执行 Agent，独立处理问答、分析、写作、代码和文件任务。","capabilityTags":["通用问答与分析","文件和代码任务处理","跨领域问题求解"]}}'::jsonb),
  ('general_agent_2','general','通用 Agent 2','agent','active',true,'general_agent_2_v1','employee',true,false,1,
    'employee_recruitment_phase_a_v1',
    '{"metadata":{"summary":"可从人才市场招募的通用执行 Agent，独立处理问答、分析、写作、代码和文件任务。","description":"可从人才市场招募的通用执行 Agent，独立处理问答、分析、写作、代码和文件任务。","capabilityTags":["通用问答与分析","文件和代码任务处理","跨领域问题求解"]}}'::jsonb),
  ('general_agent_3','general','通用 Agent 3','agent','active',true,'general_agent_3_v1','employee',true,false,1,
    'employee_recruitment_phase_a_v1',
    '{"metadata":{"summary":"可从人才市场招募的通用执行 Agent，独立处理问答、分析、写作、代码和文件任务。","description":"可从人才市场招募的通用执行 Agent，独立处理问答、分析、写作、代码和文件任务。","capabilityTags":["通用问答与分析","文件和代码任务处理","跨领域问题求解"]}}'::jsonb)
ON CONFLICT(id) DO UPDATE SET
  department_id=excluded.department_id,
  name=excluded.name,
  role=excluded.role,
  status=excluded.status,
  routable=excluded.routable,
  current_version_id=excluded.current_version_id,
  instance_kind=excluded.instance_kind,
  recruitable=excluded.recruitable,
  default_for_new_user=excluded.default_for_new_user,
  quota_cost=excluded.quota_cost,
  classification_version=excluded.classification_version,
  payload_json=excluded.payload_json;
