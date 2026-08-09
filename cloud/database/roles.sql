DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='janus_api') THEN CREATE ROLE janus_api NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='janus_evolution_worker') THEN CREATE ROLE janus_evolution_worker NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='janus_migrator') THEN CREATE ROLE janus_migrator NOLOGIN; END IF;
END $$;

-- Create deployment-specific LOGIN roles and passwords outside this file, then:
-- GRANT janus_api TO <api_login>;
-- GRANT janus_evolution_worker TO <worker_login>;
-- GRANT janus_migrator TO <migrator_login>;
