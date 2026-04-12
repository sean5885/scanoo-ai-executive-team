import { cleanText } from "./message-intent-utils.mjs";
import { createDecisionPromotionAuditState } from "./decision-engine-promotion.mjs";
import {
  PROMOTION_CONTROL_SURFACE_ALLOWED_ACTIONS,
  resolvePromotionActionPolicy,
  resolvePromotionControlSurface,
} from "./promotion-control-surface.mjs";

export const DECISION_METRICS_SCOREBOARD_VERSION = "decision_metrics_scoreboard_v1";

const MATURITY_HIGH = "high";
const MATURITY_MEDIUM = "medium";
const MATURITY_LOW = "low";
const MATURITY_SET = new Set([
  MATURITY_HIGH,
  MATURITY_MEDIUM,
  MATURITY_LOW,
]);

function toObject(value = null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function toArray(value = null) {
  return Array.isArray(value)
    ? value
    : [];
}

function normalizeAction(value = "") {
  const normalized = cleanText(value || "");
  return PROMOTION_CONTROL_SURFACE_ALLOWED_ACTIONS.includes(normalized)
    ? normalized
    : null;
}

function normalizeActionMetrics(metrics = null) {
  const normalized = toObject(metrics) || {};
  const normalizeCount = (value) => Number.isFinite(Number(value))
    ? Math.max(0, Number(value))
    : 0;
  return {
    promotion_applied_count: normalizeCount(normalized.promotion_applied_count),
    exact_match_count: normalizeCount(normalized.exact_match_count),
    acceptable_divergence_count: normalizeCount(normalized.acceptable_divergence_count),
    hard_divergence_count: normalizeCount(normalized.hard_divergence_count),
    effective_count: normalizeCount(normalized.effective_count),
    ineffective_count: normalizeCount(normalized.ineffective_count),
    rollback_flag_count: normalizeCount(normalized.rollback_flag_count),
  };
}

function buildFallbackActionMetricsFromObservability({
  action_name = "",
  observability = null,
} = {}) {
  const actionName = normalizeAction(action_name);
  const normalizedObservability = toObject(observability) || {};
  if (!actionName) {
    return normalizeActionMetrics();
  }
  const alignment = toObject(normalizedObservability.advisor_alignment)
    || toObject(normalizedObservability.advisor_vs_actual)
    || null;
  const alignmentAction = cleanText(alignment?.advisor_action || alignment?.recommended_next_action || "");
  const alignmentType = cleanText(alignment?.alignment_type || "");
  const decisionPromotion = toObject(normalizedObservability.decision_promotion) || {};
  const promotedAction = cleanText(decisionPromotion.promoted_action || "");
  const promotionApplied = decisionPromotion.promotion_applied === true;
  const audit = toObject(normalizedObservability.promotion_audit) || {};
  const auditAction = cleanText(audit.promoted_action || "");
  const effectiveness = cleanText(audit.promotion_effectiveness || "");
  const rollbackFlag = audit.rollback_flag === true;
  return {
    promotion_applied_count: promotedAction === actionName && promotionApplied ? 1 : 0,
    exact_match_count: alignmentAction === actionName && alignmentType === "exact_match" ? 1 : 0,
    acceptable_divergence_count: alignmentAction === actionName && alignmentType === "acceptable_divergence" ? 1 : 0,
    hard_divergence_count: alignmentAction === actionName && alignmentType === "hard_divergence" ? 1 : 0,
    effective_count: auditAction === actionName && effectiveness === "effective" ? 1 : 0,
    ineffective_count: auditAction === actionName && effectiveness === "ineffective" ? 1 : 0,
    rollback_flag_count: auditAction === actionName && rollbackFlag ? 1 : 0,
  };
}

function resolveMaturitySignal({
  metrics = null,
  promotion_enabled = false,
  current_rollback_disabled = false,
  ineffective_threshold = 3,
} = {}) {
  const normalizedMetrics = normalizeActionMetrics(metrics);
  const sampleCount = normalizedMetrics.exact_match_count
    + normalizedMetrics.acceptable_divergence_count
    + normalizedMetrics.hard_divergence_count;
  const promotionAppliedCount = normalizedMetrics.promotion_applied_count;
  const hasEvidence = sampleCount > 0 || promotionAppliedCount > 0;
  const highMinPromotionAppliedCount = Math.max(3, Number.isFinite(Number(ineffective_threshold))
    ? Number(ineffective_threshold)
    : 3);
  const highMinEffectiveMargin = 2;
  const highMaxHardDivergence = 1;

  if (!hasEvidence) {
    return MATURITY_LOW;
  }
  if (
    !promotion_enabled
    || current_rollback_disabled
    || normalizedMetrics.rollback_flag_count > 0
    || normalizedMetrics.ineffective_count > normalizedMetrics.effective_count
    || normalizedMetrics.hard_divergence_count >= 3
  ) {
    return MATURITY_LOW;
  }
  if (
    promotionAppliedCount >= highMinPromotionAppliedCount
    && normalizedMetrics.effective_count >= (normalizedMetrics.ineffective_count + highMinEffectiveMargin)
    && normalizedMetrics.rollback_flag_count === 0
    && normalizedMetrics.hard_divergence_count <= highMaxHardDivergence
  ) {
    return MATURITY_HIGH;
  }
  if (promotionAppliedCount >= 1 || sampleCount >= 3) {
    return MATURITY_MEDIUM;
  }
  return MATURITY_LOW;
}

function normalizeActionOrder(actionNames = []) {
  const seen = new Set();
  const ordered = [];
  for (const baseAction of PROMOTION_CONTROL_SURFACE_ALLOWED_ACTIONS) {
    if (!seen.has(baseAction)) {
      seen.add(baseAction);
      ordered.push(baseAction);
    }
  }
  const extras = [];
  for (const actionName of toArray(actionNames)) {
    const normalized = normalizeAction(actionName);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    extras.push(normalized);
  }
  extras.sort((left, right) => left.localeCompare(right));
  return ordered.concat(extras);
}

function formatActionList(values = []) {
  const normalized = toArray(values)
    .map((value) => cleanText(value))
    .filter(Boolean);
  return normalized.length > 0
    ? `[${normalized.join(", ")}]`
    : "[]";
}

function buildFailClosedScoreboard({
  reason_code = "malformed_metrics_input",
} = {}) {
  const reasonCode = cleanText(reason_code || "") || "malformed_metrics_input";
  return {
    scoreboard_version: DECISION_METRICS_SCOREBOARD_VERSION,
    actions: [],
    summary: {
      scoreboard_version: DECISION_METRICS_SCOREBOARD_VERSION,
      fail_closed: true,
      reason_code: reasonCode,
      total_actions: 0,
      high_maturity_count: 0,
      medium_maturity_count: 0,
      low_maturity_count: 0,
      highest_maturity_actions: [],
      high_risk_actions: [],
      rollback_disabled_actions: [],
    },
    highest_maturity_actions: [],
    rollback_disabled_actions: [],
    fail_closed: true,
    reason_code: reasonCode,
  };
}

export function buildDecisionMetricsScoreboard({
  promotion_audit_state = null,
  promotion_policy = null,
  observability = null,
} = {}) {
  const malformedStateInput = promotion_audit_state !== null
    && promotion_audit_state !== undefined
    && !toObject(promotion_audit_state);
  const malformedObservabilityInput = observability !== null
    && observability !== undefined
    && !toObject(observability);
  if (malformedStateInput || malformedObservabilityInput) {
    return buildFailClosedScoreboard({
      reason_code: "malformed_metrics_input",
    });
  }

  const normalizedPolicy = resolvePromotionControlSurface({
    promotion_policy,
  });
  const normalizedState = createDecisionPromotionAuditState(promotion_audit_state);
  const normalizedObservability = toObject(observability) || {};
  const actionCandidates = new Set([
    ...PROMOTION_CONTROL_SURFACE_ALLOWED_ACTIONS,
  ]);
  for (const actionName of Object.keys(toObject(normalizedState.actions) || {})) {
    const normalized = normalizeAction(actionName);
    if (normalized) {
      actionCandidates.add(normalized);
    }
  }
  for (const actionName of toArray(normalizedPolicy.rollback_disabled_actions)) {
    const normalized = normalizeAction(actionName);
    if (normalized) {
      actionCandidates.add(normalized);
    }
  }
  const alignment = toObject(normalizedObservability.advisor_alignment)
    || toObject(normalizedObservability.advisor_vs_actual)
    || null;
  const observedActionCandidates = [
    cleanText(alignment?.advisor_action || alignment?.recommended_next_action || ""),
    cleanText(normalizedObservability?.decision_promotion?.promoted_action || ""),
    cleanText(normalizedObservability?.promotion_audit?.promoted_action || ""),
  ];
  for (const actionName of observedActionCandidates) {
    const normalized = normalizeAction(actionName);
    if (normalized) {
      actionCandidates.add(normalized);
    }
  }
  const orderedActions = normalizeActionOrder(Array.from(actionCandidates));
  const useFallbackMetrics = !(promotion_audit_state && toObject(promotion_audit_state));
  const entries = orderedActions.map((actionName) => {
    const actionPolicy = resolvePromotionActionPolicy({
      policy: normalizedPolicy,
      action: actionName,
    });
    const stateAction = toObject(normalizedState.actions?.[actionName]) || {};
    const stateMetrics = normalizeActionMetrics(stateAction.metrics);
    const fallbackMetrics = useFallbackMetrics
      ? buildFallbackActionMetricsFromObservability({
          action_name: actionName,
          observability: normalizedObservability,
        })
      : normalizeActionMetrics();
    const mergedMetrics = {
      promotion_applied_count: stateMetrics.promotion_applied_count + fallbackMetrics.promotion_applied_count,
      exact_match_count: stateMetrics.exact_match_count + fallbackMetrics.exact_match_count,
      acceptable_divergence_count: stateMetrics.acceptable_divergence_count + fallbackMetrics.acceptable_divergence_count,
      hard_divergence_count: stateMetrics.hard_divergence_count + fallbackMetrics.hard_divergence_count,
      effective_count: stateMetrics.effective_count + fallbackMetrics.effective_count,
      ineffective_count: stateMetrics.ineffective_count + fallbackMetrics.ineffective_count,
      rollback_flag_count: stateMetrics.rollback_flag_count + fallbackMetrics.rollback_flag_count,
    };
    const currentRollbackDisabled = actionPolicy.rollback_disabled === true
      || stateAction.promotion_disabled === true;
    const promotionEnabled = actionPolicy.promotion_allowed === true && !currentRollbackDisabled;
    const maturitySignal = resolveMaturitySignal({
      metrics: mergedMetrics,
      promotion_enabled: promotionEnabled,
      current_rollback_disabled: currentRollbackDisabled,
      ineffective_threshold: normalizedPolicy.ineffective_threshold,
    });
    return {
      action_name: actionName,
      promotion_enabled: promotionEnabled,
      promotion_applied_count: mergedMetrics.promotion_applied_count,
      exact_match_count: mergedMetrics.exact_match_count,
      acceptable_divergence_count: mergedMetrics.acceptable_divergence_count,
      hard_divergence_count: mergedMetrics.hard_divergence_count,
      effective_count: mergedMetrics.effective_count,
      ineffective_count: mergedMetrics.ineffective_count,
      rollback_flag_count: mergedMetrics.rollback_flag_count,
      current_rollback_disabled: currentRollbackDisabled,
      maturity_signal: MATURITY_SET.has(maturitySignal) ? maturitySignal : MATURITY_LOW,
      scoreboard_version: DECISION_METRICS_SCOREBOARD_VERSION,
    };
  });
  const highestMaturityActions = entries
    .filter((entry) => entry.maturity_signal === MATURITY_HIGH)
    .map((entry) => entry.action_name);
  const mediumMaturityActions = entries
    .filter((entry) => entry.maturity_signal === MATURITY_MEDIUM)
    .map((entry) => entry.action_name);
  const lowMaturityActions = entries
    .filter((entry) => entry.maturity_signal === MATURITY_LOW)
    .map((entry) => entry.action_name);
  const rollbackDisabledActions = entries
    .filter((entry) => entry.current_rollback_disabled)
    .map((entry) => entry.action_name);
  const highRiskActions = Array.from(new Set([
    ...lowMaturityActions,
    ...rollbackDisabledActions,
  ]));
  return {
    scoreboard_version: DECISION_METRICS_SCOREBOARD_VERSION,
    actions: entries,
    summary: {
      scoreboard_version: DECISION_METRICS_SCOREBOARD_VERSION,
      fail_closed: false,
      reason_code: null,
      total_actions: entries.length,
      high_maturity_count: highestMaturityActions.length,
      medium_maturity_count: mediumMaturityActions.length,
      low_maturity_count: lowMaturityActions.length,
      highest_maturity_actions: highestMaturityActions,
      high_risk_actions: highRiskActions,
      rollback_disabled_actions: rollbackDisabledActions,
    },
    highest_maturity_actions: highestMaturityActions,
    rollback_disabled_actions: rollbackDisabledActions,
    fail_closed: false,
    reason_code: null,
  };
}

export function formatDecisionMetricsScoreboardSummary(scoreboard = null) {
  const normalized = toObject(scoreboard);
  if (!normalized) {
    return `version=${DECISION_METRICS_SCOREBOARD_VERSION} fail_closed=true reason_code=malformed_metrics_input high=[] medium=[] low=[] rollback_disabled=[] high_risk=[]`;
  }
  const summary = toObject(normalized.summary) || {};
  const version = cleanText(summary.scoreboard_version || normalized.scoreboard_version || "")
    || DECISION_METRICS_SCOREBOARD_VERSION;
  const failClosed = summary.fail_closed === true || normalized.fail_closed === true;
  const reasonCode = cleanText(summary.reason_code || normalized.reason_code || "") || "none";
  const highestMaturityActions = toArray(summary.highest_maturity_actions || normalized.highest_maturity_actions);
  const rollbackDisabledActions = toArray(summary.rollback_disabled_actions || normalized.rollback_disabled_actions);
  const highRiskActions = toArray(summary.high_risk_actions);
  const actions = toArray(normalized.actions);
  const mediumActions = actions
    .filter((entry) => cleanText(entry?.maturity_signal || "") === MATURITY_MEDIUM)
    .map((entry) => cleanText(entry?.action_name || ""))
    .filter(Boolean);
  const lowActions = actions
    .filter((entry) => cleanText(entry?.maturity_signal || "") === MATURITY_LOW)
    .map((entry) => cleanText(entry?.action_name || ""))
    .filter(Boolean);
  return `version=${version} fail_closed=${failClosed ? "true" : "false"} reason_code=${reasonCode} high=${formatActionList(highestMaturityActions)} medium=${formatActionList(mediumActions)} low=${formatActionList(lowActions)} rollback_disabled=${formatActionList(rollbackDisabledActions)} high_risk=${formatActionList(highRiskActions)}`;
}
