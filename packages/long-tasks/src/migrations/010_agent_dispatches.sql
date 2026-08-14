CREATE TABLE agent_dispatches (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  actor_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  operation_key TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  action TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'queued', 'running', 'finalizing', 'completed', 'completed_unaccepted',
    'failed', 'cancelled', 'unknown_outcome'
  )),
  context_manifest_json TEXT NOT NULL,
  context_manifest_sha256 TEXT NOT NULL,
  session_id TEXT,
  episode_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  settled_at TEXT,
  UNIQUE(agent_id, sequence),
  UNIQUE(task_id, agent_id, operation_key)
);

CREATE UNIQUE INDEX agent_dispatches_one_active_idx
  ON agent_dispatches(agent_id)
  WHERE state IN ('running', 'finalizing');

CREATE INDEX agent_dispatches_runnable_idx
  ON agent_dispatches(agent_id, state, sequence);

CREATE UNIQUE INDEX agent_dispatches_actor_operation_idx
  ON agent_dispatches(task_id, actor_agent_id, operation_key)
  WHERE actor_agent_id IS NOT NULL;

INSERT INTO agent_dispatches (
  id, task_id, agent_id, operation_key, sequence, action, state,
  context_manifest_json, context_manifest_sha256, session_id,
  created_at, started_at, settled_at
)
SELECT
  agent.id || ':legacy', agent.task_id, agent.id, 'legacy', 1, agent.objective,
  CASE agent.state
    WHEN 'running' THEN 'running'
    WHEN 'recovering' THEN 'running'
    WHEN 'unknown_outcome' THEN 'unknown_outcome'
    WHEN 'completed' THEN 'completed'
    WHEN 'failed' THEN 'failed'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE 'queued'
  END,
  json_object(
    'action', agent.objective,
    'sourceAgentIds', json('[]'),
    'sourceEpisodes', json('[]'),
    'createdAt', agent.created_at
  ),
  '', agent.active_session_id, agent.created_at,
  CASE WHEN agent.state IN ('running', 'recovering', 'unknown_outcome', 'completed', 'failed', 'cancelled')
    THEN agent.updated_at ELSE NULL END,
  CASE WHEN agent.state IN ('unknown_outcome', 'completed', 'failed', 'cancelled')
    THEN agent.updated_at ELSE NULL END
FROM agents agent;

WITH duplicate_names AS (
  SELECT id, name,
         ROW_NUMBER() OVER (PARTITION BY task_id, name ORDER BY created_at, id) AS duplicate_rank
  FROM agents
)
UPDATE agents
SET name = name || '-legacy-' || id
WHERE id IN (SELECT id FROM duplicate_names WHERE duplicate_rank > 1);

CREATE UNIQUE INDEX agents_task_name_idx ON agents(task_id, name);

ALTER TABLE attempts ADD COLUMN dispatch_id TEXT REFERENCES agent_dispatches(id);
UPDATE attempts
SET dispatch_id = agent_id || ':legacy'
WHERE dispatch_id IS NULL;
CREATE INDEX attempts_dispatch_ordinal_idx ON attempts(dispatch_id, ordinal);

ALTER TABLE checkpoints ADD COLUMN dispatch_id TEXT REFERENCES agent_dispatches(id);
UPDATE checkpoints
SET dispatch_id = agent_id || ':legacy'
WHERE dispatch_id IS NULL;
CREATE INDEX checkpoints_dispatch_event_idx ON checkpoints(dispatch_id, event_seq);

ALTER TABLE task_events ADD COLUMN dispatch_id TEXT REFERENCES agent_dispatches(id);
UPDATE task_events
SET dispatch_id = agent_id || ':legacy'
WHERE agent_id IS NOT NULL;
CREATE INDEX task_events_dispatch_seq_idx ON task_events(dispatch_id, seq);

ALTER TABLE agent_messages ADD COLUMN delivery_claimed_at TEXT;

CREATE TABLE agent_message_receipts (
  message_id TEXT PRIMARY KEY REFERENCES agent_messages(id) ON DELETE CASCADE,
  recipient_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  model_visible_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE INDEX agent_message_receipts_recipient_unsettled_idx
  ON agent_message_receipts(recipient_agent_id, settled_at);

ALTER TABLE coordination_results RENAME TO coordination_results_legacy;

CREATE TABLE coordination_results (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, actor_agent_id, operation_key)
);

INSERT INTO coordination_results (
  task_id, actor_agent_id, operation_key, payload_sha256, result_json, created_at
)
SELECT task_id, actor_agent_id, operation_key, '', result_json, created_at
FROM coordination_results_legacy;

DROP TABLE coordination_results_legacy;

ALTER TABLE flow_nodes ADD COLUMN required INTEGER NOT NULL DEFAULT 1;
ALTER TABLE flow_nodes ADD COLUMN dispatch_id TEXT REFERENCES agent_dispatches(id);
ALTER TABLE flows ADD COLUMN operation_key TEXT;
ALTER TABLE flows ADD COLUMN definition_sha256 TEXT;
UPDATE flows SET operation_key = 'legacy:' || id, definition_sha256 = '';
CREATE UNIQUE INDEX flows_actor_operation_idx
  ON flows(task_id, orchestrator_agent_id, operation_key);
UPDATE flow_nodes
SET required = COALESCE((
  SELECT delegation.required FROM delegations delegation
  WHERE delegation.id = flow_nodes.delegation_id
), 1);
UPDATE flow_nodes
SET dispatch_id = (
  SELECT dispatch.id FROM agent_dispatches dispatch
  WHERE dispatch.agent_id = flow_nodes.agent_id
  ORDER BY dispatch.sequence LIMIT 1
);

ALTER TABLE episodes RENAME TO episodes_legacy;

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL REFERENCES agent_dispatches(id) ON DELETE CASCADE,
  flow_id TEXT REFERENCES flows(id) ON DELETE CASCADE,
  node_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('progress', 'completed', 'completed_unaccepted', 'failed', 'skipped')),
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  blockers_json TEXT NOT NULL,
  acceptance_results_json TEXT NOT NULL,
  original_response_artifact_ref TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(flow_id, node_key) REFERENCES flow_nodes(flow_id, node_key) ON DELETE CASCADE
);

INSERT INTO episodes (
  id, task_id, agent_id, dispatch_id, flow_id, node_key, status, summary,
  evidence_json, blockers_json, acceptance_results_json, created_at
)
SELECT
  id, task_id, agent_id, agent_id || ':legacy', flow_id, node_key, status, summary,
  evidence_json, blockers_json, acceptance_results_json, created_at
FROM episodes_legacy;

DROP TABLE episodes_legacy;

CREATE INDEX episodes_agent_created_idx ON episodes(agent_id, created_at);
CREATE INDEX episodes_flow_created_idx ON episodes(flow_id, created_at);
CREATE INDEX episodes_dispatch_created_idx ON episodes(dispatch_id, created_at);
