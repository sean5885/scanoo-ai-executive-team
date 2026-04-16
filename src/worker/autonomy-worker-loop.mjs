import { cleanText } from "../message-intent-utils.mjs";
import { EVIDENCE_TYPES, verifyTaskCompletion } from "../executive-verifier.mjs";
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

function normalizeLogger(logger = null) {
  if (logger && typeof logger === "object") {
    return logger;
  }
  return noopLogger;
}

function buildNormalizedError(error) {
  if (error instanceof Error) {
    return {
      name: cleanText(error.name) || "Error",
      message: cleanText(error.message) || "unknown_error",
      stack: cleanText(error.stack) || null,
    };
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

export async function runAutonomyWorkerOnce({
  workerId = "",
  executeJob = async () => ({ ok: true }),
  logger = null,
  enabled = null,
  leaseMs = DEFAULT_AUTONOMY_LEASE_MS,
  heartbeatIntervalMs = DEFAULT_AUTONOMY_HEARTBEAT_INTERVAL_MS,
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

  beginHeartbeat();
  try {
    const executionResult = await executeJob({
      job: claim.job,
      attempt: claim.attempt,
      traceContext,
      logger: resolvedLogger,
    });

    if (shouldResultBeTreatedAsFailure(executionResult)) {
      const normalizedFailure = {
        error: cleanText(executionResult.error) || "job_execution_failed",
        data: executionResult.data || null,
      };
      failAutonomyAttempt({
        jobId: claim.job.id,
        attemptId: claim.attempt.id,
        workerId: normalizedWorkerId,
        error: normalizedFailure,
      });
      resolvedLogger.warn("autonomy_job_failed", buildAutonomyTraceFields({
        traceContext,
        fields: normalizedFailure,
      }));
      return {
        ok: false,
        claimed: true,
        failed: true,
        job_id: claim.job.id,
        attempt_id: claim.attempt.id,
        trace_id: traceContext.trace_id,
      };
    }

    const verifierGateResult = runAutonomyVerifierGate({
      job: claim.job,
      executionResult,
    });
    if (verifierGateResult.pass !== true) {
      const normalizedFailure = {
        error: "verifier_failed",
        reason: verifierGateResult.reason,
        verifier: verifierGateResult.verification,
      };
      const failed = failAutonomyAttempt({
        jobId: claim.job.id,
        attemptId: claim.attempt.id,
        workerId: normalizedWorkerId,
        error: normalizedFailure,
      });
      resolvedLogger.warn("autonomy_job_verifier_blocked", buildAutonomyTraceFields({
        traceContext,
        fields: {
          reason: verifierGateResult.reason,
          issues: verifierGateResult.verification?.issues || [],
          retry_scheduled: failed?.retry_scheduled === true,
        },
      }));
      return {
        ok: false,
        claimed: true,
        failed: true,
        job_id: claim.job.id,
        attempt_id: claim.attempt.id,
        trace_id: traceContext.trace_id,
        error: "verifier_failed",
        reason: verifierGateResult.reason,
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
    const failed = failAutonomyAttempt({
      jobId: claim.job.id,
      attemptId: claim.attempt.id,
      workerId: normalizedWorkerId,
      error: normalizedError,
    });
    resolvedLogger.error("autonomy_job_failed", buildAutonomyTraceFields({
      traceContext,
      fields: {
        error: normalizedError.message,
        retry_scheduled: failed?.retry_scheduled === true,
      },
    }));
    return {
      ok: false,
      claimed: true,
      failed: true,
      job_id: claim.job.id,
      attempt_id: claim.attempt.id,
      trace_id: traceContext.trace_id,
      error: normalizedError,
      retry_scheduled: failed?.retry_scheduled === true,
    };
  } finally {
    stopHeartbeat();
  }
}

export function startAutonomyWorkerLoop({
  workerId = "",
  executeJob = async () => ({ ok: true }),
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
  const interval = normalizePositiveInteger(
    pollIntervalMs,
    DEFAULT_AUTONOMY_POLL_INTERVAL_MS,
    { min: 250, max: 600_000 },
  );

  const tick = async () => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      await runAutonomyWorkerOnce({
        workerId: normalizedWorkerId,
        executeJob,
        logger: resolvedLogger,
        leaseMs,
        heartbeatIntervalMs,
        enabled: true,
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, interval);
  void tick();

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
      clearInterval(timer);
      resolvedLogger.info("autonomy_worker_loop_stopped", {
        worker_id: normalizedWorkerId,
      });
    },
  };
}
