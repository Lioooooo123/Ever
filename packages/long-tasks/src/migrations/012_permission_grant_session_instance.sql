-- Bind Session-scoped permission grants to the process instance (epoch).
-- Existing grants cannot be attributed to a process instance and therefore
-- intentionally remain non-matchable by the Session grant query.

ALTER TABLE permission_grants ADD COLUMN session_instance_id TEXT;

CREATE INDEX idx_permission_grants_session_instance
  ON permission_grants(session_id, session_instance_id, state, workspace_fingerprint);
