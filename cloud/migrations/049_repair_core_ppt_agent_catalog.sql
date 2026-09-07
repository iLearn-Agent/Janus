INSERT INTO cloud_agent_versions_v3(id,agent_family_id,content_hash,payload_json)
VALUES ('ppt_v1','ppt','','{}'::jsonb)
ON CONFLICT(id) DO UPDATE SET agent_family_id=excluded.agent_family_id;

INSERT INTO cloud_agent_families_v3(
  id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,
  default_for_new_user,quota_cost,classification_version,payload_json
) VALUES (
  'ppt','ppt_department','PPT Agent','agent','active',true,'ppt_v1','employee',true,false,1,
  'employee_recruitment_phase_a_v1','{}'::jsonb
)
ON CONFLICT(id) DO UPDATE SET
  department_id=excluded.department_id,
  name=excluded.name,
  role=excluded.role,
  status=excluded.status,
  routable=excluded.routable,
  current_version_id=CASE
    WHEN cloud_agent_families_v3.current_version_id='' THEN excluded.current_version_id
    ELSE cloud_agent_families_v3.current_version_id
  END,
  instance_kind=excluded.instance_kind,
  recruitable=excluded.recruitable,
  default_for_new_user=excluded.default_for_new_user,
  quota_cost=excluded.quota_cost,
  classification_version=excluded.classification_version;

UPDATE cloud_user_agent_instances_v3
SET instance_kind='employee',
    quota_exempt=false,
    updated_at=now()
WHERE agent_family_id='ppt'
  AND (instance_kind!='employee' OR quota_exempt=true);
