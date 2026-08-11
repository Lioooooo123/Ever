CREATE TABLE daemon_commands (
  client_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('received', 'dispatched', 'completed', 'uncertain', 'acknowledged')),
  result_json TEXT,
  error TEXT,
  received_at TEXT NOT NULL,
  dispatched_at TEXT,
  completed_at TEXT,
  acknowledged_at TEXT,
  PRIMARY KEY(client_id, command_id)
);

CREATE INDEX idx_daemon_commands_state_received
  ON daemon_commands(state, received_at);

CREATE TABLE continuation_decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  settled_turn_index INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('continue', 'replan', 'wait_user', 'wait_external', 'pause_budget', 'pause_no_progress', 'complete', 'fail')),
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  progress_fingerprint TEXT NOT NULL,
  next_prompt TEXT,
  next_wake_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, attempt_id, settled_turn_index)
);

CREATE INDEX idx_continuation_decisions_agent_created
  ON continuation_decisions(agent_id, created_at);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT REFERENCES agents(id),
  kind TEXT NOT NULL CHECK(kind IN ('once', 'interval', 'cron', 'event')),
  expression TEXT NOT NULL,
  timezone TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active', 'paused', 'completed', 'cancelled')),
  next_run_at TEXT,
  last_claim_id TEXT,
  last_claimed_at TEXT,
  last_delivered_at TEXT,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_schedules_due
  ON schedules(state, next_run_at);

CREATE INDEX idx_schedules_event
  ON schedules(task_id, kind, state, last_event_seq);

INSERT INTO schedules (
  id, task_id, kind, expression, timezone, payload_json, state, next_run_at, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))),
  id,
  'once',
  next_wake_at,
  'UTC',
  '{"legacyNextWakeAt":true}',
  'active',
  next_wake_at,
  updated_at,
  updated_at
FROM tasks
WHERE next_wake_at IS NOT NULL
  AND state NOT IN ('completed', 'failed', 'cancelled');
