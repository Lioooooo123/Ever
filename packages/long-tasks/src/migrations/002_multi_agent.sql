CREATE TABLE delegations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  parent_agent_id TEXT NOT NULL REFERENCES agents(id),
  child_agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id),
  operation_key TEXT NOT NULL,
  objective TEXT NOT NULL,
  acceptance_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  workspace_snapshot_json TEXT,
  workspace_snapshot_sha256 TEXT,
  required INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(task_id, parent_agent_id, operation_key)
);

CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  sender_agent_id TEXT NOT NULL REFERENCES agents(id),
  recipient_agent_id TEXT NOT NULL REFERENCES agents(id),
  sender_seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  priority TEXT NOT NULL,
  body_json TEXT NOT NULL,
  reply_to_message_id TEXT REFERENCES agent_messages(id),
  dedupe_key TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT,
  UNIQUE(task_id, sender_agent_id, recipient_agent_id, sender_seq),
  UNIQUE(task_id, sender_agent_id, dedupe_key)
);

CREATE TABLE coordination_results (
  operation_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_messages_recipient_state
  ON agent_messages(recipient_agent_id, state, sender_agent_id, sender_seq);
