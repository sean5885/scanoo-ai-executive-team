function cleanText(value) {
  return String(value || "").trim();
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

function emitWriteGuardDecisionLog({
  logger = null,
  decision = {},
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

  sink("write_guard_decision", {
    ...(normalizeObject(details)),
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
    ...(cleanText(requestId) ? { request_id: cleanText(requestId) } : {}),
    ...(cleanText(traceId) ? { trace_id: cleanText(traceId) } : {}),
  });
}

export function decideWriteGuard({
  externalWrite = false,
  confirmed = false,
  preview = false,
  mode = "",
  verifierCompleted = false,
  verification = null,
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
  let decision = null;

  if (!external) {
    decision = buildWriteGuardDecision({
      allow: true,
      externalWrite: false,
      requireConfirmation: false,
      reason: "internal_write",
    });
    emitWriteGuardDecisionLog({
      logger,
      decision,
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
    decision = buildWriteGuardDecision({
      allow: false,
      externalWrite: true,
      requireConfirmation: false,
      reason: "preview_write_blocked",
    });
    emitWriteGuardDecisionLog({
      logger,
      decision,
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
    decision = buildWriteGuardDecision({
      allow: false,
      externalWrite: true,
      requireConfirmation: true,
      reason: "confirmation_required",
    });
    emitWriteGuardDecisionLog({
      logger,
      decision,
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
    decision = buildWriteGuardDecision({
      allow: false,
      externalWrite: true,
      requireConfirmation: false,
      reason: "verifier_incomplete",
    });
    emitWriteGuardDecisionLog({
      logger,
      decision,
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
  emitWriteGuardDecisionLog({
    logger,
    decision,
    owner,
    workflow,
    operation,
    requestId,
    traceId,
    details,
  });
  return decision;
}
