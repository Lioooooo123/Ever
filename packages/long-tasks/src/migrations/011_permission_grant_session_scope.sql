-- Make permission grants attachable to Sessions without a Task:
-- - task_id becomes nullable (workspace/project_policy grants no longer require a Task)
-- - session_id is added for Session-scoped grants
-- - 'session' is added as a grant lifetime
--
-- SQLite cannot alter column nullability, so recreate permission_grants and the
-- permission_decisions table that references it.

ALTER TABLE permission_grants RENAME TO permission_grants_v11;

CREATE TABLE permission_grants (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('user', 'policy', 'reviewer_once')),
  lifetime TEXT NOT NULL CHECK(lifetime IN ('once', 'attempt', 'task', 'session', 'workspace', 'project_policy')),
  scope_json TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  session_id TEXT,
  attempt_id TEXT REFERENCES attempts(id),
  workspace_fingerprint TEXT NOT NULL,
  sandbox_profile_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active', 'consumed', 'revoked', 'expired')),
  remaining_uses INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

INSERT INTO permission_grants (
  id, source, lifetime, scope_json, task_id, session_id, attempt_id, workspace_fingerprint,
  sandbox_profile_sha256, state, remaining_uses, created_at, expires_at, revoked_at
)
SELECT
  id, source, lifetime, scope_json, task_id, NULL, attempt_id, workspace_fingerprint,
  sandbox_profile_sha256, state, remaining_uses, created_at, expires_at, revoked_at
FROM permission_grants_v11;

ALTER TABLE permission_decisions RENAME TO permission_decisions_v11;

CREATE TABLE permission_decisions (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  intent_sha256 TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('allow', 'ask', 'deny')),
  source TEXT NOT NULL CHECK(source IN ('policy', 'grant', 'reviewer', 'user', 'user_authorization')),
  grant_id TEXT REFERENCES permission_grants(id),
  authorization_id TEXT REFERENCES task_authorizations(id),
  reason_code TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO permission_decisions (
  id, operation_id, task_id, attempt_id, intent_sha256, action, source, grant_id,
  authorization_id, reason_code, created_at
)
SELECT
  id, operation_id, task_id, attempt_id, intent_sha256, action, source, grant_id,
  authorization_id, reason_code, created_at
FROM permission_decisions_v11;

DROP TABLE permission_decisions_v11;
DROP TABLE permission_grants_v11;

CREATE INDEX idx_permission_grants_match
  ON permission_grants(state, workspace_fingerprint, task_id, attempt_id, sandbox_profile_sha256);

CREATE INDEX idx_permission_grants_session
  ON permission_grants(session_id, state, workspace_fingerprint);

CREATE INDEX idx_permission_decisions_operation
  ON permission_decisions(task_id, operation_id, created_at);
