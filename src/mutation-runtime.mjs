import {
  admitMutation,
  assertCanonicalMutationRequestSchema,
} from "./mutation-admission.mjs";
import { runMutationVerification } from "./mutation-verifier.mjs";

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeLogger(logger = null) {
  if (logger && typeof logger === "object") {
    return logger;
  }
  return null;
}

function getMutationIdempotencyStore() {
  globalThis.__mutation_idempotency_store__ =
    globalThis.__mutation_idempotency_store__ || new Map();

  return globalThis.__mutation_idempotency_store__;
}

function clearPendingMutationIdempotency(idempotencyKey) {
  if (!idempotencyKey) {
    return;
  }

  const entry = globalThis.__mutation_idempotency_store__?.get(idempotencyKey);
  if (entry?.__status === "pending") {
    globalThis.__mutation_idempotency_store__.delete(idempotencyKey);
  }
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

function buildWriteGuardMessage(guard = {}) {
  if (guard.reason === "policy_enforcement_blocked") {
    return cleanText(guard?.policy_enforcement?.message) || "External write is blocked by write policy enforcement.";
  }
  if (guard.reason === "confirmation_required") {
    return "External write requires explicit confirmation before apply.";
  }
  if (guard.reason === "preview_write_blocked") {
    return "Preview mode cannot execute external writes.";
  }
  if (guard.reason === "verifier_incomplete") {
    return "External write is blocked until preview/review verification is complete.";
  }
  return "External write is blocked by write guard.";
}

function logMutationAdmission(logger, event, {
  accountId = null,
  canonicalRequest = null,
  admission = null,
} = {}) {
  if (!logger || typeof logger.info !== "function") {
    return;
  }

  const payload = {
    stage: "mutation_admission",
    account_id: cleanText(accountId) || null,
    pathname: cleanText(canonicalRequest?.context?.pathname) || null,
    action_type: cleanText(canonicalRequest?.action_type) || null,
    resource_type: cleanText(canonicalRequest?.resource_type) || null,
  };

  if (cleanText(canonicalRequest?.resource_id)) {
    payload.resource_id = cleanText(canonicalRequest.resource_id);
  }
  if (admission && typeof admission === "object") {
    payload.allowed = admission.allowed === true;
    payload.reason = cleanText(admission.reason) || null;
  }

  logger.info(event, payload);
}

function buildMutationVerifierFailure({
  action = "",
  verification = null,
} = {}) {
  return {
    ok: false,
    action,
    statusCode: 409,
    error: "mutation_verifier_blocked",
    message: cleanText(verification?.message) || "Mutation write is blocked until verification evidence is complete.",
    verifier: verification && typeof verification === "object"
      ? { ...verification }
      : null,
  };
}

function buildAdmissionFailure({ action = "", admission = null } = {}) {
  const writeGuard = buildWriteGuardFromAdmission(admission);
  const policyEnforcement = writeGuard.policy_enforcement || null;
  const error = writeGuard.reason === "policy_enforcement_blocked"
    ? "write_policy_enforcement_blocked"
    : "write_guard_denied";

  return {
    ok: false,
    action,
    statusCode: 409,
    error,
    message: buildWriteGuardMessage(writeGuard),
    write_guard: writeGuard,
    admission,
    ...(error === "write_policy_enforcement_blocked"
      ? {
          violation_types: Array.isArray(policyEnforcement?.violation_types)
            ? [...policyEnforcement.violation_types]
            : [],
        }
      : {}),
  };
}

export async function runMutation({ action, payload, context, execute }) {
  if (typeof execute !== "function") {
    void payload;
    void context;

    return { ok: false, error: "missing_execute" };
  }

  const idempotencyKey = cleanText(context?.idempotency_key) || null;
  if (idempotencyKey) {
    const store = getMutationIdempotencyStore();
    const existing = store.get(idempotencyKey);

    if (existing) {
      if (existing.__status === "pending") {
        return {
          ok: false,
          error: "idempotency_in_progress",
        };
      }
      return existing.__status === "done" && existing.response
        ? existing.response
        : existing;
    }

    store.set(idempotencyKey, {
      __status: "pending",
    });
  }

  const failSoft = (failure) => {
    clearPendingMutationIdempotency(idempotencyKey);
    return failure;
  };

  const resolvedLogger = normalizeLogger(context?.logger);
  const canonicalRequestInput = context?.canonical_request ?? context?.canonicalRequest ?? null;
  let canonicalRequest = null;

  if (canonicalRequestInput) {
    try {
      canonicalRequest = assertCanonicalMutationRequestSchema(canonicalRequestInput);
    } catch {
      return failSoft({
        ok: false,
        action,
        error: "invalid_canonical_request",
      });
    }
  }

  const mode = context?.execution_mode || "passthrough";
  const verifierProfile = cleanText(context?.verifier_profile ?? context?.verifierProfile);
  const verifierInput =
    context?.verifier_input && typeof context.verifier_input === "object" && !Array.isArray(context.verifier_input)
      ? { ...context.verifier_input }
      : context?.verifierInput && typeof context.verifierInput === "object" && !Array.isArray(context.verifierInput)
        ? { ...context.verifierInput }
        : null;
  const start = Date.now();
  const journal = {
    action,
    status: "started",
    started_at: start,
  };
  const rollback = context?.rollback;

  if (canonicalRequest) {
    logMutationAdmission(resolvedLogger, "mutation_admission_started", {
      accountId: context?.account_id,
      canonicalRequest,
    });
    const admission = admitMutation({
      canonicalRequest,
      logger: resolvedLogger,
      traceId: context?.trace_id ?? context?.traceId ?? null,
    });
    logMutationAdmission(resolvedLogger, "mutation_admission_decision", {
      accountId: context?.account_id,
      canonicalRequest,
      admission,
    });
    if (!admission.allowed) {
      return failSoft({
        ...buildAdmissionFailure({
          action,
          admission,
        }),
        meta: {
          execution_mode: mode,
          duration_ms: Date.now() - start,
          journal,
        },
      });
    }
  }

  const preVerification = runMutationVerification({
    phase: "pre",
    profile: verifierProfile,
    canonicalRequest,
    verifierInput,
  });
  if (preVerification && preVerification.pass !== true) {
    return failSoft({
      ...buildMutationVerifierFailure({
        action,
        verification: preVerification,
      }),
      meta: {
        execution_mode: mode,
        duration_ms: Date.now() - start,
        journal,
        verification: {
          pre: preVerification,
        },
      },
    });
  }

  let result;
  try {
    if (mode === "controlled") {
      // controlled: 明確走 runtime 控制入口（目前仍調 execute，但已分流）
      result = await execute({
        action,
        payload,
        context,
        controlled: true,
      });
    } else {
      // passthrough
      result = await execute({
        action,
        payload,
        context,
      });
    }
    journal.status = "success";
  } catch (err) {
    journal.status = "failed";
    journal.error = err?.message || "execution_failed";
    if (typeof rollback === "function") {
      try {
        await rollback({
          action,
          payload,
          context,
          error: err,
        });
        journal.rollback = {
          status: "success",
        };
      } catch (rollbackErr) {
        journal.rollback = {
          status: "failed",
          error: rollbackErr?.message || "rollback_failed",
        };
      }
    } else {
      journal.rollback = {
        status: "pending",
      };
    }

    return failSoft({
      ok: false,
      action,
      error: "execution_failed",
      meta: {
        execution_mode: mode,
        duration_ms: Date.now() - start,
        journal,
        ...(preVerification
          ? {
              verification: {
                pre: preVerification,
              },
            }
          : {}),
      },
    });
  }

  const postVerification = runMutationVerification({
    phase: "post",
    profile: verifierProfile,
    canonicalRequest,
    verifierInput,
    executeResult: result,
  });
  if (postVerification && postVerification.pass !== true) {
    journal.status = "failed";
    journal.error = cleanText(postVerification.reason) || "mutation_verifier_blocked";
    return failSoft({
      ...buildMutationVerifierFailure({
        action,
        verification: postVerification,
      }),
      meta: {
        execution_mode: mode,
        duration_ms: Date.now() - start,
        journal,
        verification: {
          ...(preVerification ? { pre: preVerification } : {}),
          post: postVerification,
        },
      },
    });
  }

  const response = {
    ok: true,
    action,
    result,
    meta: {
      execution_mode: mode,
      duration_ms: Date.now() - start,
      journal,
      ...((preVerification || postVerification)
        ? {
            verification: {
              ...(preVerification ? { pre: preVerification } : {}),
              ...(postVerification ? { post: postVerification } : {}),
            },
          }
        : {}),
    },
  };

  if (idempotencyKey) {
    getMutationIdempotencyStore().set(idempotencyKey, {
      __status: "done",
      response,
    });
  }

  return response;
}
