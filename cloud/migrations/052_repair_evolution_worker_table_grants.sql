-- requires-real-postgres: role grants are not implemented by pg-mem.
GRANT USAGE ON SCHEMA public TO janus_evolution_worker;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO janus_evolution_worker;
GRANT DELETE ON cloud_agent_cohort_members,cloud_cluster_evidence_claims TO janus_evolution_worker;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO janus_evolution_worker;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT,INSERT,UPDATE ON TABLES TO janus_evolution_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE,SELECT ON SEQUENCES TO janus_evolution_worker;
