CREATE TABLE IF NOT EXISTS cloud_market_candidate_section_supports (
  candidate_id text NOT NULL REFERENCES cloud_market_agent_candidates(id) ON DELETE CASCADE,
  agent_family_id text NOT NULL,
  section_id text NOT NULL,
  evidence_id text NOT NULL REFERENCES cloud_evolution_evidence(evidence_id),
  user_agent_instance_id text NOT NULL,
  contributor_id text NOT NULL,
  evidence_handle text NOT NULL,
  support_confidence numeric NOT NULL,
  deterministic_pass boolean NOT NULL DEFAULT false,
  reviewer_pass boolean NOT NULL DEFAULT false,
  review_stage text NOT NULL DEFAULT 'initial_gate',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(candidate_id,agent_family_id,section_id,evidence_id),
  CONSTRAINT chk_cloud_market_support_confidence CHECK(support_confidence>=0 AND support_confidence<=1)
);

CREATE INDEX IF NOT EXISTS idx_cloud_market_candidate_support_section
  ON cloud_market_candidate_section_supports(candidate_id,agent_family_id,section_id,contributor_id);

CREATE TABLE IF NOT EXISTS cloud_market_candidate_privacy_reviews (
  id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES cloud_market_agent_candidates(id) ON DELETE CASCADE,
  agent_family_id text NOT NULL DEFAULT '',
  review_stage text NOT NULL,
  deterministic_status text NOT NULL,
  reviewer_status text NOT NULL,
  finding_codes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(candidate_id,agent_family_id,review_stage)
);

CREATE INDEX IF NOT EXISTS idx_cloud_market_candidate_privacy_review
  ON cloud_market_candidate_privacy_reviews(candidate_id,review_stage,agent_family_id);

-- The stage-3 role migration grants defaults for later tables, but explicit
-- grants keep upgrades correct when default privileges were configured later.
-- requires-real-postgres-tail: role grants are not supported by pg-mem.
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_market_candidate_section_supports,cloud_market_candidate_privacy_reviews TO janus_api;
GRANT SELECT,INSERT,UPDATE ON cloud_market_candidate_section_supports,cloud_market_candidate_privacy_reviews TO janus_evolution_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud_market_candidate_section_supports,cloud_market_candidate_privacy_reviews TO janus_migrator;
