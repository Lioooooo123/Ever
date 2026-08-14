ALTER TABLE agent_messages
  ADD COLUMN provenance TEXT NOT NULL DEFAULT 'agent' CHECK(provenance IN ('agent', 'user'));

ALTER TABLE budget_reservations
  ADD COLUMN request_kind TEXT;

CREATE TABLE task_authorization_state (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  revision INTEGER NOT NULL DEFAULT 0,
  compiler_request_count INTEGER NOT NULL DEFAULT 0,
  reviewer_request_count INTEGER NOT NULL DEFAULT 0,
  reviewer_cost_usd REAL NOT NULL DEFAULT 0,
  compiler_cost_usd REAL NOT NULL DEFAULT 0,
  judge_cost_usd REAL NOT NULL DEFAULT 0,
  reviewer_reserved_usd REAL NOT NULL DEFAULT 0,
  startup_allowance_used INTEGER NOT NULL DEFAULT 0 CHECK(startup_allowance_used IN (0, 1))
);

INSERT INTO task_authorization_state(task_id)
  SELECT id FROM tasks;

CREATE TABLE task_authorization_sources (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('goal', 'steering')),
  source_message_sha256 TEXT NOT NULL,
  source_text TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'compiled', 'failed')),
  created_at TEXT NOT NULL,
  compiled_at TEXT,
  error_code TEXT,
  UNIQUE(task_id, id)
);

CREATE INDEX idx_task_authorization_sources_pending
  ON task_authorization_sources(task_id, state, created_at);

CREATE TABLE task_authorizations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  source_message_id TEXT NOT NULL REFERENCES task_authorization_sources(id),
  source_message_sha256 TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN (
    'git_push', 'pr_create', 'pr_merge', 'package_publish', 'release_publish',
    'deploy', 'external_message', 'credential_configure', 'network_expand', 'delete'
  )),
  targets_json TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  lifetime TEXT NOT NULL CHECK(lifetime = 'task'),
  max_uses INTEGER NOT NULL CHECK(max_uses BETWEEN 1 AND 10),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count >= 0 AND used_count <= max_uses),
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0.95 AND 1),
  compiler_provider TEXT NOT NULL,
  compiler_model TEXT NOT NULL,
  compiler_prompt_sha256 TEXT NOT NULL,
  evidence_spans_json TEXT NOT NULL,
  git_head TEXT,
  change_set_sha256 TEXT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  state TEXT NOT NULL CHECK(state IN ('active', 'consumed', 'revoked')),
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT
);

CREATE INDEX idx_task_authorizations_match
  ON task_authorizations(task_id, state, action, revision, created_at);

ALTER TABLE permission_decisions RENAME TO permission_decisions_v7;
DROP INDEX idx_permission_decisions_operation;

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
SELECT id, operation_id, task_id, attempt_id, intent_sha256, action, source, grant_id,
       NULL, reason_code, created_at
FROM permission_decisions_v7;

DROP TABLE permission_decisions_v7;

CREATE INDEX idx_permission_decisions_operation
  ON permission_decisions(task_id, operation_id, created_at);
