import { cleanText } from "./message-intent-utils.mjs";
import { ROUTING_NO_MATCH } from "./planner-error-codes.mjs";

const COMPANY_BRAIN_DOC_FAMILY = "company_brain_doc";
const THEMED_DOC_FLOW_CONTRACT = "single_owner_theme";
const GENERIC_DOC_FLOW_CONTRACT = "generic_owner";
const SINGLE_OWNER_CONTRACT = "single_owner";

function normalizePlannerFlow(flow = null) {
  if (!flow || typeof flow !== "object") {
    return null;
  }
  const id = cleanText(flow.id);
  if (!id) {
    return null;
  }
  return flow;
}

function normalizePlannerFlows(flows = []) {
  if (!Array.isArray(flows)) {
    return [];
  }
  return flows.map((flow) => normalizePlannerFlow(flow)).filter(Boolean);
}

function normalizePlannerPayload(payload = {}) {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload } : {};
}

function normalizePlannerRouteDecision(route = null) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    return {
      action: "",
      preset: "",
      error: "",
      target: "",
      target_kind: "error",
      routing_reason: "routing_no_match",
    };
  }

  const action = cleanText(route.action);
  const preset = cleanText(route.preset);
  const error = cleanText(route.error);
  const target = cleanText(route.selected_target || action || preset);
  const targetKind = cleanText(route.target_kind || "")
    || (action ? "action" : preset ? "preset" : "error");
  return {
    action,
    preset,
    error,
    target,
    target_kind: targetKind || "error",
    routing_reason: cleanText(route.routing_reason || "") || "routing_no_match",
  };
}

function normalizePlannerFlowOwnership(flow = null) {
  if (!flow?.ownership || typeof flow.ownership !== "object" || Array.isArray(flow.ownership)) {
    return {
      family: null,
      contract: null,
      domain: null,
      overlap_owner: null,
    };
  }
  return {
    family: cleanText(flow.ownership.family) || null,
    contract: cleanText(flow.ownership.contract) || null,
    domain: cleanText(flow.ownership.domain) || null,
    overlap_owner: cleanText(flow.ownership.overlap_owner) || null,
  };
}

export function getPlannerFlowOwnership(flow = null) {
  return normalizePlannerFlowOwnership(flow);
}

function buildPlannerSyntheticDocSearchPayload(userIntent = "", payload = {}) {
  const normalizedPayload = normalizePlannerPayload(payload);
  const normalizedIntent = cleanText(String(userIntent || ""));
  if (!cleanText(normalizedPayload.q) && normalizedIntent) {
    normalizedPayload.q = normalizedIntent;
  }
  if (!cleanText(normalizedPayload.query) && normalizedIntent) {
    normalizedPayload.query = normalizedIntent;
  }
  return normalizedPayload;
}

function buildPlannerSyntheticDocOverlapCandidate({
  evaluations = [],
  userIntent = "",
  payload = {},
} = {}) {
  const docQueryEvaluation = evaluations.find((evaluation) => cleanText(evaluation?.flow?.id) === "doc_query");
  if (!docQueryEvaluation) {
    return null;
  }
  return {
    ...docQueryEvaluation,
    action: "search_company_brain_docs",
    preset: "",
    routeDecision: {
      action: "search_company_brain_docs",
      preset: "",
      error: "",
      target: "search_company_brain_docs",
      target_kind: "action",
      routing_reason: "selector_search_company_brain_docs",
    },
    payload: buildPlannerSyntheticDocSearchPayload(userIntent, payload),
    synthetic_owner_resolution: "themed_overlap_fallback",
  };
}

function resolveCompanyBrainDocFamilyCandidate({
  evaluations = [],
  routedEvaluations = [],
  userIntent = "",
  payload = {},
} = {}) {
  const themedCandidates = routedEvaluations.filter(
    (evaluation) => evaluation.ownership.contract === THEMED_DOC_FLOW_CONTRACT,
  );
  const genericCandidate = routedEvaluations.find(
    (evaluation) => evaluation.ownership.contract === GENERIC_DOC_FLOW_CONTRACT,
  );

  if (themedCandidates.length === 1) {
    return themedCandidates[0];
  }
  if (themedCandidates.length > 1) {
    return genericCandidate || buildPlannerSyntheticDocOverlapCandidate({
      evaluations,
      userIntent,
      payload,
    });
  }
  if (genericCandidate) {
    return genericCandidate;
  }
  return routedEvaluations[0] || null;
}

function selectPlannerFlowCandidate({
  evaluations = [],
  userIntent = "",
  payload = {},
} = {}) {
  const routedEvaluations = evaluations.filter((evaluation) => cleanText(evaluation?.routeDecision?.target));
  if (routedEvaluations.length === 0) {
    return null;
  }
  if (routedEvaluations.length === 1) {
    return routedEvaluations[0];
  }

  const singleOwnerCandidate = routedEvaluations.find(
    (evaluation) => evaluation.ownership.contract === SINGLE_OWNER_CONTRACT,
  );
  if (singleOwnerCandidate) {
    return singleOwnerCandidate;
  }

  const companyBrainDocCandidates = routedEvaluations.filter(
    (evaluation) => evaluation.ownership.family === COMPANY_BRAIN_DOC_FAMILY,
  );
  if (companyBrainDocCandidates.length > 0) {
    return resolveCompanyBrainDocFamilyCandidate({
      evaluations,
      routedEvaluations: companyBrainDocCandidates,
      userIntent,
      payload,
    });
  }

  return routedEvaluations[0];
}

export function createPlannerFlow(flow = {}) {
  return normalizePlannerFlow(flow);
}

export function getPlannerFlowForAction(flows = [], action = "") {
  const normalizedAction = cleanText(action);
  return normalizePlannerFlows(flows).find((flow) => flow.supportsAction?.(normalizedAction)) || null;
}

export function resolvePlannerFlowRoute({
  flows = [],
  userIntent = "",
  payload = {},
  logger = console,
  sessionKey = "",
} = {}) {
  const evaluations = [];

  for (const [index, flow] of normalizePlannerFlows(flows).entries()) {
    const context = flow.readContext?.({ sessionKey }) || {};
    const route = flow.route?.({
      userIntent,
      payload: normalizePlannerPayload(payload),
      context,
      logger,
    });
    const routeDecision = normalizePlannerRouteDecision(route);
    evaluations.push({
      flow,
      action: routeDecision.action || routeDecision.target,
      preset: routeDecision.preset || "",
      routeDecision,
      payload: normalizePlannerPayload(route.payload),
      context,
      ownership: normalizePlannerFlowOwnership(flow),
      index,
    });
  }

  const selectedCandidate = selectPlannerFlowCandidate({
    evaluations,
    userIntent,
    payload,
  });

  if (selectedCandidate) {
    return {
      flow: selectedCandidate.flow,
      action: selectedCandidate.action,
      ...(selectedCandidate.preset ? { preset: selectedCandidate.preset } : {}),
      selected_target: selectedCandidate.routeDecision?.target || selectedCandidate.action || null,
      target_kind: cleanText(selectedCandidate.routeDecision?.target_kind || "")
        || (selectedCandidate.preset ? "preset" : selectedCandidate.action ? "action" : "error"),
      routing_reason: cleanText(selectedCandidate.routeDecision?.routing_reason || "") || "routing_no_match",
      payload: selectedCandidate.payload,
      context: selectedCandidate.context,
    };
  }

  return {
    flow: null,
    action: null,
    selected_target: null,
    target_kind: "error",
    routing_reason: "routing_no_match",
    payload: normalizePlannerPayload(payload),
    context: null,
    error: ROUTING_NO_MATCH,
  };
}

export function buildPlannerFlowPayload({
  flow = null,
  action = "",
  userIntent = "",
  payload = {},
  logger = console,
  sessionKey = "",
} = {}) {
  if (!flow?.shapePayload) {
    return normalizePlannerPayload(payload);
  }

  return normalizePlannerPayload(flow.shapePayload({
    action,
    userIntent,
    payload: normalizePlannerPayload(payload),
    context: flow.readContext?.({ sessionKey }) || {},
    logger,
  }));
}

export async function formatPlannerFlowResult({
  flow = null,
  selectedAction = "",
  executionResult = null,
  userIntent = "",
  payload = {},
  logger = console,
  sessionKey = "",
  ...rest
} = {}) {
  if (!flow?.formatResult) {
    return executionResult;
  }

  return flow.formatResult({
    selectedAction,
    executionResult,
    userIntent,
    payload: normalizePlannerPayload(payload),
    context: flow.readContext?.({ sessionKey }) || {},
    logger,
    sessionKey,
    ...rest,
  });
}

export function syncPlannerFlowContext({
  flow = null,
  selectedAction = "",
  executionResult = null,
  logger = console,
  sessionKey = "",
} = {}) {
  if (!flow?.writeContext) {
    return null;
  }
  return flow.writeContext({
    selectedAction,
    executionResult,
    logger,
    sessionKey,
  });
}

export function resetPlannerFlowContexts(flows = [], { sessionKey = "" } = {}) {
  for (const flow of normalizePlannerFlows(flows)) {
    flow.resetContext?.({ sessionKey });
  }
}
