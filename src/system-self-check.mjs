import { listRegisteredAgents, knowledgeAgentSubcommands } from "./agent-registry.mjs";
import { getAllowedMethodsForPath } from "./http-route-contracts.mjs";

const REQUIRED_AGENT_IDS = [
  "generalist",
  "ceo",
  "product",
  "prd",
  "cmo",
  "consult",
  "cdo",
  "knowledge-audit",
  "knowledge-consistency",
  "knowledge-conflicts",
  "knowledge-distill",
  "knowledge-brain",
  "knowledge-proposals",
  "knowledge-approve",
  "knowledge-reject",
  "knowledge-ownership",
  "knowledge-learn",
];

const REQUIRED_HTTP_PATHS = [
  "/api/messages/reply",
  "/api/doc/create",
  "/api/doc/update",
  "/api/meeting/process",
  "/api/meeting/confirm",
  "/api/drive/organize/preview",
  "/api/drive/organize/apply",
  "/api/wiki/organize/preview",
  "/api/wiki/organize/apply",
  "/api/bitable/apps/test-app/tables/test-table/records",
  "/api/bitable/apps/test-app/tables/test-table/records/create",
  "/api/bitable/apps/test-app/tables/test-table/records/test-record",
  "/api/bitable/apps/test-app/tables/test-table/records/search",
  "/api/calendar/events/create",
  "/api/calendar/freebusy",
  "/api/tasks/create",
  "/api/tasks/test-task",
  "/api/tasks/test-task/comments",
  "/api/tasks/test-task/comments/test-comment",
  "/agent/improvements",
  "/agent/improvements/test-proposal/approve",
  "/agent/improvements/test-proposal/reject",
  "/agent/improvements/test-proposal/apply",
  "/agent/tasks",
];

const REQUIRED_SERVICE_MODULES = [
  "./agent-dispatcher.mjs",
  "./meeting-agent.mjs",
  "./image-understanding-service.mjs",
  "./lane-executor.mjs",
  "./executive-orchestrator.mjs",
];

function validateAgentContract(agent) {
  const contract = agent?.contract || {};
  const issues = [];
  if (!agent?.id) {
    issues.push("missing_agent_id");
  }
  if (!contract.trigger) {
    issues.push("missing_trigger");
  }
  if (!contract.expected_input_schema || typeof contract.expected_input_schema !== "object") {
    issues.push("missing_expected_input_schema");
  }
  if (!contract.expected_output_schema || typeof contract.expected_output_schema !== "object") {
    issues.push("missing_expected_output_schema");
  }
  if (!Array.isArray(contract.allowed_tools) || !contract.allowed_tools.length) {
    issues.push("missing_allowed_tools");
  }
  if (!contract.downstream_consumer) {
    issues.push("missing_downstream_consumer");
  }
  if (!contract.fallback_behavior) {
    issues.push("missing_fallback_behavior");
  }
  if (!contract.status) {
    issues.push("missing_status");
  }
  return issues;
}

export async function runSystemSelfCheck() {
  const agents = listRegisteredAgents();
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));

  const missingAgents = REQUIRED_AGENT_IDS.filter((id) => !agentMap.has(id));
  const invalidContracts = agents
    .map((agent) => ({
      agent_id: agent.id,
      issues: validateAgentContract(agent),
    }))
    .filter((item) => item.issues.length > 0);

  const missingKnowledgeSubcommands = [
    "audit",
    "consistency",
    "conflicts",
    "distill",
    "brain",
    "proposals",
    "approve",
    "reject",
    "ownership",
    "learn",
  ].filter((item) => !knowledgeAgentSubcommands.includes(item));

  const routeCoverage = REQUIRED_HTTP_PATHS.map((pathname) => ({
    pathname,
    methods: getAllowedMethodsForPath(pathname) || [],
  }));
  const missingRoutes = routeCoverage.filter((item) => item.methods.length === 0).map((item) => item.pathname);

  const serviceInitialization = [];
  for (const modulePath of REQUIRED_SERVICE_MODULES) {
    try {
      await import(modulePath);
      serviceInitialization.push({ module: modulePath, ok: true });
    } catch (error) {
      serviceInitialization.push({
        module: modulePath,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ok =
    missingAgents.length === 0 &&
    invalidContracts.length === 0 &&
    missingKnowledgeSubcommands.length === 0 &&
    missingRoutes.length === 0 &&
    serviceInitialization.every((item) => item.ok);

  return {
    ok,
    agents: {
      total: agents.length,
      missing: missingAgents,
      invalid_contracts: invalidContracts,
      knowledge_subcommands_missing: missingKnowledgeSubcommands,
    },
    routes: {
      checked: routeCoverage,
      missing: missingRoutes,
    },
    services: serviceInitialization,
  };
}
