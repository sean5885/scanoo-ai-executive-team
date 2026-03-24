import { evaluateWritePolicyEnforcement } from "./write-policy-enforcement.mjs";

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeTrafficSource(value = "") {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === "real" || normalized === "test" || normalized === "replay") {
    return normalized;
  }
  return null;
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

function resolveVerifierCompleted({ verifierCompleted = false, verification = null } = {}) {
  if (verifierCompleted === true) {
    return true;
  }
  if (verification === true) {
    return true;
  }
  return verification?.pass === true;
}

function resolveWriteGuardErrorCode({ allow = false, reason = "" } = {}) {
  if (allow) {
    return null;
  }

  switch (cleanText(reason)) {
    case "preview_write_blocked":
      return "write_guard_preview_blocked";
    case "confirmation_required":
      return "write_guard_confirmation_required";
    case "verifier_incomplete":
      return "write_guard_verifier_incomplete";
    case "policy_enforcement_blocked":
      return "write_policy_enforcement_blocked";
    default:
      return "write_guard_denied";
  }
}

function buildWriteGuardDecision({
  allow = false,
  externalWrite = false,
  requireConfirmation = false,
  reason = "",
} = {}) {
  return {
    decision: allow ? "allow" : "deny",
    allow,
    external_write: externalWrite === true,
    require_confirmation: requireConfirmation === true,
    reason: cleanText(reason) || null,
    error_code: resolveWriteGuardErrorCode({ allow, reason }),
  };
}

function clonePolicyEnforcement(policyEnforcement = null) {
  if (!policyEnforcement || typeof policyEnforcement !== "object" || Array.isArray(policyEnforcement)) {
    return null;
  }
  return {
    enforcement_version: cleanText(policyEnforcement.enforcement_version) || null,
    action: cleanText(policyEnforcement.action) || null,
    pathname: cleanText(policyEnforcement.pathname) || null,
    mode: cleanText(policyEnforcement.mode) || null,
    status: cleanText(policyEnforcement.status) || null,
    checks: policyEnforcement.checks && typeof policyEnforcement.checks === "object"
      ? {
          scope_key: policyEnforcement.checks.scope_key === true,
          idempotency_key: policyEnforcement.checks.idempotency_key === true,
          confirm_required: policyEnforcement.checks.confirm_required === true,
          review_required: policyEnforcement.checks.review_required === true,
        }
      : null,
    signals: policyEnforcement.signals && typeof policyEnforcement.signals === "object"
      ? {
          scope_key_present: policyEnforcement.signals.scope_key_present === true,
          idempotency_key_present: policyEnforcement.signals.idempotency_key_present === true,
          confirmation_present: policyEnforcement.signals.confirmation_present === true,
          review_completed: policyEnforcement.signals.review_completed === true,
          review_required_active: policyEnforcement.signals.review_required_active === true,
        }
      : null,
    violation_count: Number(policyEnforcement.violation_count || 0),
    violation_types: Array.isArray(policyEnforcement.violation_types)
      ? policyEnforcement.violation_types.map((item) => cleanText(item)).filter(Boolean)
      : [],
    violation_reasons: Array.isArray(policyEnforcement.violation_reasons)
      ? policyEnforcement.violation_reasons.map((item) => cleanText(item)).filter(Boolean)
      : [],
    violations: Array.isArray(policyEnforcement.violations)
      ? policyEnforcement.violations.map((item) => ({
          type: cleanText(item?.type) || null,
          field: cleanText(item?.field) || null,
          message: cleanText(item?.message) || null,
          reason: cleanText(item?.reason) || null,
          check: cleanText(item?.check) || null,
        }))
      : [],
    should_block: policyEnforcement.should_block === true,
    should_warn: policyEnforcement.should_warn === true,
    should_observe: policyEnforcement.should_observe === true,
    fallback: policyEnforcement.fallback && typeof policyEnforcement.fallback === "object"
      ? {
          applied: policyEnforcement.fallback.applied === true,
          mode: cleanText(policyEnforcement.fallback.mode) || null,
          reason: cleanText(policyEnforcement.fallback.reason) || null,
        }
      : null,
    message: cleanText(policyEnforcement.message) || null,
  };
}

function parseFailOpenActions(value = "") {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => cleanText(item))
      .filter(Boolean),
  );
}

function shouldFailOpenPolicyBlock({ action = "", pathname = "" } = {}) {
  const configured = parseFailOpenActions(process.env.WRITE_POLICY_FAIL_OPEN_ACTIONS || "");
  if (configured.size === 0) {
    return false;
  }
  return configured.has(cleanText(action)) || configured.has(cleanText(pathname));
}

function buildFallbackPayload({ applied = false, reason = "" } = {}) {
  return {
    applied: applied === true,
    mode: applied === true ? "fail_open_alert" : null,
    reason: cleanText(reason) || null,
  };
}

function attachPolicyEnforcement(decision = {}, policyEnforcement = null) {
  const nextDecision = {
    ...decision,
  };
  const normalizedPolicyEnforcement = clonePolicyEnforcement(policyEnforcement);

  if (normalizedPolicyEnforcement) {
    nextDecision.policy_enforcement = normalizedPolicyEnforcement;
    if (normalizedPolicyEnforcement.should_warn) {
      nextDecision.warning = normalizedPolicyEnforcement.message;
    }
  }

  return nextDecision;
}

function emitWriteGuardDecisionLog({
  logger = null,
  decision = {},
  policyEnforcement = null,
  owner = "",
  workflow = "",
  operation = "",
  requestId = null,
  traceId = null,
  details = {},
} = {}) {
  if (!logger || (typeof logger.info !== "function" && typeof logger.warn !== "function")) {
    return;
  }

  const level = decision.allow ? "info" : "warn";
  const sink = typeof logger[level] === "function"
    ? logger[level].bind(logger)
    : logger.info.bind(logger);
  const normalizedDetails = normalizeObject(details);
  const trafficSource = normalizeTrafficSource(normalizedDetails.traffic_source);
  const requestBacked = typeof normalizedDetails.request_backed === "boolean"
    ? normalizedDetails.request_backed
    : null;

  sink("write_guard_decision", {
    ...normalizedDetails,
    action: cleanText(operation) || "write_guard",
    owner: cleanText(owner) || null,
    workflow: cleanText(workflow) || null,
    decision: decision.decision || (decision.allow ? "allow" : "deny"),
    status: decision.decision || (decision.allow ? "allow" : "deny"),
    allow: decision.allow === true,
    deny: decision.allow !== true,
    external_write: decision.external_write === true,
    require_confirmation: decision.require_confirmation === true,
    reason: cleanText(decision.reason) || null,
    error_code: cleanText(decision.error_code) || null,
    policy_enforcement: clonePolicyEnforcement(policyEnforcement),
    ...(trafficSource ? { traffic_source: trafficSource } : {}),
    ...(requestBacked == null ? {} : { request_backed: requestBacked }),
    ...(cleanText(requestId) ? { request_id: cleanText(requestId) } : {}),
    ...(cleanText(traceId) ? { trace_id: cleanText(traceId) } : {}),
  });

  if (!policyEnforcement || policyEnforcement.violation_count <= 0) {
    return;
  }

  const policySummary = {
    mode: cleanText(policyEnforcement.mode) || null,
    status: cleanText(policyEnforcement.status) || null,
    violation_count: Number(policyEnforcement.violation_count || 0),
    violation_types: Array.isArray(policyEnforcement.violation_types) ? [...policyEnforcement.violation_types] : [],
    violation_reasons: Array.isArray(policyEnforcement.violation_reasons) ? [...policyEnforcement.violation_reasons] : [],
    signals: policyEnforcement.signals && typeof policyEnforcement.signals === "object"
      ? { ...policyEnforcement.signals }
      : null,
    fallback: policyEnforcement.fallback && typeof policyEnforcement.fallback === "object"
      ? { ...policyEnforcement.fallback }
      : null,
  };

  if (policyEnforcement.fallback?.applied === true) {
    const fallbackSink = typeof logger.warn === "function"
      ? logger.warn.bind(logger)
      : sink;
    fallbackSink("write_policy_enforcement_fail_open", {
      action: cleanText(operation) || "write_guard",
      owner: cleanText(owner) || null,
      workflow: cleanText(workflow) || null,
      policy_enforcement: clonePolicyEnforcement(policyEnforcement),
      policy_enforcement_summary: policySummary,
      ...(cleanText(requestId) ? { request_id: cleanText(requestId) } : {}),
      ...(cleanText(traceId) ? { trace_id: cleanText(traceId) } : {}),
    });
    return;
  }

  if (policyEnforcement.should_warn) {
    const warningSink = typeof logger.warn === "function"
      ? logger.warn.bind(logger)
      : sink;
    warningSink("write_policy_enforcement_warning", {
      action: cleanText(operation) || "write_guard",
      owner: cleanText(owner) || null,
      workflow: cleanText(workflow) || null,
      policy_enforcement: clonePolicyEnforcement(policyEnforcement),
      policy_enforcement_summary: policySummary,
      ...(cleanText(requestId) ? { request_id: cleanText(requestId) } : {}),
      ...(cleanText(traceId) ? { trace_id: cleanText(traceId) } : {}),
    });
    return;
  }

  if (policyEnforcement.should_observe) {
    const infoSink = typeof logger.info === "function"
      ? logger.info.bind(logger)
      : sink;
    infoSink("write_policy_enforcement_observed", {
      action: cleanText(operation) || "write_guard",
      owner: cleanText(owner) || null,
      workflow: cleanText(workflow) || null,
      policy_enforcement: clonePolicyEnforcement(policyEnforcement),
      policy_enforcement_summary: policySummary,
      ...(cleanText(requestId) ? { request_id: cleanText(requestId) } : {}),
      ...(cleanText(traceId) ? { trace_id: cleanText(traceId) } : {}),
    });
  }
}

export function decideWriteGuard({
  externalWrite = false,
  confirmed = false,
  preview = false,
  mode = "",
  verifierCompleted = false,
  verification = null,
  pathname = "",
  writePolicy = null,
  reviewCompleted = false,
  reviewRequirementActive = false,
  scopeKey = null,
  idempotencyKey = null,
  logger = null,
  owner = "",
  workflow = "",
  operation = "",
  requestId = null,
  traceId = null,
  details = {},
} = {}) {
  const external = externalWrite === true;
  const previewMode = preview === true || cleanText(mode).toLowerCase() === "preview";
  const verificationDone = resolveVerifierCompleted({ verifierCompleted, verification });
  const reviewDone = reviewCompleted === true || verificationDone;
  const policyEnforcement = evaluateWritePolicyEnforcement({
    action: operation,
    pathname,
    writePolicy,
    confirmed,
    reviewCompleted: reviewDone,
    reviewRequirementActive,
    scopeKey,
    idempotencyKey,
  });
  if (policyEnforcement.should_block && shouldFailOpenPolicyBlock({ action: operation, pathname })) {
    policyEnforcement.should_block = false;
    policyEnforcement.should_warn = true;
    policyEnforcement.should_observe = false;
    policyEnforcement.status = "warn";
    policyEnforcement.fallback = buildFallbackPayload({
      applied: true,
      reason: "policy_enforcement_fail_open_enabled",
    });
  }
  let decision = null;

  if (!external) {
    decision = attachPolicyEnforcement(buildWriteGuardDecision({
      allow: true,
      externalWrite: false,
      requireConfirmation: false,
      reason: "internal_write",
    }), policyEnforcement);
    emitWriteGuardDecisionLog({
      logger,
      decision,
      policyEnforcement,
      owner,
      workflow,
      operation,
      requestId,
      traceId,
      details,
    });
    return decision;
  }

  if (previewMode) {
    decision = attachPolicyEnforcement(buildWriteGuardDecision({
      allow: false,
      externalWrite: true,
      requireConfirmation: false,
      reason: "preview_write_blocked",
    }), policyEnforcement);
    emitWriteGuardDecisionLog({
      logger,
      decision,
      policyEnforcement,
      owner,
      workflow,
      operation,
      requestId,
      traceId,
      details,
    });
    return decision;
  }

  if (confirmed !== true) {
    decision = attachPolicyEnforcement(buildWriteGuardDecision({
      allow: false,
      externalWrite: true,
      requireConfirmation: true,
      reason: "confirmation_required",
    }), policyEnforcement);
    emitWriteGuardDecisionLog({
      logger,
      decision,
      policyEnforcement,
      owner,
      workflow,
      operation,
      requestId,
      traceId,
      details,
    });
    return decision;
  }

  if (!verificationDone) {
    decision = attachPolicyEnforcement(buildWriteGuardDecision({
      allow: false,
      externalWrite: true,
      requireConfirmation: false,
      reason: "verifier_incomplete",
    }), policyEnforcement);
    emitWriteGuardDecisionLog({
      logger,
      decision,
      policyEnforcement,
      owner,
      workflow,
      operation,
      requestId,
      traceId,
      details,
    });
    return decision;
  }

  decision = buildWriteGuardDecision({
    allow: true,
    externalWrite: true,
    requireConfirmation: false,
    reason: "allowed",
  });
  if (policyEnforcement.should_block) {
    decision = buildWriteGuardDecision({
      allow: false,
      externalWrite: true,
      requireConfirmation: false,
      reason: "policy_enforcement_blocked",
    });
  }
  decision = attachPolicyEnforcement(decision, policyEnforcement);
  emitWriteGuardDecisionLog({
    logger,
    decision,
    policyEnforcement,
    owner,
    workflow,
    operation,
    requestId,
    traceId,
    details,
  });
  return decision;
}
