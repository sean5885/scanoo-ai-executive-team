import { cleanText } from "./message-intent-utils.mjs";

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
    if (route?.action) {
      bestCandidate = comparePlannerFlowCandidates(bestCandidate, {
        flow,
        action: cleanText(route.action),
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
      payload: bestCandidate.payload,
      context: bestCandidate.context,
    };
  }

  return {
    flow: null,
    action: null,
    payload: normalizePlannerPayload(payload),
    context: null,
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
