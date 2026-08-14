CREATE TABLE permission_grants (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(source IN ('user', 'policy', 'reviewer_once')),
  lifetime TEXT NOT NULL CHECK(lifetime IN ('once', 'attempt', 'task', 'workspace', 'project_policy')),
  scope_json TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  workspace_fingerprint TEXT NOT NULL,
  sandbox_profile_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active', 'consumed', 'revoked', 'expired')),
  remaining_uses INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE INDEX idx_permission_grants_match
  ON permission_grants(state, workspace_fingerprint, task_id, attempt_id, sandbox_profile_sha256);

CREATE TABLE permission_decisions (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  intent_sha256 TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('allow', 'ask', 'deny')),
  source TEXT NOT NULL CHECK(source IN ('policy', 'grant', 'reviewer', 'user')),
  grant_id TEXT REFERENCES permission_grants(id),
  reason_code TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_permission_decisions_operation
  ON permission_decisions(task_id, operation_id, created_at);

CREATE TABLE risk_reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_id TEXT REFERENCES attempts(id),
  intent_sha256 TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  output_sha256 TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('allow_once', 'ask', 'deny')),
  risk TEXT NOT NULL CHECK(risk IN ('low', 'medium', 'high')),
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_risk_reviews_intent
  ON risk_reviews(task_id, attempt_id, intent_sha256, created_at);
