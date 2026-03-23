import { cleanText } from "./message-intent-utils.mjs";
import { ROUTING_NO_MATCH } from "./planner-error-codes.mjs";

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

function normalizePlannerFlowPriority(flow = null) {
  return Number.isFinite(flow?.priority) ? Number(flow.priority) : 0;
}

function normalizePlannerFlowKeywords(flow = null) {
  if (!Array.isArray(flow?.matchKeywords)) {
    return [];
  }
  return flow.matchKeywords
    .map((keyword) => cleanText(String(keyword || "").toLowerCase()))
    .filter(Boolean);
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

function countPlannerFlowKeywordHits(userIntent = "", keywords = []) {
  const normalizedIntent = cleanText(String(userIntent || "").toLowerCase());
  if (!normalizedIntent || !Array.isArray(keywords) || keywords.length === 0) {
    return 0;
  }

  return keywords.reduce((count, keyword) => (
    normalizedIntent.includes(keyword) ? count + 1 : count
  ), 0);
}

function comparePlannerFlowCandidates(left = null, right = null) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  if ((right.priority || 0) !== (left.priority || 0)) {
    return (right.priority || 0) > (left.priority || 0) ? right : left;
  }

  if ((right.keywordHitCount || 0) !== (left.keywordHitCount || 0)) {
    return (right.keywordHitCount || 0) > (left.keywordHitCount || 0) ? right : left;
  }

  return (right.index || 0) < (left.index || 0) ? right : left;
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
} = {}) {
  let bestCandidate = null;

  for (const [index, flow] of normalizePlannerFlows(flows).entries()) {
    const context = flow.readContext?.() || {};
    const route = flow.route?.({
      userIntent,
      payload: normalizePlannerPayload(payload),
      context,
      logger,
    });
    const routeDecision = normalizePlannerRouteDecision(route);
    if (routeDecision.target) {
      bestCandidate = comparePlannerFlowCandidates(bestCandidate, {
        flow,
        action: routeDecision.action || routeDecision.target,
        preset: routeDecision.preset || "",
        routeDecision,
        payload: normalizePlannerPayload(route.payload),
        context,
        priority: normalizePlannerFlowPriority(flow),
        keywordHitCount: countPlannerFlowKeywordHits(userIntent, normalizePlannerFlowKeywords(flow)),
        index,
      });
    }
  }

  if (bestCandidate) {
    return {
      flow: bestCandidate.flow,
      action: bestCandidate.action,
      ...(bestCandidate.preset ? { preset: bestCandidate.preset } : {}),
      selected_target: bestCandidate.routeDecision?.target || bestCandidate.action || null,
      target_kind: cleanText(bestCandidate.routeDecision?.target_kind || "")
        || (bestCandidate.preset ? "preset" : bestCandidate.action ? "action" : "error"),
      routing_reason: cleanText(bestCandidate.routeDecision?.routing_reason || "") || "routing_no_match",
      payload: bestCandidate.payload,
      context: bestCandidate.context,
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
} = {}) {
  if (!flow?.shapePayload) {
    return normalizePlannerPayload(payload);
  }

  return normalizePlannerPayload(flow.shapePayload({
    action,
    userIntent,
    payload: normalizePlannerPayload(payload),
    context: flow.readContext?.() || {},
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
    context: flow.readContext?.() || {},
    logger,
    ...rest,
  });
}

export function syncPlannerFlowContext({
  flow = null,
  selectedAction = "",
  executionResult = null,
  logger = console,
} = {}) {
  if (!flow?.writeContext) {
    return null;
  }
  return flow.writeContext({
    selectedAction,
    executionResult,
    logger,
  });
}

export function resetPlannerFlowContexts(flows = []) {
  for (const flow of normalizePlannerFlows(flows)) {
    flow.resetContext?.();
  }
}
