import {
  admitMutation,
  assertCanonicalMutationRequestSchema,
} from "./mutation-admission.mjs";
import { buildExecutionEnvelope } from "./execution-envelope.mjs";
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
  return buildExecutionEnvelope({
    ok: false,
    action,
    error: "mutation_verifier_blocked",
    data: {
      statusCode: 409,
      message: cleanText(verification?.message) || "Mutation write is blocked until verification evidence is complete.",
      verifier: verification && typeof verification === "object"
        ? { ...verification }
        : null,
    },
  });
}

function buildAdmissionFailure({ action = "", admission = null } = {}) {
  const writeGuard = buildWriteGuardFromAdmission(admission);
  const policyEnforcement = writeGuard.policy_enforcement || null;
  const error = writeGuard.reason === "policy_enforcement_blocked"
    ? "write_policy_enforcement_blocked"
    : "write_guard_denied";

  return buildExecutionEnvelope({
    ok: false,
    action,
    error,
    data: {
      statusCode: 409,
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
    },
  });
}

function cloneJournalValue(value) {
  if (value === undefined) {
    return undefined;
  }

  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // fall through
    }
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function maybeAttachJournalValue(target = null, key = "", value = undefined) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return;
  }
  if (value === null) {
    return;
  }

  const cloned = cloneJournalValue(value);
  if (cloned === undefined) {
    return;
  }
  if (Array.isArray(cloned) && cloned.length === 0) {
    return;
  }
  if (cloned && typeof cloned === "object" && !Array.isArray(cloned) && Object.keys(cloned).length === 0) {
    return;
  }

  target[key] = cloned;
}

function buildMutationMeta({
  mode = "passthrough",
  start = 0,
  journal = null,
  writePolicy = null,
  authority = null,
  audit = null,
  preVerification = null,
  postVerification = null,
  includePolicyFields = false,
} = {}) {
  const meta = {
    execution_mode: mode,
    duration_ms: Date.now() - start,
    journal: journal && typeof journal === "object" ? journal : {},
  };

  if (includePolicyFields) {
    meta.write_policy = writePolicy;
    meta.authority = authority;
  }

  maybeAttachJournalValue(meta.journal, "audit", audit);

  if (preVerification || postVerification) {
    meta.verification = {
      ...(preVerification ? { pre: preVerification } : {}),
      ...(postVerification ? { post: postVerification } : {}),
    };
  }

  return meta;
}

export async function runMutation({ action, payload, context, execute }) {
  if (!execute) {
    void payload;
    void context;

    return buildExecutionEnvelope({
      ok: false,
      action,
      error: "missing_execute",
    });
  }

  if (typeof execute !== "function") {
    void payload;
    void context;

    return buildExecutionEnvelope({
      ok: false,
      action,
      error: "invalid_executor",
      data: {
        message: "execute must be a function",
      },
    });
  }

  const writePolicy =
    context?.write_policy && typeof context.write_policy === "object" && !Array.isArray(context.write_policy)
      ? { ...context.write_policy }
      : null;
  const allowedActions = Array.isArray(writePolicy?.allowed_actions)
    ? writePolicy.allowed_actions
      .map((entry) => cleanText(entry))
      .filter(Boolean)
    : null;

  if (allowedActions && !allowedActions.includes(cleanText(action))) {
    return buildExecutionEnvelope({
      ok: false,
      action,
      error: "write_policy_violation",
      data: {
        message: `action "${cleanText(action) || "unknown"}" is not allowed`,
      },
      meta: {
        execution_mode: context?.execution_mode || "passthrough",
        duration_ms: 0,
        journal: {
          action,
          status: "blocked",
          started_at: Date.now(),
          error: "write_policy_violation",
        },
        write_policy: writePolicy,
      },
    });
  }

  const requiredAuthority = cleanText(writePolicy?.authority) || null;
  const currentAuthority = cleanText(context?.authority) || null;

  if (requiredAuthority && currentAuthority !== requiredAuthority) {
    return buildExecutionEnvelope({
      ok: false,
      action,
      error: "authority_mismatch",
      data: {
        message: `requires authority "${requiredAuthority}" but got "${currentAuthority}"`,
      },
      meta: {
        execution_mode: context?.execution_mode || "passthrough",
        duration_ms: 0,
        journal: {
          action,
          status: "blocked",
          started_at: Date.now(),
          error: "authority_mismatch",
        },
        write_policy: writePolicy,
        authority: currentAuthority,
      },
    });
  }

  const idempotencyKey = cleanText(context?.idempotency_key) || null;
  if (idempotencyKey) {
    const store = getMutationIdempotencyStore();
    const existing = store.get(idempotencyKey);

    if (existing) {
      if (existing.__status === "pending") {
        return buildExecutionEnvelope({
          ok: false,
          action,
          error: "idempotency_in_progress",
        });
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
      return failSoft(buildExecutionEnvelope({
        ok: false,
        action,
        error: "invalid_canonical_request",
      }));
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
  const audit =
    context?.audit && typeof context.audit === "object" && !Array.isArray(context.audit)
      ? context.audit
      : null;

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
        meta: buildMutationMeta({
          mode,
          start,
          journal,
          audit,
        }),
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
      meta: buildMutationMeta({
        mode,
        start,
        journal,
        audit,
        preVerification,
      }),
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
    maybeAttachJournalValue(journal, "error_details", err?.details);
    if (typeof rollback === "function") {
      try {
        const rollbackResult = await rollback({
          action,
          payload,
          context,
          error: err,
        });
        journal.rollback = {
          status: "success",
        };
        maybeAttachJournalValue(journal.rollback, "details", rollbackResult);
      } catch (rollbackErr) {
        journal.rollback = {
          status: "failed",
          error: rollbackErr?.message || "rollback_failed",
        };
        maybeAttachJournalValue(journal.rollback, "details", rollbackErr?.details);
      }
    } else {
      journal.rollback = {
        status: "pending",
      };
    }

    return failSoft(buildExecutionEnvelope({
      ok: false,
      action,
      error: "execution_failed",
      meta: buildMutationMeta({
        mode,
        start,
        journal,
        audit,
        preVerification,
      }),
    }));
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
      meta: buildMutationMeta({
        mode,
        start,
        journal,
        audit,
        preVerification,
        postVerification,
      }),
    });
  }

  const response = buildExecutionEnvelope({
    ok: true,
    action,
    data: result,
    meta: buildMutationMeta({
      mode,
      start,
      journal,
      writePolicy,
      authority: currentAuthority,
      audit,
      preVerification,
      postVerification,
      includePolicyFields: true,
    }),
  });

  if (idempotencyKey) {
    getMutationIdempotencyStore().set(idempotencyKey, {
      __status: "done",
      response,
    });
  }

  return response;
}
