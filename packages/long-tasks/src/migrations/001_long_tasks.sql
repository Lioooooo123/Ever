CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  acceptance_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  state TEXT NOT NULL,
  state_reason TEXT,
  workspace_root TEXT NOT NULL,
  workspace_fingerprint TEXT NOT NULL,
  initial_git_head TEXT,
  total_turns INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  next_wake_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  parent_agent_id TEXT REFERENCES agents(id),
  kind TEXT NOT NULL CHECK(kind IN ('main', 'subagent')),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  objective TEXT NOT NULL,
  state TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK(depth IN (0, 1)),
  active_session_id TEXT,
  workspace_mode TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  tool_policy_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (kind = 'main' AND parent_agent_id IS NULL AND depth = 0)
    OR (kind = 'subagent' AND parent_agent_id IS NOT NULL AND depth = 1)
  )
);

CREATE UNIQUE INDEX idx_agents_one_main ON agents(task_id) WHERE kind = 'main';

CREATE TRIGGER trg_agents_validate_subagent
BEFORE INSERT ON agents
WHEN NEW.kind = 'subagent'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM agents parent
    WHERE parent.id = NEW.parent_agent_id
      AND parent.task_id = NEW.task_id
      AND parent.kind = 'main'
  ) THEN RAISE(ABORT, 'subagent parent must be the task main agent') END;
END;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  session_id TEXT,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL,
  runtime_snapshot_json TEXT NOT NULL,
  runtime_snapshot_sha256 TEXT NOT NULL,
  pricing_snapshot_json TEXT,
  started_at TEXT NOT NULL,
  settled_at TEXT,
  turn_count INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error_code TEXT,
  UNIQUE(agent_id, ordinal)
);

CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT REFERENCES agents(id),
  attempt_id TEXT REFERENCES attempts(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, seq)
);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  event_seq INTEGER NOT NULL,
  session_checkpoint_json TEXT NOT NULL,
  progress_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  workspace_snapshot_json TEXT NOT NULL,
  runtime_snapshot_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE leases (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  worker_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  pid INTEGER,
  sandbox_id TEXT,
  fencing_token INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE budget_reservations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  provider_request_id TEXT NOT NULL,
  reserved_turns INTEGER NOT NULL,
  reserved_cost_usd REAL,
  pricing_snapshot_json TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE(task_id, provider_request_id)
);

CREATE TABLE wake_conditions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT REFERENCES agents(id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  satisfied_at TEXT
);

CREATE INDEX idx_tasks_runnable ON tasks(state, next_wake_at, updated_at);
CREATE INDEX idx_events_task_seq ON task_events(task_id, seq);
CREATE INDEX idx_agents_task_state ON agents(task_id, state, updated_at);
CREATE INDEX idx_budget_reservations_task_state ON budget_reservations(task_id, state);
CREATE INDEX idx_wakes_task_state ON wake_conditions(task_id, state);
