import { cleanText } from "../message-intent-utils.mjs";
import { EVIDENCE_TYPES, verifyTaskCompletion } from "../executive-verifier.mjs";
import { executePlannedUserInput } from "../executive-planner.mjs";
import { resolveRecoveryDecisionV1 } from "../recovery-decision.mjs";
import { nowIso } from "../text-utils.mjs";
import {
  claimNextAutonomyJob,
  completeAutonomyAttempt,
  failAutonomyAttempt,
  heartbeatAutonomyAttempt,
} from "../task-runtime/autonomy-job-store.mjs";
import {
  DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
  DEFAULT_AUTONOMY_LEASE_MS,
  DEFAULT_AUTONOMY_POLL_INTERVAL_MS,
  isAutonomyEnabled,
  normalizePositiveInteger,
} from "../task-runtime/autonomy-job-types.mjs";
import {
  buildAutonomyTraceFields,
  createAutonomyJobAttemptTraceContext,
} from "../trace/autonomy-trace-context.mjs";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
};
const PLANNER_USER_INPUT_JOB_TYPE = "planner_user_input_v1";
const AUTONOMY_CANARY_SESSION_PREFIX = "autonomy-canary-";
const AUTONOMY_CANARY_TEXT_PATTERN = /\bautonomy canary\b/i;
const AUTONOMY_CANARY_MODE_ENV = "AUTONOMY_CANARY_MODE";
const DEFAULT_AUTONOMY_EXECUTE_TIMEOUT_MS = 60_000;
const AUTONOMY_EXECUTE_TIMEOUT_ENV = "AUTONOMY_EXECUTE_TIMEOUT_MS";

class AutonomyExecuteTimeoutError extends Error {
  constructor({ timeoutMs = DEFAULT_AUTONOMY_EXECUTE_TIMEOUT_MS } = {}) {
    super(`autonomy_execute_timeout_${timeoutMs}ms`);
    this.name = "AutonomyExecuteTimeoutError";
    this.timeout_ms = timeoutMs;
  }
}

function normalizeLogger(logger = null) {
  if (logger && typeof logger === "object") {
    return logger;
  }
  return noopLogger;
}

function resolveAutonomyExecuteTimeoutMs() {
  return normalizePositiveInteger(
    process.env[AUTONOMY_EXECUTE_TIMEOUT_ENV],
    DEFAULT_AUTONOMY_EXECUTE_TIMEOUT_MS,
    { min: 1_000, max: 30 * 60 * 1_000 },
  );
}

function withAutonomyExecuteTimeout({
  execute = null,
  executePromise = null,
  timeoutMs = DEFAULT_AUTONOMY_EXECUTE_TIMEOUT_MS,
  abortController = null,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutError = new AutonomyExecuteTimeoutError({ timeoutMs });
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      if (abortController && typeof abortController.abort === "function") {
        try {
          abortController.abort(timeoutError);
        } catch (_) {
          // no-op: timeout should still fail-soft through timeoutError below.
        }
      }
      reject(timeoutError);
    }, timeoutMs);

    const pendingExecution = typeof execute === "function"
      ? execute({
        signal: abortController?.signal || null,
      })
      : executePromise;

    Promise.resolve(pendingExecution).then((value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function buildNormalizedError(error) {
  if (error instanceof Error) {
    const normalized = {
      name: cleanText(error.name) || "Error",
      message: cleanText(error.message) || "unknown_error",
      stack: cleanText(error.stack) || null,
    };
    const timeoutMs = Number(error.timeout_ms);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      normalized.timeout_ms = Math.floor(timeoutMs);
    }
    return normalized;
  }
  return {
    name: "RuntimeError",
    message: cleanText(error) || "unknown_error",
  };
}

function shouldResultBeTreatedAsFailure(result = null) {
  return result && typeof result === "object" && result.ok === false;
}

function normalizeAutonomyEvidence(items = []) {
  return Array.isArray(items)
    ? items.filter((item) => item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function normalizeAutonomyExecutionResultObject(executionResult = null) {
  return executionResult && typeof executionResult === "object" && !Array.isArray(executionResult)
    ? executionResult
    : null;
}

function deriveAutonomyReplyText({ executionResult = null, gate = null } = {}) {
  const gateReply = cleanText(gate?.reply_text ?? gate?.replyText);
  if (gateReply) {
    return gateReply;
  }
  const resultObject = normalizeAutonomyExecutionResultObject(executionResult);
  if (resultObject) {
    return cleanText(
      resultObject.reply_text
      ?? resultObject.replyText
      ?? resultObject.reply?.text
      ?? resultObject.answer
      ?? resultObject.summary
      ?? resultObject.message
      ?? resultObject.output
      ?? "",
    );
  }
  return cleanText(executionResult);
}

function buildAutonomyVerificationInput({
  job = null,
  executionResult = null,
} = {}) {
  const resultObject = normalizeAutonomyExecutionResultObject(executionResult) || {};
  const gate = resultObject.verifier_gate && typeof resultObject.verifier_gate === "object" && !Array.isArray(resultObject.verifier_gate)
    ? resultObject.verifier_gate
    : {};
  const taskType = cleanText(gate.task_type ?? gate.taskType) || "search";
  const explicitExecutionJournal =
    gate.execution_journal && typeof gate.execution_journal === "object" && !Array.isArray(gate.execution_journal)
      ? gate.execution_journal
      : gate.executionJournal && typeof gate.executionJournal === "object" && !Array.isArray(gate.executionJournal)
        ? gate.executionJournal
        : null;
  const explicitEvidence = normalizeAutonomyEvidence(gate.evidence);
  const fallbackEvidence = explicitEvidence.length > 0
    ? explicitEvidence
    : [{
      type: EVIDENCE_TYPES.tool_output,
      summary: `autonomy_job_result:${cleanText(job?.job_type) || "unknown_job_type"}`,
    }];
  const replyText = deriveAutonomyReplyText({
    executionResult,
    gate,
  });
  const structuredResult =
    gate.structured_result !== undefined
      ? gate.structured_result
      : gate.structuredResult !== undefined
        ? gate.structuredResult
        : resultObject.structured_result !== undefined
          ? resultObject.structured_result
          : resultObject.structuredResult !== undefined
            ? resultObject.structuredResult
            : null;
  const expectedOutputSchema =
    gate.expected_output_schema !== undefined
      ? gate.expected_output_schema
      : gate.expectedOutputSchema !== undefined
        ? gate.expectedOutputSchema
        : null;

  if (explicitExecutionJournal) {
    return {
      taskType,
      executionJournal: {
        ...explicitExecutionJournal,
        raw_evidence: Array.isArray(explicitExecutionJournal.raw_evidence)
          ? explicitExecutionJournal.raw_evidence
          : fallbackEvidence,
        reply_text: cleanText(explicitExecutionJournal.reply_text ?? explicitExecutionJournal.replyText) || replyText,
        structured_result:
          explicitExecutionJournal.structured_result !== undefined
            ? explicitExecutionJournal.structured_result
            : explicitExecutionJournal.structuredResult !== undefined
              ? explicitExecutionJournal.structuredResult
              : structuredResult,
        expected_output_schema:
          explicitExecutionJournal.expected_output_schema !== undefined
            ? explicitExecutionJournal.expected_output_schema
            : explicitExecutionJournal.expectedOutputSchema !== undefined
              ? explicitExecutionJournal.expectedOutputSchema
              : expectedOutputSchema,
      },
    };
  }

  return {
    taskType,
    executionJournal: {
      classified_intent: cleanText(job?.job_type) || taskType,
      selected_action: cleanText(job?.job_type) || "autonomy_job",
      dispatched_actions: [],
      raw_evidence: fallbackEvidence,
      fallback_used: false,
      tool_required: false,
      synthetic_agent_hint: null,
      reply_text: replyText,
      structured_result: structuredResult,
      expected_output_schema: expectedOutputSchema,
    },
  };
}

function runAutonomyVerifierGate({
  job = null,
  executionResult = null,
} = {}) {
  const normalizedInput = buildAutonomyVerificationInput({
    job,
    executionResult,
  });
  const verification = verifyTaskCompletion({
    taskType: normalizedInput.taskType,
    executionJournal: normalizedInput.executionJournal,
  });

  return {
    pass: verification?.pass === true,
    reason: cleanText(
      verification?.execution_policy_reason
      || (Array.isArray(verification?.issues) ? verification.issues[0] : "")
      || "verifier_failed",
    ) || "verifier_failed",
    task_type: normalizedInput.taskType,
    execution_journal: normalizedInput.executionJournal,
    verification,
  };
}

function buildAutonomyStoredResult({
  executionResult = null,
  verifierGateResult = null,
} = {}) {
  const gateSummary = verifierGateResult && typeof verifierGateResult === "object"
    ? {
      pass: verifierGateResult.pass === true,
      reason: cleanText(verifierGateResult.reason) || null,
      task_type: cleanText(verifierGateResult.task_type) || null,
      issues: Array.isArray(verifierGateResult.verification?.issues) ? verifierGateResult.verification.issues : [],
    }
    : null;
  const normalized = normalizeAutonomyExecutionResultObject(executionResult);
  if (normalized) {
    return {
      ...normalized,
      verifier_gate_result: gateSummary,
    };
  }
  return {
    value: executionResult,
    verifier_gate_result: gateSummary,
  };
}

function normalizeAutonomyObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeAutonomyStringList(items = []) {
  return Array.isArray(items)
    ? items
      .map((item) => cleanText(item))
      .filter(Boolean)
    : [];
}

function buildPlannerUserInputAutonomyResult({
  plannerResult = null,
  resolvedTraceId = "",
  replyText = "",
  structuredResult = null,
} = {}) {
  const normalizedPlannerResult = normalizeAutonomyObject(plannerResult) || {};
  const normalizedExecutionResult = normalizeAutonomyObject(normalizedPlannerResult.execution_result) || {};
  const explicitGate = normalizeAutonomyObject(
    normalizedPlannerResult.verifier_gate || normalizedExecutionResult.verifier_gate,
  );
  const selectedAction = cleanText(
    normalizedPlannerResult.action
    || normalizedExecutionResult.action,
  ) || null;
  return {
    ok: true,
    job_type: PLANNER_USER_INPUT_JOB_TYPE,
    selected_action: selectedAction,
    trace_id: resolvedTraceId || null,
    reply_text: replyText || null,
    structured_result: structuredResult,
    verifier_gate: explicitGate || {
      task_type: "search",
      evidence: [{
        type: EVIDENCE_TYPES.tool_output,
        summary: "planner_user_input_v1_execute_planner",
      }],
      structured_result: structuredResult,
      reply_text: replyText || null,
    },
    planner_result: {
      ok: normalizedPlannerResult.ok === true,
      action: selectedAction,
      trace_id: resolvedTraceId || null,
      error: null,
    },
  };
}

function shouldSeedPlannerDecisionForAutonomyCanary({
  text = "",
  sessionKey = "",
  canaryModeEnabled = cleanText(process.env[AUTONOMY_CANARY_MODE_ENV]).toLowerCase() === "true",
} = {}) {
  if (canaryModeEnabled !== true) {
    return false;
  }
  const normalizedText = cleanText(text);
  const normalizedSessionKey = cleanText(sessionKey);
  return AUTONOMY_CANARY_TEXT_PATTERN.test(normalizedText)
    || normalizedSessionKey.startsWith(AUTONOMY_CANARY_SESSION_PREFIX);
}

async function executePlannerUserInputAutonomyJob({
  job = null,
  logger = null,
  plannerExecutor = executePlannedUserInput,
  signal = null,
} = {}) {
  const resolvedPlannerExecutor = typeof plannerExecutor === "function"
    ? plannerExecutor
    : executePlannedUserInput;
  if (typeof resolvedPlannerExecutor !== "function") {
    return {
      ok: false,
      error: "planner_executor_unavailable",
      reason: "missing_planner_executor",
      workflow: PLANNER_USER_INPUT_JOB_TYPE,
    };
  }

  const payload = normalizeAutonomyObject(job?.payload);
  const plannerInput = normalizeAutonomyObject(payload?.planner_input);
  const schemaVersion = cleanText(payload?.schema_version);
  const text = cleanText(plannerInput?.text);
  const plannerSessionKey = cleanText(plannerInput.session_key);
  if (
    !payload
    || !plannerInput
    || !text
    || (schemaVersion && schemaVersion !== PLANNER_USER_INPUT_JOB_TYPE)
  ) {
    return {
      ok: false,
      error: "planner_user_input_payload_invalid",
      reason: "invalid_planner_user_input_payload",
      workflow: PLANNER_USER_INPUT_JOB_TYPE,
      data: {
        has_payload: Boolean(payload),
        has_planner_input: Boolean(plannerInput),
        has_text: Boolean(text),
        schema_version: schemaVersion || null,
      },
    };
  }

  const plannedDecision = shouldSeedPlannerDecisionForAutonomyCanary({
    text,
    sessionKey: plannerSessionKey,
  })
    ? {
      action: "get_runtime_info",
      params: {},
    }
    : null;

  const plannerResult = await resolvedPlannerExecutor({
    text,
    logger,
    baseUrl: cleanText(plannerInput.base_url) || undefined,
    authContext: null,
    sessionKey: plannerSessionKey,
    requestId: cleanText(plannerInput.request_id),
    plannedDecision,
    telemetryAdapter: null,
    signal,
  });
  const normalizedPlannerResult = normalizeAutonomyObject(plannerResult);
  if (!normalizedPlannerResult) {
    return {
      ok: false,
      error: "planner_execution_invalid_result",
      reason: "planner_result_not_object",
      workflow: PLANNER_USER_INPUT_JOB_TYPE,
    };
  }
  const normalizedExecutionResult = normalizeAutonomyObject(normalizedPlannerResult.execution_result);
  const plannerError = cleanText(
    normalizedPlannerResult.error
    || normalizedExecutionResult?.error,
  );
  if (normalizedPlannerResult.ok !== true || plannerError) {
    return {
      ok: false,
      error: plannerError || "planner_execution_failed",
      reason: cleanText(
        normalizedPlannerResult.why
        || normalizedExecutionResult?.reason
        || normalizedExecutionResult?.error,
      ) || null,
      workflow: PLANNER_USER_INPUT_JOB_TYPE,
      data: {
        action: cleanText(normalizedPlannerResult.action) || null,
      },
    };
  }

  if (normalizedExecutionResult?.ok === false) {
    return {
      ok: false,
      error: cleanText(normalizedExecutionResult.error) || "planner_execution_failed",
      reason: cleanText(
        normalizedExecutionResult.reason
        || normalizedExecutionResult.error,
      ) || null,
      workflow: PLANNER_USER_INPUT_JOB_TYPE,
      data: {
        action: cleanText(normalizedPlannerResult.action || normalizedExecutionResult.action) || null,
      },
    };
  }

  const executionData = normalizeAutonomyObject(normalizedExecutionResult?.data);
  const formattedOutput = normalizeAutonomyObject(normalizedPlannerResult?.formatted_output);
  const answerText = cleanText(
    executionData?.answer
    || formattedOutput?.answer
    || normalizedExecutionResult?.answer
    || normalizedPlannerResult?.answer
    || normalizedPlannerResult?.why
    || "",
  );
  const structuredResult = {
    answer: answerText || null,
    sources: normalizeAutonomyStringList(executionData?.sources || formattedOutput?.sources),
    limitations: normalizeAutonomyStringList(executionData?.limitations || formattedOutput?.limitations),
  };
  const hasStructuredResult =
    structuredResult.answer
    || structuredResult.sources.length > 0
    || structuredResult.limitations.length > 0;
  const resolvedTraceId = cleanText(
    normalizedPlannerResult.trace_id
    || normalizedExecutionResult.trace_id
    || plannerInput.trace_id
    || job?.trace_id,
  );

  return buildPlannerUserInputAutonomyResult({
    plannerResult: normalizedPlannerResult,
    resolvedTraceId,
    replyText: answerText,
    structuredResult: hasStructuredResult ? structuredResult : null,
  });
}

async function executeKnownAutonomyJob({
  job = null,
  logger = null,
  plannerExecutor = executePlannedUserInput,
  signal = null,
} = {}) {
  const normalizedJobType = cleanText(job?.job_type);
  if (normalizedJobType === PLANNER_USER_INPUT_JOB_TYPE) {
    return executePlannerUserInputAutonomyJob({
      job,
      logger,
      plannerExecutor,
      signal,
    });
  }
  return {
    ok: false,
    error: "unsupported_job_type",
    reason: cleanText(normalizedJobType) || "unknown_job_type",
    data: {
      job_type: normalizedJobType || null,
    },
  };
}

function readAutonomyNumericSignal(...candidates) {
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") {
      continue;
    }
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) {
      return Math.max(0, Math.floor(numeric));
    }
  }
  return null;
}

function readAutonomyBooleanSignal(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "boolean") {
      return candidate;
    }
    if (candidate === "true") {
      return true;
    }
    if (candidate === "false") {
      return false;
    }
  }
  return null;
}

function inferAutonomyFailureClass({
  failureClass = "",
  error = "",
  verification = null,
} = {}) {
  const explicitFailureClass = cleanText(failureClass).toLowerCase();
  if (explicitFailureClass) {
    return explicitFailureClass;
  }

  const verificationIssues = Array.isArray(verification?.issues)
    ? verification.issues.map((issue) => cleanText(issue).toLowerCase()).filter(Boolean)
    : [];
  const normalizedError = cleanText(error).toLowerCase();

  if (verificationIssues.includes("missing_slot") || normalizedError.includes("missing_slot")) {
    return "missing_slot";
  }
  if (verificationIssues.includes("permission_denied") || normalizedError.includes("permission_denied")) {
    return "permission_denied";
  }
  if (verificationIssues.includes("effect_committed") || normalizedError.includes("effect_committed")) {
    return "effect_committed";
  }
  if (verificationIssues.includes("commit_unknown") || normalizedError.includes("commit_unknown")) {
    return "commit_unknown";
  }
  return "";
}

function buildRecoveryDecisionSnapshot(decision = null) {
  const nextState = cleanText(decision?.next_state || "") || "blocked";
  const routingHint = cleanText(decision?.routing_hint || "");
  return {
    reason: cleanText(decision?.reason || "") || "recovery_decision_v1_unknown",
    next_state: nextState,
    next_status: cleanText(decision?.next_status || "") || "blocked",
    routing_hint: routingHint,
    waiting_user: nextState === "blocked" && routingHint.endsWith("_waiting_user"),
  };
}

function deriveLifecycleSinkFromRecoveryDecision(decision = null) {
  const nextState = cleanText(decision?.next_state || "").toLowerCase();
  const routingHint = cleanText(decision?.routing_hint || "");
  const reason = cleanText(decision?.reason || "") || "recovery_decision_v1_unknown";

  if (nextState === "blocked" && routingHint.endsWith("_waiting_user")) {
    return {
      state: "waiting_user",
      reason,
      routing_hint: routingHint || null,
    };
  }

  if (nextState === "escalated") {
    return {
      state: "escalated",
      reason,
      routing_hint: routingHint || null,
    };
  }

  return null;
}

function normalizeAutonomyFailure({
  job = null,
  error = "",
  failureClass = "",
  retryable = null,
  maxRetries = null,
  workflow = "",
  verification = null,
  reason = "",
  data = null,
  source = "",
  runtimeError = null,
} = {}) {
  const retryCount = readAutonomyNumericSignal(job?.attempt_count, 0) ?? 0;
  const normalizedMaxRetries = Math.max(
    1,
    readAutonomyNumericSignal(maxRetries, job?.max_attempts, 1) ?? 1,
  );
  const normalizedError = cleanText(error) || "job_execution_failed";
  const normalizedVerification = normalizeAutonomyObject(verification);
  const normalizedWorkflow = cleanText(workflow) || cleanText(job?.job_type) || "autonomy_job";
  const normalizedRetryable = readAutonomyBooleanSignal(retryable);
  const normalizedFailureClass = inferAutonomyFailureClass({
    failureClass,
    error: normalizedError,
    verification: normalizedVerification,
  });

  const decision = resolveRecoveryDecisionV1({
    error: normalizedError,
    failure_class: normalizedFailureClass,
    retryable: normalizedRetryable,
    retry_count: retryCount,
    max_retries: normalizedMaxRetries,
    workflow: normalizedWorkflow,
    verification: normalizedVerification,
  });
  const recoveryDecision = buildRecoveryDecisionSnapshot(decision);
  const lifecycleSink = deriveLifecycleSinkFromRecoveryDecision(decision);

  const failure = {
    error: normalizedError,
    reason: cleanText(reason) || null,
    failure_class: normalizedFailureClass || null,
    retryable: normalizedRetryable,
    retry_count: retryCount,
    max_retries: normalizedMaxRetries,
    workflow: normalizedWorkflow,
    verification: normalizedVerification,
    recovery_decision: recoveryDecision,
    source: cleanText(source) || "autonomy_worker_loop",
  };
  if (lifecycleSink) {
    failure.lifecycle_sink = {
      state: lifecycleSink.state,
      reason: lifecycleSink.reason,
      failure_class: normalizedFailureClass || null,
      routing_hint: lifecycleSink.routing_hint,
      at: nowIso(),
    };
  }

  if (data !== undefined) {
    failure.data = data;
  }
  if (runtimeError) {
    failure.runtime_error = runtimeError;
  }

  return {
    decision,
    recoveryDecision,
    failure,
    failRetryable: recoveryDecision.next_state === "executing",
  };
}

function buildAutonomyFailureLogFields({
  normalizedFailure = null,
  retryScheduled = false,
} = {}) {
  if (!normalizedFailure || typeof normalizedFailure !== "object") {
    return {
      retry_scheduled: retryScheduled === true,
    };
  }
  const verificationIssues = Array.isArray(normalizedFailure.failure?.verification?.issues)
    ? normalizedFailure.failure.verification.issues
    : [];
  return {
    error: normalizedFailure.failure?.error || "job_execution_failed",
    reason: normalizedFailure.failure?.reason || normalizedFailure.recoveryDecision?.reason || null,
    failure_class: normalizedFailure.failure?.failure_class || null,
    retryable: normalizedFailure.failure?.retryable,
    retry_count: normalizedFailure.failure?.retry_count ?? 0,
    max_retries: normalizedFailure.failure?.max_retries ?? 1,
    workflow: normalizedFailure.failure?.workflow || "autonomy_job",
    verification_issues: verificationIssues,
    recovery_decision: normalizedFailure.recoveryDecision || null,
    lifecycle_sink_state: normalizedFailure.failure?.lifecycle_sink?.state || null,
    lifecycle_sink_reason: normalizedFailure.failure?.lifecycle_sink?.reason || null,
    retry_scheduled: retryScheduled === true,
  };
}

export async function runAutonomyWorkerOnce({
  workerId = "",
  executeJob = null,
  plannerExecutor = executePlannedUserInput,
  logger = null,
  enabled = null,
  leaseMs = DEFAULT_AUTONOMY_LEASE_MS,
  heartbeatIntervalMs = DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
  executeTimeoutMs = null,
} = {}) {
  const resolvedLogger = normalizeLogger(logger);
  const normalizedWorkerId = cleanText(workerId);
  if (!normalizedWorkerId) {
    return {
      ok: false,
      error: "missing_worker_id",
    };
  }

  const autonomyEnabled = enabled == null ? isAutonomyEnabled() : enabled === true;
  if (!autonomyEnabled) {
    return {
      ok: true,
      skipped: true,
      reason: "autonomy_disabled",
    };
  }

  const claim = claimNextAutonomyJob({
    workerId: normalizedWorkerId,
    leaseMs: normalizePositiveInteger(leaseMs, DEFAULT_AUTONOMY_LEASE_MS),
  });
  if (!claim?.job?.id || !claim?.attempt?.id) {
    if (claim?.skipped) {
      return {
        ok: true,
        claimed: false,
        skipped: true,
        reason: cleanText(claim.reason) || "claim_skipped",
      };
    }
    return {
      ok: true,
      claimed: false,
    };
  }

  const traceContext = createAutonomyJobAttemptTraceContext({
    job: claim.job,
    attempt: claim.attempt,
    workerId: normalizedWorkerId,
    source: "autonomy_worker_loop",
  });
  resolvedLogger.info("autonomy_job_claimed", buildAutonomyTraceFields({
    traceContext,
    fields: {
      job_type: claim.job.job_type,
      status: claim.job.status,
    },
  }));

  const normalizedHeartbeatIntervalMs = normalizePositiveInteger(
    heartbeatIntervalMs,
    DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
  );
  let heartbeatTimer = null;
  const beginHeartbeat = () => {
    heartbeatTimer = setInterval(() => {
      const heartbeat = heartbeatAutonomyAttempt({
        jobId: claim.job.id,
        attemptId: claim.attempt.id,
        workerId: normalizedWorkerId,
        leaseMs,
      });
      if (heartbeat?.ok !== true) {
        resolvedLogger.warn("autonomy_job_heartbeat_failed", buildAutonomyTraceFields({
          traceContext,
          fields: {
            error: cleanText(heartbeat?.error) || "heartbeat_failed",
          },
        }));
      }
    }, normalizedHeartbeatIntervalMs);
  };
  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const resolvedPlannerExecutor = typeof plannerExecutor === "function"
    ? plannerExecutor
    : executePlannedUserInput;
  const resolvedExecuteJob = typeof executeJob === "function"
    ? executeJob
    : async (input = {}) => executeKnownAutonomyJob({
      ...input,
      plannerExecutor: resolvedPlannerExecutor,
    });
  const normalizedExecuteTimeoutMs = normalizePositiveInteger(
    executeTimeoutMs,
    resolveAutonomyExecuteTimeoutMs(),
    { min: 1_000, max: 30 * 60 * 1_000 },
  );

  beginHeartbeat();
  try {
    const executeAbortController = typeof AbortController === "function"
      ? new AbortController()
      : null;
    const executionResult = await withAutonomyExecuteTimeout({
      timeoutMs: normalizedExecuteTimeoutMs,
      abortController: executeAbortController,
      execute: ({ signal } = {}) => resolvedExecuteJob({
        job: claim.job,
        attempt: claim.attempt,
        traceContext,
        logger: resolvedLogger,
        signal: signal || null,
      }),
    });

    if (shouldResultBeTreatedAsFailure(executionResult)) {
      const normalizedExecutionResult = normalizeAutonomyExecutionResultObject(executionResult) || {};
      const normalizedData = normalizeAutonomyObject(normalizedExecutionResult.data) || {};
      const normalizedFailure = normalizeAutonomyFailure({
        job: claim.job,
        source: "execute_job_result",
        error: cleanText(normalizedExecutionResult.error) || "job_execution_failed",
        failureClass: cleanText(
          normalizedExecutionResult.failure_class
          || normalizedData.failure_class,
        ),
        retryable: normalizedExecutionResult.retryable ?? normalizedData.retryable,
        maxRetries: normalizedExecutionResult.max_retries ?? normalizedData.max_retries,
        workflow: cleanText(
          normalizedExecutionResult.workflow
          || normalizedData.workflow
          || claim.job.job_type,
        ),
        verification: normalizedExecutionResult.verification ?? normalizedData.verification,
        reason: cleanText(normalizedExecutionResult.reason || normalizedData.reason),
        data: normalizedExecutionResult.data ?? null,
      });
      const failed = failAutonomyAttempt({
        jobId: claim.job.id,
        attemptId: claim.attempt.id,
        workerId: normalizedWorkerId,
        error: normalizedFailure.failure,
        retryable: normalizedFailure.failRetryable,
      });
      resolvedLogger.warn("autonomy_job_failed", buildAutonomyTraceFields({
        traceContext,
        fields: buildAutonomyFailureLogFields({
          normalizedFailure,
          retryScheduled: failed?.retry_scheduled === true,
        }),
      }));
      return {
        ok: false,
        claimed: true,
        failed: true,
        job_id: claim.job.id,
        attempt_id: claim.attempt.id,
        trace_id: traceContext.trace_id,
        error: normalizedFailure.failure.error,
        reason: normalizedFailure.failure.reason || normalizedFailure.recoveryDecision.reason,
        failure_class: normalizedFailure.failure.failure_class,
        retry_scheduled: failed?.retry_scheduled === true,
        recovery_decision: normalizedFailure.recoveryDecision,
      };
    }

    const verifierGateResult = runAutonomyVerifierGate({
      job: claim.job,
      executionResult,
    });
    if (verifierGateResult.pass !== true) {
      const normalizedExecutionResult = normalizeAutonomyExecutionResultObject(executionResult) || {};
      const normalizedData = normalizeAutonomyObject(normalizedExecutionResult.data) || {};
      const normalizedFailure = normalizeAutonomyFailure({
        job: claim.job,
        source: "verifier_gate",
        error: "verifier_failed",
        reason: verifierGateResult.reason,
        failureClass: cleanText(
          normalizedExecutionResult.failure_class
          || normalizedData.failure_class,
        ),
        retryable: normalizedExecutionResult.retryable ?? normalizedData.retryable,
        maxRetries: normalizedExecutionResult.max_retries ?? normalizedData.max_retries,
        workflow: cleanText(
          normalizedExecutionResult.workflow
          || normalizedData.workflow
          || verifierGateResult.task_type
          || claim.job.job_type,
        ),
        verification: verifierGateResult.verification,
      });
      const failed = failAutonomyAttempt({
        jobId: claim.job.id,
        attemptId: claim.attempt.id,
        workerId: normalizedWorkerId,
        error: normalizedFailure.failure,
        retryable: normalizedFailure.failRetryable,
      });
      resolvedLogger.warn("autonomy_job_verifier_blocked", buildAutonomyTraceFields({
        traceContext,
        fields: buildAutonomyFailureLogFields({
          normalizedFailure,
          retryScheduled: failed?.retry_scheduled === true,
        }),
      }));
      return {
        ok: false,
        claimed: true,
        failed: true,
        job_id: claim.job.id,
        attempt_id: claim.attempt.id,
        trace_id: traceContext.trace_id,
        error: normalizedFailure.failure.error,
        reason: normalizedFailure.failure.reason || verifierGateResult.reason,
        failure_class: normalizedFailure.failure.failure_class,
        retry_scheduled: failed?.retry_scheduled === true,
        recovery_decision: normalizedFailure.recoveryDecision,
      };
    }

    const complete = completeAutonomyAttempt({
      jobId: claim.job.id,
      attemptId: claim.attempt.id,
      workerId: normalizedWorkerId,
      result: buildAutonomyStoredResult({
        executionResult,
        verifierGateResult,
      }),
    });
    if (complete?.ok !== true) {
      resolvedLogger.warn("autonomy_job_complete_failed", buildAutonomyTraceFields({
        traceContext,
        fields: {
          error: cleanText(complete?.error) || "complete_failed",
        },
      }));
      return {
        ok: false,
        claimed: true,
        failed: true,
        error: cleanText(complete?.error) || "complete_failed",
      };
    }

    resolvedLogger.info("autonomy_job_completed", buildAutonomyTraceFields({
      traceContext,
      fields: {
        status: cleanText(complete?.job?.status) || "completed",
      },
    }));
    return {
      ok: true,
      claimed: true,
      completed: true,
      job_id: claim.job.id,
      attempt_id: claim.attempt.id,
      trace_id: traceContext.trace_id,
      result: executionResult,
    };
  } catch (error) {
    const normalizedError = buildNormalizedError(error);
    const normalizedFailure = normalizeAutonomyFailure({
      job: claim.job,
      source: "runtime_exception",
      error: normalizedError.message,
      reason: normalizedError.name,
      workflow: cleanText(claim.job?.job_type) || "autonomy_job",
      runtimeError: normalizedError,
    });
    const failed = failAutonomyAttempt({
      jobId: claim.job.id,
      attemptId: claim.attempt.id,
      workerId: normalizedWorkerId,
      error: normalizedFailure.failure,
      retryable: normalizedFailure.failRetryable,
    });
    resolvedLogger.error("autonomy_job_failed", buildAutonomyTraceFields({
      traceContext,
      fields: buildAutonomyFailureLogFields({
        normalizedFailure,
        retryScheduled: failed?.retry_scheduled === true,
      }),
    }));
    return {
      ok: false,
      claimed: true,
      failed: true,
      job_id: claim.job.id,
      attempt_id: claim.attempt.id,
      trace_id: traceContext.trace_id,
      error: normalizedError,
      failure_class: normalizedFailure.failure.failure_class,
      reason: normalizedFailure.failure.reason || normalizedFailure.recoveryDecision.reason,
      retry_scheduled: failed?.retry_scheduled === true,
      recovery_decision: normalizedFailure.recoveryDecision,
    };
  } finally {
    stopHeartbeat();
  }
}

export function startAutonomyWorkerLoop({
  workerId = "",
  executeJob = null,
  plannerExecutor = executePlannedUserInput,
  logger = null,
  enabled = null,
  pollIntervalMs = DEFAULT_AUTONOMY_POLL_INTERVAL_MS,
  leaseMs = DEFAULT_AUTONOMY_LEASE_MS,
  heartbeatIntervalMs = DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
} = {}) {
  const resolvedLogger = normalizeLogger(logger);
  const normalizedWorkerId = cleanText(workerId) || `autonomy-worker-${process.pid}`;
  const autonomyEnabled = enabled == null ? isAutonomyEnabled() : enabled === true;
  if (!autonomyEnabled) {
    resolvedLogger.info("autonomy_worker_loop_not_started", {
      worker_id: normalizedWorkerId,
      reason: "autonomy_disabled",
    });
    return {
      started: false,
      worker_id: normalizedWorkerId,
      stop() {},
    };
  }

  let running = false;
  let stopped = false;
  let timer = null;
  const interval = normalizePositiveInteger(
    pollIntervalMs,
    DEFAULT_AUTONOMY_POLL_INTERVAL_MS,
    { min: 250, max: 600_000 },
  );

  const scheduleTick = (delayMs = interval) => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void tick();
    }, Math.max(0, delayMs));
  };

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    let shouldDrainImmediately = false;
    try {
      const onceResult = await runAutonomyWorkerOnce({
        workerId: normalizedWorkerId,
        executeJob,
        plannerExecutor,
        logger: resolvedLogger,
        leaseMs,
        heartbeatIntervalMs,
        enabled: true,
      });
      shouldDrainImmediately = onceResult?.claimed === true;
    } finally {
      running = false;
      scheduleTick(shouldDrainImmediately ? 0 : interval);
    }
  };
  scheduleTick(0);

  resolvedLogger.info("autonomy_worker_loop_started", {
    worker_id: normalizedWorkerId,
    poll_interval_ms: interval,
  });

  return {
    started: true,
    worker_id: normalizedWorkerId,
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolvedLogger.info("autonomy_worker_loop_stopped", {
        worker_id: normalizedWorkerId,
      });
    },
  };
}
