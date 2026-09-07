ALTER TABLE cloud_evolution_evidence_usage
  ADD COLUMN IF NOT EXISTS rejection_kind text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS transition_reason text NOT NULL DEFAULT '';

UPDATE cloud_evolution_evidence_usage
SET rejection_kind='legacy_unknown'
WHERE status='evaluated_rejected' AND rejection_kind='';

ALTER TABLE cloud_evolution_evidence_usage
  DROP CONSTRAINT IF EXISTS chk_cloud_evidence_rejection_kind,
  DROP CONSTRAINT IF EXISTS chk_cloud_evidence_rejection_state;

ALTER TABLE cloud_evolution_evidence_usage
  ADD CONSTRAINT chk_cloud_evidence_rejection_kind CHECK(
    rejection_kind IN ('','gate','hr_review','regression','privacy','mixed','user_rejected','invalid_source','legacy_unknown')
  ),
  ADD CONSTRAINT chk_cloud_evidence_rejection_state CHECK(
    (status='evaluated_rejected' AND rejection_kind<>'') OR
    (status<>'evaluated_rejected' AND rejection_kind='')
  );
