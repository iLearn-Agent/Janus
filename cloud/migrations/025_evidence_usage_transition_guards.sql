-- requires-real-postgres: PL/pgSQL transition guards require a real PostgreSQL runtime.
ALTER TABLE cloud_evolution_evidence_usage
  DROP CONSTRAINT IF EXISTS chk_cloud_evidence_scope,
  DROP CONSTRAINT IF EXISTS chk_cloud_evidence_usage_status;

ALTER TABLE cloud_evolution_evidence_usage
  ADD CONSTRAINT chk_cloud_evidence_scope CHECK(evolution_scope IN ('personal','cluster')),
  ADD CONSTRAINT chk_cloud_evidence_usage_status CHECK(status IN ('available','reserved','consumed','evaluated_rejected','released'));

ALTER TABLE cloud_agent_cohorts
  DROP CONSTRAINT IF EXISTS chk_cloud_cohort_identity,
  ADD CONSTRAINT chk_cloud_cohort_identity CHECK(cohort_key<>'' AND identity_version<>'');

CREATE OR REPLACE FUNCTION janus_guard_evolution_evidence_usage_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.rejection_kind NOT IN ('','gate','hr_review','regression','privacy','mixed','user_rejected','invalid_source','legacy_unknown') THEN
    RAISE EXCEPTION 'invalid evidence rejection contract';
  END IF;
  IF NEW.status='evaluated_rejected' AND NEW.rejection_kind='' THEN
    RAISE EXCEPTION 'invalid evidence rejection contract';
  END IF;
  IF NEW.status<>'evaluated_rejected' AND NEW.rejection_kind<>'' THEN
    RAISE EXCEPTION 'invalid evidence rejection contract';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.evidence_id<>OLD.evidence_id OR NEW.evolution_scope<>OLD.evolution_scope OR NEW.consumer_id<>OLD.consumer_id THEN
      RAISE EXCEPTION 'invalid evidence usage transition';
    END IF;
    IF NEW.status<>OLD.status AND NOT (
      (OLD.status IN ('available','released') AND NEW.status='reserved') OR
      (OLD.status='reserved' AND NEW.status IN ('consumed','evaluated_rejected','released')) OR
      (OLD.status='evaluated_rejected' AND NEW.status='reserved'
        AND NEW.run_id<>'' AND NEW.run_id<>OLD.run_id
        AND NEW.re_evaluation_basis_hash<>''
        AND NEW.re_evaluation_basis_hash<>OLD.re_evaluation_basis_hash)
    ) THEN
      RAISE EXCEPTION 'invalid evidence usage transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cloud_evidence_usage_transition ON cloud_evolution_evidence_usage;
CREATE TRIGGER trg_cloud_evidence_usage_transition
BEFORE INSERT OR UPDATE ON cloud_evolution_evidence_usage
FOR EACH ROW EXECUTE FUNCTION janus_guard_evolution_evidence_usage_transition();

CREATE OR REPLACE FUNCTION janus_guard_cluster_evidence_claim_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.claim_state NOT IN ('reserved','consumed') OR NEW.consumer_id='' OR NEW.run_id='' THEN
    RAISE EXCEPTION 'invalid cluster evidence claim';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.evidence_id<>OLD.evidence_id OR
      (OLD.claim_state='consumed' AND (
        NEW.claim_state<>OLD.claim_state OR NEW.consumer_id<>OLD.consumer_id OR NEW.run_id<>OLD.run_id
      )) OR
      (OLD.claim_state='reserved' AND NEW.claim_state='reserved' AND (
        NEW.consumer_id<>OLD.consumer_id OR NEW.run_id<>OLD.run_id
      ))
    THEN
      RAISE EXCEPTION 'invalid cluster evidence claim transition';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cloud_cluster_claim_transition ON cloud_cluster_evidence_claims;
CREATE TRIGGER trg_cloud_cluster_claim_transition
BEFORE INSERT OR UPDATE ON cloud_cluster_evidence_claims
FOR EACH ROW EXECUTE FUNCTION janus_guard_cluster_evidence_claim_transition();
