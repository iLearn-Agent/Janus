-- Keep newly created private Memory documents compatible with the v21 visibility constraint.
UPDATE cloud_memory_documents_v3
SET visibility='agent_private'
WHERE visibility='private';

ALTER TABLE cloud_memory_documents_v3
  ALTER COLUMN visibility SET DEFAULT 'agent_private';
