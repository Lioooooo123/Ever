CREATE TABLE verified_completion_requests (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  request_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running', 'completed')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(task_id, request_id)
);

CREATE TABLE acceptance_command_executions (
  task_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  criterion_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started', 'finished')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY(task_id, request_id, criterion_id),
  FOREIGN KEY(task_id, request_id)
    REFERENCES verified_completion_requests(task_id, request_id)
);

CREATE INDEX idx_events_task_type_seq
  ON task_events(task_id, type, seq DESC);

CREATE INDEX idx_events_acceptance_criterion_seq
  ON task_events(task_id, json_extract(payload_json, '$.criterionId'), seq DESC)
  WHERE type IN ('AcceptancePassed', 'AcceptanceFailed');
