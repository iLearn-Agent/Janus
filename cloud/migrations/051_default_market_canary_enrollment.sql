ALTER TABLE cloud_market_canary_opt_ins
  ALTER COLUMN policy_version SET DEFAULT 'market_canary_real_user_default_on_v2';
ALTER TABLE cloud_market_canary_assignments
  ALTER COLUMN policy_version SET DEFAULT 'market_canary_real_user_default_on_v2';
ALTER TABLE cloud_market_canary_evaluations
  ALTER COLUMN policy_version SET DEFAULT 'market_canary_real_user_default_on_v2';

UPDATE cloud_market_canary_opt_ins SET
  policy_version='market_canary_real_user_default_on_v2',
  payload_json=CASE WHEN status='withdrawn'
    THEN payload_json || '{"enrollment":"explicit_opt_out","explicitOptOut":true}'::jsonb
    ELSE payload_json || '{"enrollment":"default","explicitOptOut":false}'::jsonb END,
  updated_at=now();

INSERT INTO cloud_market_canary_opt_ins (
  user_id,user_agent_instance_id,agent_family_id,policy_version,status,command_id,payload_json,created_at,updated_at)
SELECT i.user_id,i.id,i.agent_family_id,'market_canary_real_user_default_on_v2','active','',
  '{"enrollment":"default","explicitOptOut":false}'::jsonb,now(),now()
FROM cloud_user_agent_instances_v3 i
LEFT JOIN cloud_user_evolution_preferences p ON p.user_id=i.user_id
WHERE i.status='active' AND i.sync_enabled=true AND i.cluster_contribution_consent=true
  AND COALESCE(p.enabled,true)=true
ON CONFLICT(user_id,user_agent_instance_id) DO NOTHING;
