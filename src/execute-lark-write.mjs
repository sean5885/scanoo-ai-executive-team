import { AsyncLocalStorage } from "node:async_hooks";

import { shouldAllowWrite, recordCall } from "./lark-write-budget-guard.mjs";
import { admitMutation } from "./mutation-admission.mjs";

const writeExecutionStorage = new AsyncLocalStorage();

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeLogger(logger = null) {
  if (logger && typeof logger === "object") {
    return logger;
  }
  return null;
}

function buildWriteGuardFromAdmission(admission = {}) {
  const guardResult =
    admission?.guard_result && typeof admission.guard_result === "object" && !Array.isArray(admission.guard_result)
      ? admission.guard_result
      : {};

  return {
    decision: cleanText(guardResult.decision) || (admission?.allowed === true ? "allow" : "deny"),
    allow: admission?.allowed === true,
    external_write: admission?.policy_snapshot?.external_write === true,
    require_confirmation: cleanText(guardResult.reason) === "confirmation_required",
    reason: cleanText(guardResult.reason) || cleanText(admission?.reason) || null,
    error_code: cleanText(guardResult.error_code) || null,
    policy_enforcement:
      guardResult.policy_enforcement && typeof guardResult.policy_enforcement === "object" && !Array.isArray(guardResult.policy_enforcement)
        ? { ...guardResult.policy_enforcement }
        : null,
  };
}

function buildBudgetWriteGuard(decision = {}) {
  return {
    decision: "deny",
    allow: false,
    external_write: true,
    require_confirmation: false,
    reason: cleanText(decision.reason) || "write_budget_guard_blocked",
    error_code: "write_guard_denied",
    budget_state: decision.budget_state || null,
    fallback_to_preview: decision.fallback_to_preview === true,
    duplicate_type: cleanText(decision.duplicate_type) || null,
  };
}

function buildFailure({
  statusCode = 400,
  error = "write_guard_denied",
  message = "",
  writeGuard = null,
  budget = null,
  admission = null,
  confirmation = null,
  extra = {},
} = {}) {
  return {
    ok: false,
    statusCode,
    error,
    message: cleanText(message) || null,
    write_guard: writeGuard || null,
    budget: budget || null,
    admission: admission || null,
    confirmation: confirmation || null,
    ...extra,
  };
}

export function withLarkWriteExecutionContext(metadata = {}, fn) {
  return writeExecutionStorage.run({
    active: true,
    metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
  }, fn);
}

export function assertLarkWriteExecutionAllowed(operation = "unknown_write") {
  if (cleanText(process.env.NODE_ENV).toLowerCase() !== "development") {
    return;
  }

  const current = writeExecutionStorage.getStore();
  if (current?.active === true) {
    return;
  }

  const error = new Error(`Direct Lark write bypassed executeLarkWrite: ${cleanText(operation) || "unknown_write"}`);
  error.code = "direct_lark_write_bypass";
  throw error;
}

export async function executeLarkWrite({
  apiName = "",
  action = "",
  pathname = "",
  accountId = null,
  accessToken = null,
  traceId = null,
  logger = null,
  canonicalRequest = null,
  confirmation = {},
  budget = {},
  performWrite = null,
  onSuccess = null,
} = {}) {
  if (typeof performWrite !== "function") {
    throw new TypeError("executeLarkWrite requires performWrite");
  }

  const resolvedLogger = normalizeLogger(logger);
  const resolvedConfirmation = confirmation && typeof confirmation === "object" ? confirmation : {};
  const resolvedBudget = budget && typeof budget === "object" ? budget : {};
  const requireConfirm = resolvedConfirmation.requireConfirm === true;
  const requireConfirmationId = resolvedConfirmation.requireConfirmationId === true;
  const confirmed = resolvedConfirmation.confirm === true;
  const confirmationId = cleanText(
    resolvedConfirmation.confirmationId
    ?? resolvedConfirmation.confirmation_id
    ?? "",
  );

  if (requireConfirm && confirmed !== true) {
    return buildFailure({
      statusCode: Number(resolvedConfirmation.missingConfirmStatusCode || 409),
      error: cleanText(resolvedConfirmation.missingConfirmError) || "write_guard_denied",
      message: cleanText(resolvedConfirmation.missingConfirmMessage) || "External write requires explicit confirmation before apply.",
      confirmation: {
        checked: true,
        consumed: false,
        kind: cleanText(resolvedConfirmation.kind) || null,
      },
    });
  }

  if (requireConfirmationId && !confirmationId) {
    return buildFailure({
      statusCode: Number(resolvedConfirmation.missingConfirmationIdStatusCode || 400),
      error: cleanText(resolvedConfirmation.missingConfirmationIdError) || "missing_confirmation_id",
      message: cleanText(resolvedConfirmation.missingConfirmationIdMessage) || "A valid confirmation_id is required before write.",
      confirmation: {
        checked: true,
        consumed: false,
        kind: cleanText(resolvedConfirmation.kind) || null,
      },
    });
  }

  let pendingConfirmation = resolvedConfirmation.pending || null;
  if (!pendingConfirmation && typeof resolvedConfirmation.peek === "function") {
    pendingConfirmation = await resolvedConfirmation.peek({
      confirmationId,
      accountId,
      accessToken,
      logger: resolvedLogger,
      traceId,
    });
  }

  if (typeof resolvedConfirmation.peek === "function" && !pendingConfirmation) {
    return buildFailure({
      statusCode: Number(resolvedConfirmation.invalidStatusCode || 400),
      error: cleanText(resolvedConfirmation.invalidError) || "invalid_or_expired_confirmation",
      message: cleanText(resolvedConfirmation.invalidMessage) || "The confirmation is missing or expired.",
      confirmation: {
        checked: true,
        consumed: false,
        kind: cleanText(resolvedConfirmation.kind) || null,
      },
    });
  }

  if (typeof resolvedConfirmation.validate === "function") {
    const validation = await resolvedConfirmation.validate({
      confirmation: pendingConfirmation,
      confirmationId,
      accountId,
      accessToken,
      logger: resolvedLogger,
      traceId,
    });

    if (validation && validation.ok === false) {
      return buildFailure({
        statusCode: Number(validation.statusCode || validation.status_code || 400),
        error: cleanText(validation.error) || "invalid_or_expired_confirmation",
        message: cleanText(validation.message) || null,
        confirmation: {
          checked: true,
          consumed: false,
          kind: cleanText(resolvedConfirmation.kind) || null,
        },
        extra: validation.extra && typeof validation.extra === "object" ? validation.extra : {},
      });
    }

    if (validation?.confirmation && typeof validation.confirmation === "object") {
      pendingConfirmation = validation.confirmation;
    }
  }

  let admission = null;
  if (canonicalRequest) {
    admission = admitMutation({
      canonicalRequest,
      logger: resolvedLogger,
      traceId,
    });
    if (!admission.allowed) {
      return buildFailure({
        statusCode: 409,
        error: "write_guard_denied",
        message: cleanText(admission.guard_result?.policy_enforcement?.message)
          || cleanText(admission.guard_result?.reason)
          || "External write is blocked by write guard.",
        writeGuard: buildWriteGuardFromAdmission(admission),
        admission,
        confirmation: {
          checked: true,
          consumed: false,
          kind: cleanText(resolvedConfirmation.kind) || null,
        },
      });
    }
  }

  const budgetMetadata = {
    action: cleanText(action) || cleanText(apiName) || null,
    account_id: accountId || null,
    session_key:
      cleanText(resolvedBudget.sessionKey ?? resolvedBudget.session_key)
      || cleanText(resolvedBudget.scopeKey ?? resolvedBudget.scope_key)
      || accountId
      || null,
    scope_key: cleanText(resolvedBudget.scopeKey ?? resolvedBudget.scope_key) || null,
    document_id: cleanText(resolvedBudget.documentId ?? resolvedBudget.document_id) || null,
    target_document_id: cleanText(resolvedBudget.targetDocumentId ?? resolvedBudget.target_document_id) || null,
    confirmation_id: confirmationId || null,
    content: typeof resolvedBudget.content === "string" ? resolvedBudget.content : "",
    payload: resolvedBudget.payload,
    essential: resolvedBudget.essential === true,
    whitelist: resolvedBudget.whitelist === true,
    idempotency_key:
      cleanText(resolvedBudget.idempotencyKey ?? resolvedBudget.idempotency_key)
      || cleanText(canonicalRequest?.context?.idempotency_key ?? canonicalRequest?.context?.idempotencyKey)
      || null,
    pathname: cleanText(pathname) || cleanText(canonicalRequest?.context?.pathname) || null,
  };

  const budgetDecision = await shouldAllowWrite(apiName, {
    ...budgetMetadata,
    logger: resolvedLogger,
  });
  if (!budgetDecision.allow) {
    return buildFailure({
      statusCode: 409,
      error: "write_guard_denied",
      message: cleanText(resolvedBudget.blockedMessage)
        || `External write is blocked by ${cleanText(budgetDecision.reason) || "write budget guard"}.`,
      writeGuard: buildBudgetWriteGuard(budgetDecision),
      budget: budgetDecision,
      confirmation: {
        checked: true,
        consumed: false,
        kind: cleanText(resolvedConfirmation.kind) || null,
      },
    });
  }

  let consumedConfirmation = pendingConfirmation;
  if (typeof resolvedConfirmation.consume === "function") {
    consumedConfirmation = await resolvedConfirmation.consume({
      confirmationId,
      accountId,
      confirmation: pendingConfirmation,
      accessToken,
      logger: resolvedLogger,
      traceId,
    });
    if (!consumedConfirmation) {
      return buildFailure({
        statusCode: Number(resolvedConfirmation.invalidStatusCode || 400),
        error: cleanText(resolvedConfirmation.invalidError) || "invalid_or_expired_confirmation",
        message: cleanText(resolvedConfirmation.invalidMessage) || "The confirmation is missing or expired.",
        confirmation: {
          checked: true,
          consumed: false,
          kind: cleanText(resolvedConfirmation.kind) || null,
        },
      });
    }
  }

  const result = await withLarkWriteExecutionContext({
    api_name: cleanText(apiName) || null,
    action: cleanText(action) || null,
    pathname: cleanText(pathname) || null,
    account_id: accountId || null,
    trace_id: traceId || null,
  }, async () => performWrite({
    accessToken,
    confirmation: consumedConfirmation,
    pendingConfirmation,
    budgetDecision,
    admission,
  }));

  await recordCall(apiName, {
    ...budgetMetadata,
    request_fingerprint: budgetDecision.request_fingerprint,
    idempotency_key: budgetDecision.idempotency_key,
    allowed: true,
    blocked: false,
    reason: null,
  });

  if (typeof onSuccess === "function") {
    await onSuccess({
      result,
      confirmation: consumedConfirmation,
      pendingConfirmation,
      budgetDecision,
      admission,
      accessToken,
    });
  }

  return {
    ok: true,
    statusCode: 200,
    result,
    budget: budgetDecision,
    admission,
    confirmation: {
      checked: true,
      consumed: typeof resolvedConfirmation.consume === "function",
      kind: cleanText(resolvedConfirmation.kind) || null,
    },
  };
}
