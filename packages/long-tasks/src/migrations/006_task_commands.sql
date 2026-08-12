CREATE TABLE task_commands (
  client_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  command_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('dispatched', 'completed')),
  result_json TEXT,
  dispatched_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(client_id, command_id)
);

CREATE INDEX idx_task_commands_task_dispatched
  ON task_commands(task_id, dispatched_at);
