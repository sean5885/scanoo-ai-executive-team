import { cleanText } from "./message-intent-utils.mjs";

export const PROMOTION_CONTROL_SURFACE_VERSION = "promotion_control_surface_v1";
export const PROMOTION_CONTROL_SURFACE_FAIL_CLOSED_VERSION = "promotion_control_surface_v1_fail_closed";
export const PROMOTION_CONTROL_SURFACE_ALL_ACTIONS = Object.freeze([
  "proceed",
  "ask_user",
  "retry",
  "reroute",
  "rollback",
  "skip",
  "fail",
]);
export const PROMOTION_CONTROL_SURFACE_ALLOWED_ACTIONS = Object.freeze([
  "ask_user",
  "retry",
  "reroute",
  "fail",
]);
export const PROMOTION_CONTROL_SURFACE_DENIED_ACTIONS = Object.freeze(
  PROMOTION_CONTROL_SURFACE_ALL_ACTIONS.filter((action) => !PROMOTION_CONTROL_SURFACE_ALLOWED_ACTIONS.includes(action)),
);
export const PROMOTION_CONTROL_SURFACE_INEFFECTIVE_THRESHOLD = 3;
export const PROMOTION_CONTROL_SURFACE_POLICY_REASON_CODES = Object.freeze([
  "policy_allow_list",
  "policy_deny_list",
  "policy_rollback_disabled",
  "policy_requires_exact_match",
  "policy_requires_complete_evidence",
  "policy_requires_retry_worthiness",
  "policy_requires_no_blocking_readiness",
  "policy_requires_owner_mismatch_or_capability_gap",
  "policy_requires_no_blocking_dependency",
  "policy_requires_no_invalid_artifact",
  "policy_requires_recovery_safe",
  "policy_malformed_fail_closed",
]);

const ACTION_NOTES = Object.freeze({
  proceed: "advisory_only_v1",
  ask_user: "allowed_v1_low_risk_fail_soft",
  retry: "allowed_v1_conditional_retry",
  reroute: "allowed_v2_conditional_reroute_bounded",
  rollback: "advisory_only_v1",
  skip: "advisory_only_v1",
  fail: "allowed_v1_fail_closed_boundary",
});

const ACTION_POLICY_REQUIREMENTS = Object.freeze({
  ask_user: Object.freeze({
    requires_exact_match: true,
    requires_complete_evidence: true,
    requires_retry_worthiness: false,
    requires_no_blocking_readiness: false,
    requires_owner_mismatch_or_capability_gap: false,
    requires_no_blocking_dependency: false,
    requires_no_invalid_artifact: false,
    requires_recovery_safe: false,
  }),
  retry: Object.freeze({
    requires_exact_match: true,
    requires_complete_evidence: true,
    requires_retry_worthiness: true,
    requires_no_blocking_readiness: true,
    requires_owner_mismatch_or_capability_gap: false,
    requires_no_blocking_dependency: false,
    requires_no_invalid_artifact: false,
    requires_recovery_safe: false,
  }),
  reroute: Object.freeze({
    requires_exact_match: true,
    requires_complete_evidence: true,
    requires_retry_worthiness: false,
    requires_no_blocking_readiness: false,
    requires_owner_mismatch_or_capability_gap: true,
    requires_no_blocking_dependency: true,
    requires_no_invalid_artifact: true,
    requires_recovery_safe: true,
  }),
  fail: Object.freeze({
    requires_exact_match: true,
    requires_complete_evidence: true,
    requires_retry_worthiness: false,
    requires_no_blocking_readiness: false,
    requires_owner_mismatch_or_capability_gap: false,
    requires_no_blocking_dependency: false,
    requires_no_invalid_artifact: false,
    requires_recovery_safe: false,
  }),
});

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
  return PROMOTION_CONTROL_SURFACE_ALL_ACTIONS.includes(normalized)
    ? normalized
    : null;
}

function normalizeReasonCode(value = "") {
  const normalized = cleanText(value || "");
  return normalized || null;
}

function uniqueStrings(values = []) {
  return Array.from(new Set(
    toArray(values)
      .map((item) => cleanText(item))
      .filter(Boolean),
  ));
}

function parseActionList(values = []) {
  const parsed = [];
  let malformed = false;
  for (const rawValue of toArray(values)) {
    const normalized = normalizeAction(rawValue);
    if (!normalized) {
      malformed = true;
      continue;
    }
    if (!parsed.includes(normalized)) {
      parsed.push(normalized);
    }
  }
  return {
    actions: parsed,
    malformed,
  };
}

function parseThreshold(value = null) {
  if (value === null || value === undefined || value === "") {
    return {
      value: PROMOTION_CONTROL_SURFACE_INEFFECTIVE_THRESHOLD,
      malformed: false,
    };
  }
  if (!Number.isFinite(Number(value))) {
    return {
      value: PROMOTION_CONTROL_SURFACE_INEFFECTIVE_THRESHOLD,
      malformed: true,
    };
  }
  return {
    value: Math.max(1, Number(value)),
    malformed: false,
  };
}

function resolveBasePolicyTemplate() {
  return {
    promotion_policy_version: PROMOTION_CONTROL_SURFACE_VERSION,
    allowed_actions: [...PROMOTION_CONTROL_SURFACE_ALLOWED_ACTIONS],
    denied_actions: [...PROMOTION_CONTROL_SURFACE_DENIED_ACTIONS],
    rollback_disabled_actions: [],
    ineffective_threshold: PROMOTION_CONTROL_SURFACE_INEFFECTIVE_THRESHOLD,
    policy_reason_codes: [...PROMOTION_CONTROL_SURFACE_POLICY_REASON_CODES],
    policy_fail_closed: false,
  };
}

function normalizePolicyTemplate(policy = null) {
  const candidate = toObject(policy);
  if (!candidate) {
    return {
      ...resolveBasePolicyTemplate(),
      policy_source: "default",
    };
  }
  const allowedListResult = parseActionList(candidate.allowed_actions);
  const deniedListResult = parseActionList(candidate.denied_actions);
  const rollbackDisabledResult = parseActionList(candidate.rollback_disabled_actions);
  const thresholdResult = parseThreshold(candidate.ineffective_threshold);
  const malformed = allowedListResult.malformed
    || deniedListResult.malformed
    || rollbackDisabledResult.malformed
    || thresholdResult.malformed;
  if (malformed) {
    return {
      ...resolveBasePolicyTemplate(),
      policy_source: "malformed",
      policy_fail_closed: true,
    };
  }

  const hasAllowedList = Array.isArray(candidate.allowed_actions);
  const hasDeniedList = Array.isArray(candidate.denied_actions);
  const allowedActions = hasAllowedList
    ? allowedListResult.actions
    : [...PROMOTION_CONTROL_SURFACE_ALLOWED_ACTIONS];
  const deniedActions = hasDeniedList
    ? deniedListResult.actions
    : PROMOTION_CONTROL_SURFACE_ALL_ACTIONS.filter((action) => !allowedActions.includes(action));
  const overlap = allowedActions.filter((action) => deniedActions.includes(action));
  if (overlap.length > 0) {
    return {
      ...resolveBasePolicyTemplate(),
      policy_source: "malformed",
      policy_fail_closed: true,
    };
  }

  const version = cleanText(candidate.promotion_policy_version || "") || PROMOTION_CONTROL_SURFACE_VERSION;
  const reasonCodes = uniqueStrings(candidate.policy_reason_codes);
  return {
    promotion_policy_version: version,
    allowed_actions: allowedActions,
    denied_actions: deniedActions,
    rollback_disabled_actions: rollbackDisabledResult.actions,
    ineffective_threshold: thresholdResult.value,
    policy_reason_codes: reasonCodes.length > 0
      ? reasonCodes
      : [...PROMOTION_CONTROL_SURFACE_POLICY_REASON_CODES],
    policy_fail_closed: candidate.policy_fail_closed === true,
    policy_source: "provided",
  };
}

function resolveActionPolicyEntry({
  action = "",
  allowedActions = new Set(),
  deniedActions = new Set(),
  rollbackDisabledActions = new Set(),
  policyFailClosed = false,
} = {}) {
  const actionName = normalizeAction(action);
  const allowedByList = Boolean(actionName && allowedActions.has(actionName) && !deniedActions.has(actionName));
  const rollbackDisabled = Boolean(actionName && rollbackDisabledActions.has(actionName));
  const promotionAllowed = actionName
    ? allowedByList && !rollbackDisabled && !policyFailClosed
    : false;
  const requirementTemplate = actionName
    ? (ACTION_POLICY_REQUIREMENTS[actionName] || null)
    : null;
  const reason = policyFailClosed
    ? "policy_malformed_fail_closed"
    : rollbackDisabled
      ? "policy_rollback_disabled"
      : allowedByList
        ? "policy_allow_list"
        : "policy_deny_list";
  return {
    action_name: actionName,
    promotion_allowed: promotionAllowed,
    rollback_disabled: rollbackDisabled,
    requires_exact_match: allowedByList && requirementTemplate?.requires_exact_match === true,
    requires_complete_evidence: allowedByList && requirementTemplate?.requires_complete_evidence === true,
    requires_retry_worthiness: allowedByList && requirementTemplate?.requires_retry_worthiness === true,
    requires_no_blocking_readiness: allowedByList && requirementTemplate?.requires_no_blocking_readiness === true,
    requires_owner_mismatch_or_capability_gap: allowedByList && requirementTemplate?.requires_owner_mismatch_or_capability_gap === true,
    requires_no_blocking_dependency: allowedByList && requirementTemplate?.requires_no_blocking_dependency === true,
    requires_no_invalid_artifact: allowedByList && requirementTemplate?.requires_no_invalid_artifact === true,
    requires_recovery_safe: allowedByList && requirementTemplate?.requires_recovery_safe === true,
    reason,
    notes: ACTION_NOTES[actionName] || "advisory_only_v1",
  };
}

function buildFailClosedPolicy({
  version = PROMOTION_CONTROL_SURFACE_FAIL_CLOSED_VERSION,
  ineffectiveThreshold = PROMOTION_CONTROL_SURFACE_INEFFECTIVE_THRESHOLD,
  rollbackDisabledActions = [],
} = {}) {
  const allowedActions = [];
  const deniedActions = [...PROMOTION_CONTROL_SURFACE_ALL_ACTIONS];
  const rollbackDisabledSet = new Set(rollbackDisabledActions);
  const actionPolicyMap = {};
  for (const action of PROMOTION_CONTROL_SURFACE_ALL_ACTIONS) {
    actionPolicyMap[action] = resolveActionPolicyEntry({
      action,
      allowedActions: new Set(allowedActions),
      deniedActions: new Set(deniedActions),
      rollbackDisabledActions: rollbackDisabledSet,
      policyFailClosed: true,
    });
  }
  return Object.freeze({
    promotion_policy_version: version,
    allowed_actions: Object.freeze(allowedActions),
    denied_actions: Object.freeze(deniedActions),
    rollback_disabled_actions: Object.freeze([...rollbackDisabledSet]),
    ineffective_threshold: ineffectiveThreshold,
    action_policy_map: Object.freeze(actionPolicyMap),
    policy_reason_codes: Object.freeze(uniqueStrings([
      ...PROMOTION_CONTROL_SURFACE_POLICY_REASON_CODES,
      "policy_malformed_fail_closed",
    ])),
    policy_fail_closed: true,
  });
}

export function resolvePromotionControlSurface({
  rollback_disabled_actions = [],
  promotion_policy = null,
} = {}) {
  const normalizedTemplate = normalizePolicyTemplate(promotion_policy);
  const runtimeRollbackDisabledResult = parseActionList(rollback_disabled_actions);
  const malformedRuntimeRollback = runtimeRollbackDisabledResult.malformed;
  const effectiveRollbackDisabled = uniqueStrings([
    ...normalizedTemplate.rollback_disabled_actions,
    ...runtimeRollbackDisabledResult.actions,
  ]);
  const thresholdResult = parseThreshold(normalizedTemplate.ineffective_threshold);
  if (
    normalizedTemplate.policy_fail_closed
    || malformedRuntimeRollback
    || thresholdResult.malformed
  ) {
    return buildFailClosedPolicy({
      ineffectiveThreshold: thresholdResult.value,
      rollbackDisabledActions: effectiveRollbackDisabled,
    });
  }

  const allowedActionsSet = new Set(normalizedTemplate.allowed_actions);
  const deniedActionsSet = new Set(normalizedTemplate.denied_actions);
  const rollbackDisabledSet = new Set(effectiveRollbackDisabled);
  const actionPolicyMap = {};
  for (const action of PROMOTION_CONTROL_SURFACE_ALL_ACTIONS) {
    actionPolicyMap[action] = resolveActionPolicyEntry({
      action,
      allowedActions: allowedActionsSet,
      deniedActions: deniedActionsSet,
      rollbackDisabledActions: rollbackDisabledSet,
      policyFailClosed: false,
    });
  }

  return Object.freeze({
    promotion_policy_version: normalizedTemplate.promotion_policy_version,
    allowed_actions: Object.freeze([...normalizedTemplate.allowed_actions]),
    denied_actions: Object.freeze([...normalizedTemplate.denied_actions]),
    rollback_disabled_actions: Object.freeze([...effectiveRollbackDisabled]),
    ineffective_threshold: thresholdResult.value,
    action_policy_map: Object.freeze(actionPolicyMap),
    policy_reason_codes: Object.freeze(
      uniqueStrings(normalizedTemplate.policy_reason_codes).length > 0
        ? uniqueStrings(normalizedTemplate.policy_reason_codes)
        : [...PROMOTION_CONTROL_SURFACE_POLICY_REASON_CODES],
    ),
    policy_fail_closed: false,
  });
}

export function formatPromotionControlSurfaceSummary(policy = null) {
  const normalizedPolicy = policy && typeof policy === "object" && !Array.isArray(policy)
    ? policy
    : resolvePromotionControlSurface();
  const version = cleanText(normalizedPolicy.promotion_policy_version || "") || PROMOTION_CONTROL_SURFACE_FAIL_CLOSED_VERSION;
  const allowedActions = uniqueStrings(normalizedPolicy.allowed_actions);
  const rollbackDisabledActions = uniqueStrings(normalizedPolicy.rollback_disabled_actions);
  const ineffectiveThreshold = Number.isFinite(Number(normalizedPolicy.ineffective_threshold))
    ? Math.max(1, Number(normalizedPolicy.ineffective_threshold))
    : PROMOTION_CONTROL_SURFACE_INEFFECTIVE_THRESHOLD;
  const failClosed = normalizedPolicy.policy_fail_closed === true;
  return `version=${version} allowed_actions=${allowedActions.length > 0 ? `[${allowedActions.join(", ")}]` : "[]"} rollback_disabled_actions=${rollbackDisabledActions.length > 0 ? `[${rollbackDisabledActions.join(", ")}]` : "[]"} ineffective_threshold=${ineffectiveThreshold} fail_closed=${failClosed ? "true" : "false"}`;
}

export function resolvePromotionActionPolicy({
  policy = null,
  action = "",
} = {}) {
  const normalizedPolicy = policy && typeof policy === "object" && !Array.isArray(policy)
    ? policy
    : resolvePromotionControlSurface();
  const normalizedAction = normalizeAction(action);
  const map = toObject(normalizedPolicy.action_policy_map) || {};
  const actionPolicy = normalizedAction
    ? toObject(map[normalizedAction])
    : null;
  if (actionPolicy) {
    return actionPolicy;
  }
  return resolveActionPolicyEntry({
    action: normalizedAction || "proceed",
    policyFailClosed: true,
  });
}
