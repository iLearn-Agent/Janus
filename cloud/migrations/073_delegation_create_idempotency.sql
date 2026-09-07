ALTER TABLE agent_delegations
  ADD COLUMN IF NOT EXISTS client_request_id text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegations_client_request
  ON agent_delegations(account_workspace_id,requester_user_id,client_request_id)
  WHERE client_request_id <> '';
