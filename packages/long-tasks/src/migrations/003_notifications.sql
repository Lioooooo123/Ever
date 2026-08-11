CREATE TABLE task_notifications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  source_event_seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('completed', 'failed', 'waiting_input')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'sent')),
  created_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT,
  UNIQUE(task_id, source_event_seq)
);

CREATE INDEX idx_task_notifications_state_created
  ON task_notifications(state, created_at);
