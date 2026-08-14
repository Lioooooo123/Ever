CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  orchestrator_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX flows_active_task_idx
  ON flows(task_id)
  WHERE state = 'running';

CREATE TABLE flow_nodes (
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  delegation_id TEXT NOT NULL UNIQUE REFERENCES delegations(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('blocked', 'queued', 'running', 'completed', 'failed', 'skipped', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(flow_id, node_key)
);

CREATE INDEX flow_nodes_flow_state_idx ON flow_nodes(flow_id, state);

CREATE TABLE flow_edges (
  flow_id TEXT NOT NULL,
  source_node_key TEXT NOT NULL,
  target_node_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(flow_id, source_node_key, target_node_key),
  FOREIGN KEY(flow_id, source_node_key) REFERENCES flow_nodes(flow_id, node_key) ON DELETE CASCADE,
  FOREIGN KEY(flow_id, target_node_key) REFERENCES flow_nodes(flow_id, node_key) ON DELETE CASCADE,
  CHECK(source_node_key <> target_node_key)
);

CREATE INDEX flow_edges_target_idx ON flow_edges(flow_id, target_node_key);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  flow_id TEXT REFERENCES flows(id) ON DELETE CASCADE,
  node_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('progress', 'completed', 'failed', 'skipped')),
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  blockers_json TEXT NOT NULL,
  acceptance_results_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(flow_id, node_key) REFERENCES flow_nodes(flow_id, node_key) ON DELETE CASCADE
);

CREATE INDEX episodes_agent_created_idx ON episodes(agent_id, created_at);
CREATE INDEX episodes_flow_created_idx ON episodes(flow_id, created_at);
