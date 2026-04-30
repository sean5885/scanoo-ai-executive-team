import crypto from "node:crypto";

import db from "./db.mjs";
import { getRegisteredAgent } from "./agent-registry.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import {
  DEFAULT_AUTONOMY_LEASE_MS,
  normalizePositiveInteger,
} from "./task-runtime/autonomy-job-types.mjs";
import { nowIso } from "./text-utils.mjs";

export const EXECUTIVE_WORK_GRAPH_SCHEMA_VERSION = "executive_work_graph_v1";
export const EXECUTIVE_WORK_GRAPH_JOB_TYPE = "executive_work_graph_v1";

export const EXECUTIVE_WORK_NODE_STATE = Object.freeze({
  queued: "queued",
  claimed: "claimed",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  blocked: "blocked",
  deadletter: "deadletter",
});

export const EXECUTIVE_WORK_EDGE_DEPENDENCY = Object.freeze({
  hard: "hard",
  soft: "soft",
});

export const EXECUTIVE_ARTIFACT_TYPE = Object.freeze({
  structured_output: "structured_output",
  tool_output: "tool_output",
  file_updated: "file_updated",
});

const EDGE_DEPENDENCY_SET = new Set(Object.values(EXECUTIVE_WORK_EDGE_DEPENDENCY));
const NODE_STATE_SET = new Set(Object.values(EXECUTIVE_WORK_NODE_STATE));
const ARTIFACT_TYPE_SET = new Set(Object.values(EXECUTIVE_ARTIFACT_TYPE));

let tablesReady = false;

function normalizeJsonObject(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function parseJson(value) {
  const normalized = cleanText(value);
  if (!normalized) {
    return null;
  }
  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function stringifyJson(value) {
  if (value == null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({
      error: "json_serialize_failed",
    });
  }
}

function createPayloadHash(payload = null) {
  const serialized = stringifyJson(payload) || "{}";
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function parseIsoToMs(value = "") {
  const parsed = Date.parse(cleanText(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function addMsToNowIso(ms = DEFAULT_AUTONOMY_LEASE_MS) {
  return new Date(Date.now() + normalizePositiveInteger(ms, DEFAULT_AUTONOMY_LEASE_MS)).toISOString();
}

function normalizeRequiredFields(value = []) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => cleanText(item))
      .filter(Boolean),
  ));
}

function normalizeAllowedTools(value = []) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => cleanText(item))
      .filter(Boolean),
  ));
}

function normalizeOutputSchema(schema = null) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {};
  }
  const result = {};
  for (const [key, type] of Object.entries(schema)) {
    const normalizedKey = cleanText(key);
    const normalizedType = cleanText(type);
    if (!normalizedKey || !normalizedType) {
      continue;
    }
    result[normalizedKey] = normalizedType;
  }
  return result;
}

function normalizeRetryPolicy(policy = null) {
  const normalized = normalizeJsonObject(policy);
  const maxRetries = normalizePositiveInteger(normalized.max_retries, 2, { min: 0, max: 10 });
  const backoffMs = Array.isArray(normalized.backoff_ms)
    ? normalized.backoff_ms
      .map((item) => normalizePositiveInteger(item, 0, { min: 0, max: 3_600_000 }))
      .filter((item) => Number.isFinite(item))
      .slice(0, 10)
    : [];
  return {
    max_retries: maxRetries,
    backoff_ms: backoffMs,
  };
}

function normalizeNodeRecord(node = {}, index = 0, { defaultMergeNodeId = "" } = {}) {
  const normalized = normalizeJsonObject(node);
  const nodeId = cleanText(normalized.node_id || `n${index + 1}`);
  const specialistId = cleanText(normalized.specialist_id || normalized.agent_id || "generalist") || "generalist";
  const inputContract = normalizeJsonObject(normalized.input_contract);
  const outputContract = normalizeJsonObject(normalized.output_contract);
  const outputType = cleanText(outputContract.type || EXECUTIVE_ARTIFACT_TYPE.structured_output) || EXECUTIVE_ARTIFACT_TYPE.structured_output;
  return {
    node_id: nodeId,
    specialist_id: specialistId,
    task: cleanText(normalized.task || normalized.objective || ""),
    input_contract: {
      required_fields: normalizeRequiredFields(
        inputContract.required_fields || ["request_text", "context_refs"],
      ),
    },
    allowed_tools: normalizeAllowedTools(normalized.allowed_tools || []),
    output_contract: {
      type: outputType,
      schema: normalizeOutputSchema(outputContract.schema || {
        answer: "string",
        sources: "array",
        limitations: "array",
      }),
    },
    retry_policy: normalizeRetryPolicy(normalized.retry_policy),
    required_artifacts: normalizeRequiredFields(normalized.required_artifacts || []),
    is_merge_node: nodeId === defaultMergeNodeId,
  };
}

function normalizeEdgeRecord(edge = {}) {
  const normalized = normalizeJsonObject(edge);
  return {
    from: cleanText(normalized.from || ""),
    to: cleanText(normalized.to || ""),
    dependency: cleanText(normalized.dependency || EXECUTIVE_WORK_EDGE_DEPENDENCY.hard) || EXECUTIVE_WORK_EDGE_DEPENDENCY.hard,
  };
}

function isOutputContractValid(contract = null) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return false;
  }
  const artifactType = cleanText(contract.type);
  if (!ARTIFACT_TYPE_SET.has(artifactType)) {
    return false;
  }
  const schema = contract.schema;
  return Boolean(schema && typeof schema === "object" && !Array.isArray(schema));
}

function detectCycle(nodes = [], edges = []) {
  const adjacency = new Map();
  for (const node of nodes) {
    adjacency.set(node.node_id, []);
  }
  for (const edge of edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) {
      continue;
    }
    adjacency.get(edge.from).push(edge.to);
  }

  const visiting = new Set();
  const visited = new Set();

  const dfs = (nodeId) => {
    if (visiting.has(nodeId)) {
      return true;
    }
    if (visited.has(nodeId)) {
      return false;
    }
    visiting.add(nodeId);
    for (const nextId of adjacency.get(nodeId) || []) {
      if (dfs(nextId)) {
        return true;
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };

  for (const node of nodes) {
    if (dfs(node.node_id)) {
      return true;
    }
  }
  return false;
}

function normalizeGraphPayload(graph = {}) {
  const normalized = normalizeJsonObject(graph);
  const graphId = cleanText(normalized.graph_id || `wg_${crypto.randomUUID().replaceAll("-", "")}`);
  const taskId = cleanText(normalized.task_id);
  const goal = cleanText(normalized.goal);
  const mergeNodeId = cleanText(normalized.merge_node_id || "");
  const nodes = (Array.isArray(normalized.nodes) ? normalized.nodes : [])
    .map((node, index) => normalizeNodeRecord(node, index, { defaultMergeNodeId: mergeNodeId }))
    .filter((node) => Boolean(node.node_id));
  const edges = (Array.isArray(normalized.edges) ? normalized.edges : [])
    .map((edge) => normalizeEdgeRecord(edge))
    .filter((edge) => edge.from && edge.to);

  return {
    graph_id: graphId,
    task_id: taskId,
    goal,
    nodes,
    edges,
    merge_node_id: mergeNodeId,
    schema_version: EXECUTIVE_WORK_GRAPH_SCHEMA_VERSION,
  };
}

export function validateExecutiveWorkGraph(graph = {}) {
  const normalized = normalizeGraphPayload(graph);
  const errors = [];

  if (!normalized.graph_id) {
    errors.push("missing_graph_id");
  }
  if (!normalized.task_id) {
    errors.push("missing_task_id");
  }
  if (!normalized.goal) {
    errors.push("missing_goal");
  }
  if (!Array.isArray(normalized.nodes) || normalized.nodes.length === 0) {
    errors.push("missing_nodes");
  }

  const nodeIdSet = new Set();
  for (const node of normalized.nodes) {
    if (nodeIdSet.has(node.node_id)) {
      errors.push(`duplicate_node_id:${node.node_id}`);
      continue;
    }
    nodeIdSet.add(node.node_id);

    if (!node.specialist_id) {
      errors.push(`missing_specialist_id:${node.node_id}`);
    }
    if (!node.input_contract || !Array.isArray(node.input_contract.required_fields)) {
      errors.push(`invalid_input_contract:${node.node_id}`);
    }
    if (!Array.isArray(node.allowed_tools)) {
      errors.push(`invalid_allowed_tools:${node.node_id}`);
    }
    if (!isOutputContractValid(node.output_contract)) {
      errors.push(`invalid_output_contract:${node.node_id}`);
    }
    if (!node.retry_policy || typeof node.retry_policy !== "object") {
      errors.push(`invalid_retry_policy:${node.node_id}`);
    }
  }

  if (!normalized.merge_node_id) {
    errors.push("missing_merge_node_id");
  } else if (!nodeIdSet.has(normalized.merge_node_id)) {
    errors.push(`merge_node_not_found:${normalized.merge_node_id}`);
  }

  const edgeSeen = new Set();
  for (const edge of normalized.edges) {
    if (!nodeIdSet.has(edge.from)) {
      errors.push(`edge_from_missing:${edge.from}`);
    }
    if (!nodeIdSet.has(edge.to)) {
      errors.push(`edge_to_missing:${edge.to}`);
    }
    if (!EDGE_DEPENDENCY_SET.has(edge.dependency)) {
      errors.push(`invalid_dependency:${edge.from}->${edge.to}`);
    }
    if (edge.from === edge.to) {
      errors.push(`self_cycle:${edge.from}`);
    }
    const edgeKey = `${edge.from}->${edge.to}:${edge.dependency}`;
    if (edgeSeen.has(edgeKey)) {
      errors.push(`duplicate_edge:${edgeKey}`);
    }
    edgeSeen.add(edgeKey);
  }

  if (!errors.length && detectCycle(normalized.nodes, normalized.edges)) {
    errors.push("graph_cycle_detected");
  }

  return {
    ok: errors.length === 0,
    errors,
    graph: normalized,
  };
}

function mapAgentAllowedToolsToPlannerActions(allowedTools = []) {
  const normalizedAllowedTools = normalizeAllowedTools(allowedTools);
  const mapping = {
    company_brain_search: "search_company_brain_docs",
    company_brain_detail: "get_company_brain_doc_detail",
    company_brain_list: "list_company_brain_docs",
    runtime_info_read: "get_runtime_info",
    planner_tool_dispatch: "search_company_brain_docs",
  };
  const expanded = [];
  for (const entry of normalizedAllowedTools) {
    expanded.push(entry);
    if (mapping[entry]) {
      expanded.push(mapping[entry]);
    }
  }
  return Array.from(new Set(expanded));
}

function buildDefaultNodeOutputContract() {
  return {
    type: EXECUTIVE_ARTIFACT_TYPE.structured_output,
    schema: {
      answer: "string",
      sources: "array",
      limitations: "array",
    },
  };
}

function buildDefaultNodeInputContract() {
  return {
    required_fields: ["request_text", "context_refs"],
  };
}

export function buildWorkGraphFromDecision({
  taskId = "",
  goal = "",
  graphId = "",
  workPlan = [],
  primaryAgentId = "",
  requestText = "",
} = {}) {
  const normalizedTaskId = cleanText(taskId) || `task_${crypto.randomUUID().replaceAll("-", "")}`;
  const normalizedGoal = cleanText(goal || requestText) || "resolve_request";
  const normalizedGraphId = cleanText(graphId) || `wg_${crypto.randomUUID().replaceAll("-", "")}`;

  const plan = Array.isArray(workPlan) ? workPlan : [];
  const nodes = [];
  const edges = [];
  const seenNodeByAgent = new Set();

  for (const item of plan) {
    const agentId = cleanText(item?.agent_id || "");
    if (!agentId || seenNodeByAgent.has(agentId)) {
      continue;
    }
    seenNodeByAgent.add(agentId);
    const agent = getRegisteredAgent(agentId);
    const nodeId = cleanText(item?.node_id || `n${nodes.length + 1}`) || `n${nodes.length + 1}`;
    const outputContract = buildDefaultNodeOutputContract();
    const inputContract = buildDefaultNodeInputContract();
    const allowedTools = mapAgentAllowedToolsToPlannerActions(
      item?.allowed_tools || agent?.contract?.allowed_tools || [],
    );
    nodes.push({
      node_id: nodeId,
      specialist_id: agentId,
      task: cleanText(item?.task || requestText || `work_item_${nodes.length + 1}`),
      input_contract: inputContract,
      allowed_tools: allowedTools,
      output_contract: outputContract,
      retry_policy: normalizeRetryPolicy(item?.retry_policy || {
        max_retries: 2,
        backoff_ms: [1000, 3000],
      }),
    });
  }

  const mergeAgentId = cleanText(primaryAgentId)
    || cleanText(plan.at(-1)?.agent_id)
    || cleanText(plan[0]?.agent_id)
    || "generalist";
  const mergeNodeId = `n_merge`;
  nodes.push({
    node_id: mergeNodeId,
    specialist_id: mergeAgentId,
    task: cleanText(requestText) || "merge_artifacts_into_final_answer",
    input_contract: {
      required_fields: ["artifact_refs", "request_text"],
    },
    allowed_tools: mapAgentAllowedToolsToPlannerActions(
      getRegisteredAgent(mergeAgentId)?.contract?.allowed_tools || [],
    ),
    output_contract: buildDefaultNodeOutputContract(),
    retry_policy: {
      max_retries: 0,
      backoff_ms: [],
    },
  });

  for (const node of nodes) {
    if (node.node_id === mergeNodeId) {
      continue;
    }
    edges.push({
      from: node.node_id,
      to: mergeNodeId,
      dependency: EXECUTIVE_WORK_EDGE_DEPENDENCY.hard,
    });
  }

  const graph = {
    graph_id: normalizedGraphId,
    task_id: normalizedTaskId,
    goal: normalizedGoal,
    nodes,
    edges,
    merge_node_id: mergeNodeId,
    schema_version: EXECUTIVE_WORK_GRAPH_SCHEMA_VERSION,
  };

  const validation = validateExecutiveWorkGraph(graph);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      graph: validation.graph,
    };
  }
  return {
    ok: true,
    graph: validation.graph,
  };
}

function deriveInitialNodeState(nodeId = "", incomingHardDependencyCountMap = new Map()) {
  const hardDependencyCount = Number(incomingHardDependencyCountMap.get(nodeId) || 0);
  if (hardDependencyCount > 0) {
    return EXECUTIVE_WORK_NODE_STATE.blocked;
  }
  return EXECUTIVE_WORK_NODE_STATE.queued;
}

export function ensureExecutiveWorkGraphTables() {
  if (tablesReady) {
    return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS executive_work_graphs (
      graph_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      goal TEXT NOT NULL,
      merge_node_id TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      status TEXT NOT NULL,
      graph_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      failed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS executive_work_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graph_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      specialist_id TEXT NOT NULL,
      state TEXT NOT NULL,
      input_contract_json TEXT,
      allowed_tools_json TEXT,
      output_contract_json TEXT,
      retry_policy_json TEXT,
      required_artifacts_json TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 0,
      next_run_at TEXT,
      last_error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      failed_at TEXT,
      UNIQUE(graph_id, node_id),
      FOREIGN KEY (graph_id) REFERENCES executive_work_graphs(graph_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS executive_work_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      graph_id TEXT NOT NULL,
      from_node_id TEXT NOT NULL,
      to_node_id TEXT NOT NULL,
      dependency TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (graph_id) REFERENCES executive_work_graphs(graph_id) ON DELETE CASCADE,
      UNIQUE(graph_id, from_node_id, to_node_id, dependency)
    );

    CREATE TABLE IF NOT EXISTS executive_node_attempts (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      worker_id TEXT,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_json TEXT,
      retry_metadata_json TEXT,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT,
      completed_at TEXT,
      failed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (graph_id, node_id) REFERENCES executive_work_nodes(graph_id, node_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS executive_node_leases (
      graph_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (graph_id, node_id),
      FOREIGN KEY (graph_id, node_id) REFERENCES executive_work_nodes(graph_id, node_id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES executive_node_attempts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS executive_artifacts (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt_id TEXT,
      artifact_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (graph_id, node_id) REFERENCES executive_work_nodes(graph_id, node_id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES executive_node_attempts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS executive_deadletters (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt_id TEXT,
      failure_class TEXT NOT NULL,
      last_error TEXT,
      next_manual_action TEXT,
      replay_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY (graph_id, node_id) REFERENCES executive_work_nodes(graph_id, node_id) ON DELETE CASCADE,
      FOREIGN KEY (attempt_id) REFERENCES executive_node_attempts(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_executive_work_nodes_sched
      ON executive_work_nodes(graph_id, state, next_run_at, updated_at);

    CREATE INDEX IF NOT EXISTS idx_executive_work_edges_to_node
      ON executive_work_edges(graph_id, to_node_id, dependency);

    CREATE INDEX IF NOT EXISTS idx_executive_node_attempts_node
      ON executive_node_attempts(graph_id, node_id, attempt DESC, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_executive_node_leases_signal
      ON executive_node_leases(graph_id, worker_id, lease_expires_at, heartbeat_at);

    CREATE INDEX IF NOT EXISTS idx_executive_artifacts_node
      ON executive_artifacts(graph_id, node_id, artifact_type, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_executive_deadletters_open
      ON executive_deadletters(graph_id, status, updated_at DESC);
  `);
  tablesReady = true;
}

function toGraphRecord(row = null) {
  if (!row) {
    return null;
  }
  return {
    graph_id: cleanText(row.graph_id) || null,
    task_id: cleanText(row.task_id) || null,
    goal: cleanText(row.goal) || null,
    merge_node_id: cleanText(row.merge_node_id) || null,
    schema_version: cleanText(row.schema_version) || null,
    status: cleanText(row.status) || null,
    graph: parseJson(row.graph_json),
    created_at: cleanText(row.created_at) || null,
    updated_at: cleanText(row.updated_at) || null,
    started_at: cleanText(row.started_at) || null,
    completed_at: cleanText(row.completed_at) || null,
    failed_at: cleanText(row.failed_at) || null,
  };
}

function toNodeRecord(row = null) {
  if (!row) {
    return null;
  }
  return {
    graph_id: cleanText(row.graph_id) || null,
    node_id: cleanText(row.node_id) || null,
    specialist_id: cleanText(row.specialist_id) || null,
    state: cleanText(row.state) || null,
    input_contract: parseJson(row.input_contract_json) || {},
    allowed_tools: parseJson(row.allowed_tools_json) || [],
    output_contract: parseJson(row.output_contract_json) || {},
    retry_policy: parseJson(row.retry_policy_json) || { max_retries: 0, backoff_ms: [] },
    required_artifacts: parseJson(row.required_artifacts_json) || [],
    attempt_count: Number(row.attempt_count || 0),
    max_retries: Number(row.max_retries || 0),
    next_run_at: cleanText(row.next_run_at) || null,
    last_error: parseJson(row.last_error_json),
    created_at: cleanText(row.created_at) || null,
    updated_at: cleanText(row.updated_at) || null,
    started_at: cleanText(row.started_at) || null,
    completed_at: cleanText(row.completed_at) || null,
    failed_at: cleanText(row.failed_at) || null,
  };
}

function toAttemptRecord(row = null) {
  if (!row) {
    return null;
  }
  return {
    id: cleanText(row.id) || null,
    graph_id: cleanText(row.graph_id) || null,
    node_id: cleanText(row.node_id) || null,
    worker_id: cleanText(row.worker_id) || null,
    attempt: Number(row.attempt || 0),
    status: cleanText(row.status) || null,
    error: parseJson(row.error_json),
    retry_metadata: parseJson(row.retry_metadata_json),
    started_at: cleanText(row.started_at) || null,
    heartbeat_at: cleanText(row.heartbeat_at) || null,
    completed_at: cleanText(row.completed_at) || null,
    failed_at: cleanText(row.failed_at) || null,
    created_at: cleanText(row.created_at) || null,
    updated_at: cleanText(row.updated_at) || null,
  };
}

function toArtifactRecord(row = null) {
  if (!row) {
    return null;
  }
  return {
    id: cleanText(row.id) || null,
    graph_id: cleanText(row.graph_id) || null,
    node_id: cleanText(row.node_id) || null,
    attempt_id: cleanText(row.attempt_id) || null,
    artifact_type: cleanText(row.artifact_type) || null,
    payload: parseJson(row.payload_json),
    schema_version: cleanText(row.schema_version) || null,
    hash: cleanText(row.hash) || null,
    created_at: cleanText(row.created_at) || null,
  };
}

export function getExecutiveWorkGraph(graphId = "") {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  if (!normalizedGraphId) {
    return null;
  }
  const row = db.prepare(`
    SELECT *
    FROM executive_work_graphs
    WHERE graph_id = ?
    LIMIT 1
  `).get(normalizedGraphId);
  return toGraphRecord(row);
}

export function listExecutiveWorkNodes(graphId = "") {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  if (!normalizedGraphId) {
    return [];
  }
  const rows = db.prepare(`
    SELECT *
    FROM executive_work_nodes
    WHERE graph_id = ?
    ORDER BY id ASC
  `).all(normalizedGraphId);
  return rows.map((row) => toNodeRecord(row)).filter(Boolean);
}

export function listExecutiveWorkArtifacts({ graphId = "", nodeId = "" } = {}) {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  if (!normalizedGraphId) {
    return [];
  }
  const normalizedNodeId = cleanText(nodeId);
  const rows = normalizedNodeId
    ? db.prepare(`
      SELECT *
      FROM executive_artifacts
      WHERE graph_id = @graph_id
        AND node_id = @node_id
      ORDER BY created_at ASC
    `).all({
      graph_id: normalizedGraphId,
      node_id: normalizedNodeId,
    })
    : db.prepare(`
      SELECT *
      FROM executive_artifacts
      WHERE graph_id = ?
      ORDER BY created_at ASC
    `).all(normalizedGraphId);
  return rows.map((row) => toArtifactRecord(row)).filter(Boolean);
}

function calculateIncomingHardDependencyCountMap(edges = []) {
  const map = new Map();
  for (const edge of edges) {
    if (edge.dependency !== EXECUTIVE_WORK_EDGE_DEPENDENCY.hard) {
      continue;
    }
    map.set(edge.to, Number(map.get(edge.to) || 0) + 1);
  }
  return map;
}

export function persistExecutiveWorkGraph({
  graph = null,
  status = "active",
} = {}) {
  ensureExecutiveWorkGraphTables();
  const validation = validateExecutiveWorkGraph(graph || {});
  if (!validation.ok) {
    return {
      ok: false,
      error: "invalid_work_graph_schema",
      details: {
        issues: validation.errors,
      },
    };
  }

  const normalizedGraph = validation.graph;
  const incomingHardDependencyCountMap = calculateIncomingHardDependencyCountMap(normalizedGraph.edges);

  const persistTx = db.transaction(() => {
    const now = nowIso();
    db.prepare(`
      INSERT INTO executive_work_graphs (
        graph_id,
        task_id,
        goal,
        merge_node_id,
        schema_version,
        status,
        graph_json,
        created_at,
        updated_at,
        started_at,
        completed_at,
        failed_at
      ) VALUES (
        @graph_id,
        @task_id,
        @goal,
        @merge_node_id,
        @schema_version,
        @status,
        @graph_json,
        @created_at,
        @updated_at,
        NULL,
        NULL,
        NULL
      )
      ON CONFLICT(graph_id) DO UPDATE SET
        task_id = excluded.task_id,
        goal = excluded.goal,
        merge_node_id = excluded.merge_node_id,
        schema_version = excluded.schema_version,
        status = excluded.status,
        graph_json = excluded.graph_json,
        updated_at = excluded.updated_at
    `).run({
      graph_id: normalizedGraph.graph_id,
      task_id: normalizedGraph.task_id,
      goal: normalizedGraph.goal,
      merge_node_id: normalizedGraph.merge_node_id,
      schema_version: normalizedGraph.schema_version,
      status: cleanText(status) || "active",
      graph_json: stringifyJson(normalizedGraph),
      created_at: now,
      updated_at: now,
    });

    db.prepare(`DELETE FROM executive_work_nodes WHERE graph_id = ?`).run(normalizedGraph.graph_id);
    db.prepare(`DELETE FROM executive_work_edges WHERE graph_id = ?`).run(normalizedGraph.graph_id);

    for (const node of normalizedGraph.nodes) {
      const nodeState = deriveInitialNodeState(node.node_id, incomingHardDependencyCountMap);
      db.prepare(`
        INSERT INTO executive_work_nodes (
          graph_id,
          node_id,
          specialist_id,
          state,
          input_contract_json,
          allowed_tools_json,
          output_contract_json,
          retry_policy_json,
          required_artifacts_json,
          attempt_count,
          max_retries,
          next_run_at,
          last_error_json,
          created_at,
          updated_at,
          started_at,
          completed_at,
          failed_at
        ) VALUES (
          @graph_id,
          @node_id,
          @specialist_id,
          @state,
          @input_contract_json,
          @allowed_tools_json,
          @output_contract_json,
          @retry_policy_json,
          @required_artifacts_json,
          0,
          @max_retries,
          @next_run_at,
          NULL,
          @created_at,
          @updated_at,
          NULL,
          NULL,
          NULL
        )
      `).run({
        graph_id: normalizedGraph.graph_id,
        node_id: node.node_id,
        specialist_id: node.specialist_id,
        state: nodeState,
        input_contract_json: stringifyJson(node.input_contract),
        allowed_tools_json: stringifyJson(node.allowed_tools || []),
        output_contract_json: stringifyJson(node.output_contract),
        retry_policy_json: stringifyJson(node.retry_policy),
        required_artifacts_json: stringifyJson(node.required_artifacts || []),
        max_retries: normalizePositiveInteger(node.retry_policy?.max_retries, 2, { min: 0, max: 10 }),
        next_run_at: nodeState === EXECUTIVE_WORK_NODE_STATE.queued ? now : null,
        created_at: now,
        updated_at: now,
      });
    }

    for (const edge of normalizedGraph.edges) {
      db.prepare(`
        INSERT INTO executive_work_edges (
          graph_id,
          from_node_id,
          to_node_id,
          dependency,
          created_at
        ) VALUES (
          @graph_id,
          @from_node_id,
          @to_node_id,
          @dependency,
          @created_at
        )
      `).run({
        graph_id: normalizedGraph.graph_id,
        from_node_id: edge.from,
        to_node_id: edge.to,
        dependency: edge.dependency,
        created_at: now,
      });
    }

    return getExecutiveWorkGraph(normalizedGraph.graph_id);
  });

  const persisted = persistTx();
  return {
    ok: true,
    graph: persisted,
  };
}

export function scheduleExecutableWorkNodes(graphId = "") {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  if (!normalizedGraphId) {
    return {
      ok: false,
      error: "missing_graph_id",
    };
  }

  const now = nowIso();
  const updated = db.prepare(`
    UPDATE executive_work_nodes AS node
    SET state = @queued_state,
        next_run_at = COALESCE(node.next_run_at, @next_run_at),
        updated_at = @updated_at
    WHERE node.graph_id = @graph_id
      AND node.state IN (@blocked_state, @failed_state)
      AND NOT EXISTS (
        SELECT 1
        FROM executive_work_edges edge
        JOIN executive_work_nodes dep
          ON dep.graph_id = edge.graph_id
         AND dep.node_id = edge.from_node_id
        WHERE edge.graph_id = node.graph_id
          AND edge.to_node_id = node.node_id
          AND edge.dependency = @hard_dependency
          AND dep.state != @succeeded_state
      )
  `).run({
    graph_id: normalizedGraphId,
    queued_state: EXECUTIVE_WORK_NODE_STATE.queued,
    blocked_state: EXECUTIVE_WORK_NODE_STATE.blocked,
    failed_state: EXECUTIVE_WORK_NODE_STATE.failed,
    hard_dependency: EXECUTIVE_WORK_EDGE_DEPENDENCY.hard,
    succeeded_state: EXECUTIVE_WORK_NODE_STATE.succeeded,
    next_run_at: now,
    updated_at: now,
  });

  return {
    ok: true,
    queued: Number(updated?.changes || 0),
  };
}

function getNodeByGraphAndNodeId(graphId = "", nodeId = "") {
  const row = db.prepare(`
    SELECT *
    FROM executive_work_nodes
    WHERE graph_id = @graph_id
      AND node_id = @node_id
    LIMIT 1
  `).get({
    graph_id: graphId,
    node_id: nodeId,
  });
  return toNodeRecord(row);
}

function getAttemptById(attemptId = "") {
  const row = db.prepare(`
    SELECT *
    FROM executive_node_attempts
    WHERE id = ?
    LIMIT 1
  `).get(attemptId);
  return toAttemptRecord(row);
}

export function claimNextExecutableWorkNode({
  graphId = "",
  workerId = "",
  leaseMs = DEFAULT_AUTONOMY_LEASE_MS,
} = {}) {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  const normalizedWorkerId = cleanText(workerId);
  if (!normalizedGraphId || !normalizedWorkerId) {
    return null;
  }

  const claimTx = db.transaction(() => {
    const now = nowIso();
    const candidate = db.prepare(`
      SELECT node.*
      FROM executive_work_nodes node
      WHERE node.graph_id = @graph_id
        AND node.state = @queued_state
        AND (node.next_run_at IS NULL OR node.next_run_at <= @now)
        AND NOT EXISTS (
          SELECT 1
          FROM executive_work_edges edge
          JOIN executive_work_nodes dep
            ON dep.graph_id = edge.graph_id
           AND dep.node_id = edge.from_node_id
          WHERE edge.graph_id = node.graph_id
            AND edge.to_node_id = node.node_id
            AND edge.dependency = @hard_dependency
            AND dep.state != @succeeded_state
        )
      ORDER BY COALESCE(node.next_run_at, node.updated_at, node.created_at) ASC, node.id ASC
      LIMIT 1
    `).get({
      graph_id: normalizedGraphId,
      queued_state: EXECUTIVE_WORK_NODE_STATE.queued,
      hard_dependency: EXECUTIVE_WORK_EDGE_DEPENDENCY.hard,
      succeeded_state: EXECUTIVE_WORK_NODE_STATE.succeeded,
      now,
    });

    if (!candidate) {
      return null;
    }

    const updated = db.prepare(`
      UPDATE executive_work_nodes
      SET state = @claimed_state,
          attempt_count = attempt_count + 1,
          updated_at = @updated_at,
          started_at = COALESCE(started_at, @started_at)
      WHERE graph_id = @graph_id
        AND node_id = @node_id
        AND state = @queued_state
    `).run({
      graph_id: normalizedGraphId,
      node_id: candidate.node_id,
      claimed_state: EXECUTIVE_WORK_NODE_STATE.claimed,
      queued_state: EXECUTIVE_WORK_NODE_STATE.queued,
      updated_at: now,
      started_at: now,
    });

    if (Number(updated?.changes || 0) !== 1) {
      return null;
    }

    const updatedNode = getNodeByGraphAndNodeId(normalizedGraphId, candidate.node_id);
    const attemptId = crypto.randomUUID();
    const leaseExpiresAt = addMsToNowIso(leaseMs);

    db.prepare(`
      INSERT INTO executive_node_attempts (
        id,
        graph_id,
        node_id,
        worker_id,
        attempt,
        status,
        error_json,
        retry_metadata_json,
        started_at,
        heartbeat_at,
        completed_at,
        failed_at,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @graph_id,
        @node_id,
        @worker_id,
        @attempt,
        @status,
        NULL,
        NULL,
        @started_at,
        @heartbeat_at,
        NULL,
        NULL,
        @created_at,
        @updated_at
      )
    `).run({
      id: attemptId,
      graph_id: normalizedGraphId,
      node_id: candidate.node_id,
      worker_id: normalizedWorkerId,
      attempt: Number(updatedNode?.attempt_count || Number(candidate.attempt_count || 0) + 1),
      status: EXECUTIVE_WORK_NODE_STATE.running,
      started_at: now,
      heartbeat_at: now,
      created_at: now,
      updated_at: now,
    });

    db.prepare(`
      INSERT INTO executive_node_leases (
        graph_id,
        node_id,
        attempt_id,
        worker_id,
        lease_expires_at,
        heartbeat_at,
        created_at,
        updated_at
      ) VALUES (
        @graph_id,
        @node_id,
        @attempt_id,
        @worker_id,
        @lease_expires_at,
        @heartbeat_at,
        @created_at,
        @updated_at
      )
      ON CONFLICT(graph_id, node_id) DO UPDATE SET
        attempt_id = excluded.attempt_id,
        worker_id = excluded.worker_id,
        lease_expires_at = excluded.lease_expires_at,
        heartbeat_at = excluded.heartbeat_at,
        updated_at = excluded.updated_at
    `).run({
      graph_id: normalizedGraphId,
      node_id: candidate.node_id,
      attempt_id: attemptId,
      worker_id: normalizedWorkerId,
      lease_expires_at: leaseExpiresAt,
      heartbeat_at: now,
      created_at: now,
      updated_at: now,
    });

    return {
      node: getNodeByGraphAndNodeId(normalizedGraphId, candidate.node_id),
      attempt: getAttemptById(attemptId),
      lease: {
        graph_id: normalizedGraphId,
        node_id: candidate.node_id,
        attempt_id: attemptId,
        worker_id: normalizedWorkerId,
        lease_expires_at: leaseExpiresAt,
        heartbeat_at: now,
      },
    };
  });

  return claimTx();
}

export function startExecutableWorkNodeExecution({
  graphId = "",
  nodeId = "",
  attemptId = "",
  workerId = "",
} = {}) {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  const normalizedNodeId = cleanText(nodeId);
  const normalizedAttemptId = cleanText(attemptId);
  const normalizedWorkerId = cleanText(workerId);
  if (!normalizedGraphId || !normalizedNodeId || !normalizedAttemptId || !normalizedWorkerId) {
    return {
      ok: false,
      error: "invalid_start_node_execution_input",
    };
  }

  const now = nowIso();
  const updated = db.prepare(`
    UPDATE executive_work_nodes
    SET state = @running_state,
        updated_at = @updated_at
    WHERE graph_id = @graph_id
      AND node_id = @node_id
      AND state = @claimed_state
  `).run({
    graph_id: normalizedGraphId,
    node_id: normalizedNodeId,
    running_state: EXECUTIVE_WORK_NODE_STATE.running,
    claimed_state: EXECUTIVE_WORK_NODE_STATE.claimed,
    updated_at: now,
  });

  if (Number(updated?.changes || 0) !== 1) {
    return {
      ok: false,
      error: "node_not_claimed",
    };
  }

  db.prepare(`
    UPDATE executive_node_attempts
    SET status = @status,
        updated_at = @updated_at,
        heartbeat_at = @heartbeat_at
    WHERE id = @attempt_id
      AND graph_id = @graph_id
      AND node_id = @node_id
      AND worker_id = @worker_id
  `).run({
    attempt_id: normalizedAttemptId,
    graph_id: normalizedGraphId,
    node_id: normalizedNodeId,
    worker_id: normalizedWorkerId,
    status: EXECUTIVE_WORK_NODE_STATE.running,
    updated_at: now,
    heartbeat_at: now,
  });

  return {
    ok: true,
    node: getNodeByGraphAndNodeId(normalizedGraphId, normalizedNodeId),
    attempt: getAttemptById(normalizedAttemptId),
  };
}

export function heartbeatExecutableWorkNodeLease({
  graphId = "",
  nodeId = "",
  workerId = "",
  leaseMs = DEFAULT_AUTONOMY_LEASE_MS,
} = {}) {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  const normalizedNodeId = cleanText(nodeId);
  const normalizedWorkerId = cleanText(workerId);
  if (!normalizedGraphId || !normalizedNodeId || !normalizedWorkerId) {
    return {
      ok: false,
      error: "invalid_node_heartbeat_input",
    };
  }

  const heartbeatTx = db.transaction(() => {
    const now = nowIso();
    const leaseExpiresAt = addMsToNowIso(leaseMs);
    const updatedLease = db.prepare(`
      UPDATE executive_node_leases
      SET lease_expires_at = @lease_expires_at,
          heartbeat_at = @heartbeat_at,
          updated_at = @updated_at
      WHERE graph_id = @graph_id
        AND node_id = @node_id
        AND worker_id = @worker_id
    `).run({
      graph_id: normalizedGraphId,
      node_id: normalizedNodeId,
      worker_id: normalizedWorkerId,
      lease_expires_at: leaseExpiresAt,
      heartbeat_at: now,
      updated_at: now,
    });

    if (Number(updatedLease?.changes || 0) !== 1) {
      return {
        ok: false,
        error: "node_lease_not_found",
      };
    }

    db.prepare(`
      UPDATE executive_node_attempts
      SET heartbeat_at = @heartbeat_at,
          updated_at = @updated_at
      WHERE id = (
        SELECT attempt_id
        FROM executive_node_leases
        WHERE graph_id = @graph_id
          AND node_id = @node_id
          AND worker_id = @worker_id
        LIMIT 1
      )
    `).run({
      graph_id: normalizedGraphId,
      node_id: normalizedNodeId,
      worker_id: normalizedWorkerId,
      heartbeat_at: now,
      updated_at: now,
    });

    return {
      ok: true,
      lease_expires_at: leaseExpiresAt,
      heartbeat_at: now,
    };
  });

  return heartbeatTx();
}

export function recordExecutiveArtifact({
  graphId = "",
  nodeId = "",
  attemptId = "",
  artifactType = "",
  payload = null,
  schemaVersion = EXECUTIVE_WORK_GRAPH_SCHEMA_VERSION,
} = {}) {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  const normalizedNodeId = cleanText(nodeId);
  const normalizedAttemptId = cleanText(attemptId);
  const normalizedArtifactType = cleanText(artifactType);

  if (!normalizedGraphId || !normalizedNodeId || !ARTIFACT_TYPE_SET.has(normalizedArtifactType)) {
    return {
      ok: false,
      error: "invalid_artifact_input",
    };
  }

  const now = nowIso();
  const id = crypto.randomUUID();
  const normalizedPayload = payload == null ? {} : payload;
  const hash = createPayloadHash({
    graph_id: normalizedGraphId,
    node_id: normalizedNodeId,
    artifact_type: normalizedArtifactType,
    payload: normalizedPayload,
  });

  db.prepare(`
    INSERT INTO executive_artifacts (
      id,
      graph_id,
      node_id,
      attempt_id,
      artifact_type,
      payload_json,
      schema_version,
      hash,
      created_at
    ) VALUES (
      @id,
      @graph_id,
      @node_id,
      @attempt_id,
      @artifact_type,
      @payload_json,
      @schema_version,
      @hash,
      @created_at
    )
  `).run({
    id,
    graph_id: normalizedGraphId,
    node_id: normalizedNodeId,
    attempt_id: normalizedAttemptId || null,
    artifact_type: normalizedArtifactType,
    payload_json: stringifyJson(normalizedPayload),
    schema_version: cleanText(schemaVersion) || EXECUTIVE_WORK_GRAPH_SCHEMA_VERSION,
    hash,
    created_at: now,
  });

  const row = db.prepare(`
    SELECT *
    FROM executive_artifacts
    WHERE id = ?
    LIMIT 1
  `).get(id);

  return {
    ok: true,
    artifact: toArtifactRecord(row),
  };
}

export function completeExecutableWorkNode({
  graphId = "",
  nodeId = "",
  attemptId = "",
  workerId = "",
  artifacts = [],
  result = null,
} = {}) {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  const normalizedNodeId = cleanText(nodeId);
  const normalizedAttemptId = cleanText(attemptId);
  const normalizedWorkerId = cleanText(workerId);
  if (!normalizedGraphId || !normalizedNodeId || !normalizedAttemptId || !normalizedWorkerId) {
    return {
      ok: false,
      error: "invalid_complete_node_input",
    };
  }

  const completeTx = db.transaction(() => {
    const now = nowIso();
    const lease = db.prepare(`
      SELECT *
      FROM executive_node_leases
      WHERE graph_id = @graph_id
        AND node_id = @node_id
      LIMIT 1
    `).get({
      graph_id: normalizedGraphId,
      node_id: normalizedNodeId,
    });

    if (!lease || cleanText(lease.worker_id) !== normalizedWorkerId || cleanText(lease.attempt_id) !== normalizedAttemptId) {
      return {
        ok: false,
        error: "node_lease_mismatch",
      };
    }

    db.prepare(`
      UPDATE executive_node_attempts
      SET status = @status,
          completed_at = @completed_at,
          updated_at = @updated_at,
          retry_metadata_json = @retry_metadata_json,
          error_json = NULL
      WHERE id = @attempt_id
        AND graph_id = @graph_id
        AND node_id = @node_id
    `).run({
      attempt_id: normalizedAttemptId,
      graph_id: normalizedGraphId,
      node_id: normalizedNodeId,
      status: EXECUTIVE_WORK_NODE_STATE.succeeded,
      completed_at: now,
      updated_at: now,
      retry_metadata_json: stringifyJson({
        completed: true,
        result: result || null,
      }),
    });

    for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
      const artifactType = cleanText(artifact?.artifact_type || artifact?.type || "");
      if (!ARTIFACT_TYPE_SET.has(artifactType)) {
        continue;
      }
      recordExecutiveArtifact({
        graphId: normalizedGraphId,
        nodeId: normalizedNodeId,
        attemptId: normalizedAttemptId,
        artifactType,
        payload: artifact?.payload ?? artifact,
        schemaVersion: cleanText(artifact?.schema_version || "") || EXECUTIVE_WORK_GRAPH_SCHEMA_VERSION,
      });
    }

    db.prepare(`
      DELETE FROM executive_node_leases
      WHERE graph_id = @graph_id
        AND node_id = @node_id
    `).run({
      graph_id: normalizedGraphId,
      node_id: normalizedNodeId,
    });

    db.prepare(`
      UPDATE executive_work_nodes
      SET state = @state,
          completed_at = @completed_at,
          updated_at = @updated_at,
          next_run_at = NULL,
          failed_at = NULL,
          last_error_json = NULL
      WHERE graph_id = @graph_id
        AND node_id = @node_id
    `).run({
      graph_id: normalizedGraphId,
      node_id: normalizedNodeId,
      state: EXECUTIVE_WORK_NODE_STATE.succeeded,
      completed_at: now,
      updated_at: now,
    });

    return {
      ok: true,
      node: getNodeByGraphAndNodeId(normalizedGraphId, normalizedNodeId),
      attempt: getAttemptById(normalizedAttemptId),
      artifacts: listExecutiveWorkArtifacts({
        graphId: normalizedGraphId,
        nodeId: normalizedNodeId,
      }),
    };
  });

  return completeTx();
}

export function failExecutableWorkNode({
  graphId = "",
  nodeId = "",
  attemptId = "",
  workerId = "",
  failureClass = "runtime_exception",
  lastError = "",
  nextManualAction = "",
  retryPolicy = null,
} = {}) {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  const normalizedNodeId = cleanText(nodeId);
  const normalizedAttemptId = cleanText(attemptId);
  const normalizedWorkerId = cleanText(workerId);
  if (!normalizedGraphId || !normalizedNodeId || !normalizedAttemptId || !normalizedWorkerId) {
    return {
      ok: false,
      error: "invalid_fail_node_input",
    };
  }

  const failTx = db.transaction(() => {
    const now = nowIso();
    const node = getNodeByGraphAndNodeId(normalizedGraphId, normalizedNodeId);
    if (!node) {
      return {
        ok: false,
        error: "node_not_found",
      };
    }

    const normalizedRetryPolicy = retryPolicy && typeof retryPolicy === "object"
      ? normalizeRetryPolicy(retryPolicy)
      : normalizeRetryPolicy(node.retry_policy);
    const currentAttemptCount = Number(node.attempt_count || 0);
    const canRetry = currentAttemptCount <= normalizedRetryPolicy.max_retries;
    const retryIndex = Math.max(0, currentAttemptCount - 1);
    const retryBackoffMs = Number(normalizedRetryPolicy.backoff_ms?.[retryIndex] || 0);
    const nextRunAt = canRetry && retryBackoffMs > 0
      ? new Date(Date.now() + retryBackoffMs).toISOString()
      : canRetry
        ? now
        : null;

    db.prepare(`
      UPDATE executive_node_attempts
      SET status = @status,
          failed_at = @failed_at,
          updated_at = @updated_at,
          error_json = @error_json,
          retry_metadata_json = @retry_metadata_json
      WHERE id = @attempt_id
        AND graph_id = @graph_id
        AND node_id = @node_id
    `).run({
      attempt_id: normalizedAttemptId,
      graph_id: normalizedGraphId,
      node_id: normalizedNodeId,
      status: EXECUTIVE_WORK_NODE_STATE.failed,
      failed_at: now,
      updated_at: now,
      error_json: stringifyJson({
        error: cleanText(lastError) || "node_execution_failed",
        failure_class: cleanText(failureClass) || "runtime_exception",
      }),
      retry_metadata_json: stringifyJson({
        retryable: canRetry,
        retry_index: retryIndex,
        retry_backoff_ms: retryBackoffMs,
      }),
    });

    db.prepare(`
      DELETE FROM executive_node_leases
      WHERE graph_id = @graph_id
        AND node_id = @node_id
        AND worker_id = @worker_id
    `).run({
      graph_id: normalizedGraphId,
      node_id: normalizedNodeId,
      worker_id: normalizedWorkerId,
    });

    if (canRetry) {
      db.prepare(`
        UPDATE executive_work_nodes
        SET state = @state,
            next_run_at = @next_run_at,
            updated_at = @updated_at,
            last_error_json = @last_error_json,
            failed_at = NULL
        WHERE graph_id = @graph_id
          AND node_id = @node_id
      `).run({
        graph_id: normalizedGraphId,
        node_id: normalizedNodeId,
        state: EXECUTIVE_WORK_NODE_STATE.queued,
        next_run_at: nextRunAt,
        updated_at: now,
        last_error_json: stringifyJson({
          failure_class: cleanText(failureClass) || "runtime_exception",
          error: cleanText(lastError) || "node_execution_failed",
        }),
      });
    } else {
      db.prepare(`
        UPDATE executive_work_nodes
        SET state = @state,
            next_run_at = NULL,
            updated_at = @updated_at,
            failed_at = @failed_at,
            last_error_json = @last_error_json
        WHERE graph_id = @graph_id
          AND node_id = @node_id
      `).run({
        graph_id: normalizedGraphId,
        node_id: normalizedNodeId,
        state: EXECUTIVE_WORK_NODE_STATE.deadletter,
        updated_at: now,
        failed_at: now,
        last_error_json: stringifyJson({
          failure_class: cleanText(failureClass) || "runtime_exception",
          error: cleanText(lastError) || "node_execution_failed",
        }),
      });

      db.prepare(`
        INSERT INTO executive_deadletters (
          id,
          graph_id,
          node_id,
          attempt_id,
          failure_class,
          last_error,
          next_manual_action,
          replay_count,
          status,
          created_at,
          updated_at,
          resolved_at
        ) VALUES (
          @id,
          @graph_id,
          @node_id,
          @attempt_id,
          @failure_class,
          @last_error,
          @next_manual_action,
          0,
          'open',
          @created_at,
          @updated_at,
          NULL
        )
      `).run({
        id: crypto.randomUUID(),
        graph_id: normalizedGraphId,
        node_id: normalizedNodeId,
        attempt_id: normalizedAttemptId,
        failure_class: cleanText(failureClass) || "runtime_exception",
        last_error: cleanText(lastError) || "node_execution_failed",
        next_manual_action: cleanText(nextManualAction) || "review_and_resume",
        created_at: now,
        updated_at: now,
      });
    }

    return {
      ok: true,
      retry_scheduled: canRetry,
      next_run_at: nextRunAt,
      node: getNodeByGraphAndNodeId(normalizedGraphId, normalizedNodeId),
      attempt: getAttemptById(normalizedAttemptId),
    };
  });

  return failTx();
}

export function getExecutiveWorkGraphSummary(graphId = "") {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  if (!normalizedGraphId) {
    return null;
  }

  const graph = getExecutiveWorkGraph(normalizedGraphId);
  if (!graph) {
    return null;
  }

  const rows = db.prepare(`
    SELECT state, COUNT(*) AS total
    FROM executive_work_nodes
    WHERE graph_id = ?
    GROUP BY state
  `).all(normalizedGraphId);
  const counters = Object.fromEntries(Object.values(EXECUTIVE_WORK_NODE_STATE).map((state) => [state, 0]));
  for (const row of rows) {
    const state = cleanText(row.state);
    if (!NODE_STATE_SET.has(state)) {
      continue;
    }
    counters[state] = Number(row.total || 0);
  }

  const totalNodes = Object.values(counters).reduce((acc, count) => acc + Number(count || 0), 0);
  const mergeNode = getNodeByGraphAndNodeId(normalizedGraphId, graph.merge_node_id);
  const mergeSucceeded = cleanText(mergeNode?.state) === EXECUTIVE_WORK_NODE_STATE.succeeded;
  const hasDeadletter = Number(counters.deadletter || 0) > 0;
  const hasBlocked = Number(counters.blocked || 0) > 0;
  const hasRunning = Number(counters.running || 0) > 0 || Number(counters.claimed || 0) > 0;
  const hasQueued = Number(counters.queued || 0) > 0;
  const allSucceeded = totalNodes > 0 && Number(counters.succeeded || 0) === totalNodes;

  const terminalState = allSucceeded || mergeSucceeded
    ? "completed"
    : hasDeadletter
      ? "deadletter"
      : hasBlocked && !hasQueued && !hasRunning
        ? "blocked"
        : "running";

  return {
    graph,
    counters,
    total_nodes: totalNodes,
    merge_node_id: graph.merge_node_id,
    merge_node_state: mergeNode?.state || null,
    terminal_state: terminalState,
  };
}

export function checkMergeArtifactCompleteness({
  graphId = "",
  mergeNodeId = "",
} = {}) {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  const normalizedMergeNodeId = cleanText(mergeNodeId);
  if (!normalizedGraphId || !normalizedMergeNodeId) {
    return {
      ok: false,
      missing: [{ reason: "missing_graph_or_merge_node" }],
      required_node_ids: [],
      artifacts: [],
    };
  }

  const dependencyRows = db.prepare(`
    SELECT from_node_id
    FROM executive_work_edges
    WHERE graph_id = @graph_id
      AND to_node_id = @to_node_id
      AND dependency = @dependency
    ORDER BY id ASC
  `).all({
    graph_id: normalizedGraphId,
    to_node_id: normalizedMergeNodeId,
    dependency: EXECUTIVE_WORK_EDGE_DEPENDENCY.hard,
  });

  const requiredNodeIds = dependencyRows
    .map((row) => cleanText(row.from_node_id))
    .filter(Boolean);

  const missing = [];
  const artifacts = [];
  for (const requiredNodeId of requiredNodeIds) {
    const node = getNodeByGraphAndNodeId(normalizedGraphId, requiredNodeId);
    if (!node || node.state !== EXECUTIVE_WORK_NODE_STATE.succeeded) {
      missing.push({
        node_id: requiredNodeId,
        reason: "required_node_not_succeeded",
      });
      continue;
    }
    const nodeArtifacts = listExecutiveWorkArtifacts({
      graphId: normalizedGraphId,
      nodeId: requiredNodeId,
    });
    if (!nodeArtifacts.length) {
      missing.push({
        node_id: requiredNodeId,
        reason: "required_artifact_missing",
      });
      continue;
    }
    artifacts.push(...nodeArtifacts);
  }

  return {
    ok: missing.length === 0,
    required_node_ids: requiredNodeIds,
    missing,
    artifacts,
  };
}

export function listExecutiveDeadletters({
  graphId = "",
  limit = 100,
} = {}) {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  const resolvedLimit = normalizePositiveInteger(limit, 100, { min: 1, max: 1000 });

  const rows = normalizedGraphId
    ? db.prepare(`
      SELECT *
      FROM executive_deadletters
      WHERE graph_id = @graph_id
      ORDER BY updated_at DESC, created_at DESC
      LIMIT @limit
    `).all({
      graph_id: normalizedGraphId,
      limit: resolvedLimit,
    })
    : db.prepare(`
      SELECT *
      FROM executive_deadletters
      ORDER BY updated_at DESC, created_at DESC
      LIMIT @limit
    `).all({
      limit: resolvedLimit,
    });

  return rows.map((row) => ({
    id: cleanText(row.id) || null,
    graph_id: cleanText(row.graph_id) || null,
    node_id: cleanText(row.node_id) || null,
    attempt_id: cleanText(row.attempt_id) || null,
    failure_class: cleanText(row.failure_class) || null,
    last_error: cleanText(row.last_error) || null,
    next_manual_action: cleanText(row.next_manual_action) || null,
    replay_count: Number(row.replay_count || 0),
    status: cleanText(row.status) || "open",
    created_at: cleanText(row.created_at) || null,
    updated_at: cleanText(row.updated_at) || null,
    resolved_at: cleanText(row.resolved_at) || null,
  }));
}

export function replayExecutiveDeadletter({
  deadletterId = "",
  operatorId = "",
  reason = "",
} = {}) {
  ensureExecutiveWorkGraphTables();
  const normalizedDeadletterId = cleanText(deadletterId);
  if (!normalizedDeadletterId) {
    return {
      ok: false,
      error: "missing_deadletter_id",
    };
  }

  const replayTx = db.transaction(() => {
    const row = db.prepare(`
      SELECT *
      FROM executive_deadletters
      WHERE id = ?
      LIMIT 1
    `).get(normalizedDeadletterId);

    if (!row) {
      return {
        ok: false,
        error: "deadletter_not_found",
      };
    }

    const now = nowIso();
    const nextReplayCount = Number(row.replay_count || 0) + 1;

    db.prepare(`
      UPDATE executive_deadletters
      SET replay_count = @replay_count,
          status = 'replayed',
          updated_at = @updated_at,
          resolved_at = @resolved_at,
          next_manual_action = @next_manual_action
      WHERE id = @id
    `).run({
      id: normalizedDeadletterId,
      replay_count: nextReplayCount,
      updated_at: now,
      resolved_at: now,
      next_manual_action: cleanText(reason) || cleanText(row.next_manual_action) || "replayed_by_operator",
    });

    db.prepare(`
      UPDATE executive_work_nodes
      SET state = @state,
          next_run_at = @next_run_at,
          updated_at = @updated_at,
          failed_at = NULL
      WHERE graph_id = @graph_id
        AND node_id = @node_id
    `).run({
      graph_id: cleanText(row.graph_id),
      node_id: cleanText(row.node_id),
      state: EXECUTIVE_WORK_NODE_STATE.queued,
      next_run_at: now,
      updated_at: now,
    });

    return {
      ok: true,
      replayed: true,
      deadletter_id: normalizedDeadletterId,
      graph_id: cleanText(row.graph_id),
      node_id: cleanText(row.node_id),
      replay_count: nextReplayCount,
      operator_id: cleanText(operatorId) || null,
      reason: cleanText(reason) || null,
    };
  });

  return replayTx();
}

export function updateExecutiveWorkGraphStatus({
  graphId = "",
  status = "",
} = {}) {
  ensureExecutiveWorkGraphTables();
  const normalizedGraphId = cleanText(graphId);
  const normalizedStatus = cleanText(status);
  if (!normalizedGraphId || !normalizedStatus) {
    return {
      ok: false,
      error: "invalid_graph_status_input",
    };
  }

  const now = nowIso();
  const completedAt = normalizedStatus === "completed" ? now : null;
  const failedAt = normalizedStatus === "failed" || normalizedStatus === "deadletter" ? now : null;
  db.prepare(`
    UPDATE executive_work_graphs
    SET status = @status,
        updated_at = @updated_at,
        started_at = COALESCE(started_at, @started_at),
        completed_at = CASE WHEN @completed_at IS NULL THEN completed_at ELSE @completed_at END,
        failed_at = CASE WHEN @failed_at IS NULL THEN failed_at ELSE @failed_at END
    WHERE graph_id = @graph_id
  `).run({
    graph_id: normalizedGraphId,
    status: normalizedStatus,
    updated_at: now,
    started_at: now,
    completed_at: completedAt,
    failed_at: failedAt,
  });

  return {
    ok: true,
    graph: getExecutiveWorkGraph(normalizedGraphId),
  };
}

export function collectMergeInputArtifacts({
  graphId = "",
  mergeNodeId = "",
} = {}) {
  const gate = checkMergeArtifactCompleteness({
    graphId,
    mergeNodeId,
  });
  if (!gate.ok) {
    return {
      ok: false,
      missing: gate.missing,
      artifacts: gate.artifacts,
    };
  }

  const grouped = new Map();
  for (const artifact of gate.artifacts) {
    const nodeId = cleanText(artifact.node_id);
    if (!nodeId) {
      continue;
    }
    if (!grouped.has(nodeId)) {
      grouped.set(nodeId, []);
    }
    grouped.get(nodeId).push(artifact);
  }

  return {
    ok: true,
    artifacts: gate.artifacts,
    grouped_artifacts: Object.fromEntries(grouped),
  };
}

export function validateNodeInputContract({
  node = null,
  payload = null,
} = {}) {
  const normalizedNode = node && typeof node === "object" && !Array.isArray(node) ? node : null;
  if (!normalizedNode) {
    return {
      ok: false,
      error: "node_missing",
      missing_fields: [],
    };
  }

  const requiredFields = normalizeRequiredFields(normalizedNode?.input_contract?.required_fields || []);
  const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};

  const missingFields = [];
  for (const field of requiredFields) {
    const value = normalizedPayload[field];
    if (value === undefined || value === null || value === "") {
      missingFields.push(field);
    }
  }

  return {
    ok: missingFields.length === 0,
    error: missingFields.length ? "missing_required_fields" : null,
    missing_fields: missingFields,
  };
}

export function isToolAllowedForNode({
  node = null,
  action = "",
} = {}) {
  const normalizedAction = cleanText(action);
  const allowedTools = normalizeAllowedTools(node?.allowed_tools || []);
  if (!normalizedAction) {
    return true;
  }
  if (!allowedTools.length) {
    return true;
  }
  return allowedTools.includes(normalizedAction);
}

export function hasLeaseExpired({
  leaseExpiresAt = "",
  nowAt = "",
} = {}) {
  const expiryMs = parseIsoToMs(leaseExpiresAt);
  const nowMs = parseIsoToMs(nowAt) ?? Date.now();
  if (expiryMs == null) {
    return true;
  }
  return expiryMs <= nowMs;
}
