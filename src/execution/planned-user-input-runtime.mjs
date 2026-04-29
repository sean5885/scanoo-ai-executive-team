export const PLANNED_USER_INPUT_RUNTIME_VERSION = "planned-user-input-runtime-v1";

function resolveWorkingMemorySeedDecision({
  text = "",
  taskType = "",
  payload = {},
  sessionKey = "",
  logger = console,
  deps = {},
} = {}) {
  const memoryContinuation = deps.resolvePlannerWorkingMemoryContinuation({
    userIntent: text,
    taskType,
    payload,
    sessionKey,
    logger,
    stage: "executePlannedUserInput",
  });
  const selectedAction = deps.cleanText(memoryContinuation?.selected_action || "");
  if (!selectedAction || !deps.canUseWorkingMemoryAction(selectedAction, { text })) {
    return {
      decision: null,
      observability: memoryContinuation?.observability || null,
    };
  }
  const workingMemorySnapshot = memoryContinuation?.observability?.memory_snapshot
    && typeof memoryContinuation.observability.memory_snapshot === "object"
    && !Array.isArray(memoryContinuation.observability.memory_snapshot)
    ? memoryContinuation.observability.memory_snapshot
    : null;
  return {
    decision: {
      action: selectedAction,
      params: deps.buildPlannerWorkingMemoryContinuationParams({
        action: selectedAction,
        text,
        payload,
        workingMemory: workingMemorySnapshot,
      }),
      reason: deps.cleanText(memoryContinuation?.reason || "") || "working_memory_reuse_action",
    },
    observability: memoryContinuation?.observability || null,
  };
}

export function createPlannedUserInputExecutionRuntime(deps = {}) {
  const requiredFunctions = [
    "cleanText",
    "derivePlannerAbortInfo",
    "normalizeDecisionAlternative",
    "resolvePlannerWorkingMemoryContinuation",
    "canUseWorkingMemoryAction",
    "buildPlannerWorkingMemoryContinuationParams",
    "validatePlannerUserInputDecision",
    "withUserInputDecisionExplanation",
    "planUserInputAction",
    "buildTaskLayerPlannerResult",
    "resolveRuntimeInfoFastPathDecision",
    "logPlannerWorkingMemoryTrace",
    "createPlannerVisibleTelemetryMonitor",
    "emitPlannerVisibleTelemetryForMonitor",
    "buildPlannerAbortResult",
    "buildPlannerAgentOutput",
    "normalizePlannerFormattedOutput",
    "extractPlannerFormattedOutput",
    "copyPlannerVisibleTelemetryContext",
    "resolveDeterministicPlannerFallbackSelection",
    "emitPlannerFailedAlert",
    "buildPlannerMultiStepOutput",
    "buildPlannerLastErrorRecord",
    "normalizePlannerPayload",
    "getPlannerDecisionRepresentativeAction",
    "normalizeDecisionReasoning",
  ];
  for (const key of requiredFunctions) {
    if (typeof deps[key] !== "function") {
      throw new Error(`planned user input runtime missing dependency: ${key}`);
    }
  }

  async function executePlannedUserInput(options = {}) {
    const {
      text = "",
      requester = null,
      logger = console,
      contentReader,
      documentFetcher = null,
      baseUrl = "",
      toolFlowRunner = null,
      multiStepRunner = null,
      dispatcher = null,
      plannedDecision = null,
      resume_from_step = null,
      previous_results = [],
      max_retries = 0,
      retryable_error_types = ["tool_error", "runtime_exception"],
      authContext = null,
      signal = null,
      sessionKey = "",
      decisionMemory = null,
      requestId = "",
      telemetryAdapter = null,
      runSkill = null,
      taskLayerRunner = null,
    } = options;

    const preAbortInfo = deps.derivePlannerAbortInfo({ signal });
    if (preAbortInfo) {
      return {
        ok: false,
        error: preAbortInfo.code,
        execution_result: null,
        formatted_output: null,
        trace_id: null,
        why: null,
        alternative: deps.normalizeDecisionAlternative(null),
      };
    }
    if (typeof runSkill === "function" && typeof taskLayerRunner === "function") {
      try {
        const taskLayerResult = await taskLayerRunner(text, runSkill);
        if (Array.isArray(taskLayerResult?.tasks) && taskLayerResult.tasks.length > 1) {
          return deps.buildTaskLayerPlannerResult(taskLayerResult);
        }
      } catch (error) {
        logger?.warn?.("planner_task_layer_prepass_failed", {
          error: deps.cleanText(error?.message || "") || String(error),
        });
      }
    }

    const normalizedSessionKey = deps.cleanText(sessionKey);
    const memorySeedDecision = plannedDecision || !normalizedSessionKey
      ? { decision: null, observability: null }
      : resolveWorkingMemorySeedDecision({
          text,
          taskType: "",
          payload: {},
          sessionKey: normalizedSessionKey,
          logger,
          deps,
        });
    const runtimeInfoFastPathDecision = plannedDecision
      || memorySeedDecision.decision
      || requester !== deps.defaultRequester
      ? null
      : deps.resolveRuntimeInfoFastPathDecision({
          text,
          logger,
          sessionKey: normalizedSessionKey,
        });
    if (runtimeInfoFastPathDecision) {
      logger?.info?.("planner_runtime_info_fast_path", {
        action: runtimeInfoFastPathDecision.action,
        reason: "deterministic_runtime_info_without_llm_plan",
      });
    }

    const prePlannedDecision = plannedDecision || memorySeedDecision.decision;
    const effectivePrePlannedDecision = prePlannedDecision || runtimeInfoFastPathDecision;
    const decision = effectivePrePlannedDecision
      ? (() => {
          const validatedDecision = deps.validatePlannerUserInputDecision(effectivePrePlannedDecision, { text });
          if (validatedDecision?.ok !== true) {
            return deps.withUserInputDecisionExplanation(validatedDecision, { text });
          }
          return deps.withUserInputDecisionExplanation(
            Array.isArray(validatedDecision.steps)
              ? { steps: validatedDecision.steps }
              : {
                  action: validatedDecision.action,
                  params: validatedDecision.params,
                },
            { text },
          );
        })()
      : await deps.planUserInputAction({
          text,
          requester,
          signal,
          sessionKey,
          decisionMemory,
        });
    const memorySeedObservability = memorySeedDecision?.observability
      && typeof memorySeedDecision.observability === "object"
      ? {
          ...memorySeedDecision.observability,
          memory_used_in_routing: Boolean(!plannedDecision && memorySeedDecision.decision && !decision?.error),
        }
      : null;
    if (memorySeedObservability) {
      deps.logPlannerWorkingMemoryTrace({
        logger,
        memoryStage: "executePlannedUserInput_preplan",
        sessionKey,
        observability: memorySeedObservability,
        selectedAction: memorySeedDecision?.decision?.action || null,
        level: "debug",
      });
    }
    const plannerVisibleMonitor = !decision?.error && !Array.isArray(decision?.steps)
      ? deps.createPlannerVisibleTelemetryMonitor({
          text,
          selectedAction: decision?.action,
          decisionReason: decision?.why || "",
          requestId,
          telemetryAdapter,
        })
      : null;
    deps.emitPlannerVisibleTelemetryForMonitor({
      monitor: plannerVisibleMonitor,
      selectedAction: decision?.action,
    });

    if (decision?.error) {
      if (decision.error === "semantic_mismatch") {
        let reroutedResult = null;
        try {
          reroutedResult = await toolFlowRunner({
            userIntent: text,
            payload: {},
            logger,
            contentReader,
            baseUrl,
            authContext,
            signal,
            sessionKey,
            telemetryAdapter,
          });
        } catch (error) {
          const abortedResult = deps.buildPlannerAbortResult({
            signal,
            error,
          });
          if (abortedResult) {
            reroutedResult = deps.buildPlannerAgentOutput({
              selectedAction: null,
              executionResult: abortedResult,
              formattedOutput: null,
              traceId: abortedResult.trace_id || null,
              routingReason: "semantic_mismatch_reroute_aborted",
            });
          } else {
            throw error;
          }
        }

        if (reroutedResult?.execution_result) {
          logger?.info?.("planner_semantic_mismatch_reroute", {
            original_action: deps.cleanText(decision?.action || decision?.steps?.[0]?.action || "") || null,
            rerouted_action: deps.cleanText(reroutedResult?.selected_action || "") || null,
            reroute_ok: reroutedResult?.execution_result?.ok === true,
            reroute_error: deps.cleanText(reroutedResult?.execution_result?.error || "") || null,
            reroute_reason: deps.cleanText(reroutedResult?.routing_reason || "") || null,
            trace_id: reroutedResult?.trace_id || null,
          });
          const output = {
            ok: reroutedResult?.execution_result?.ok === true,
            action: deps.cleanText(reroutedResult?.selected_action || "") || null,
            params: null,
            error: deps.cleanText(reroutedResult?.execution_result?.error || "") || null,
            execution_result: reroutedResult?.execution_result || null,
            formatted_output: deps.normalizePlannerFormattedOutput(
              reroutedResult?.formatted_output || deps.extractPlannerFormattedOutput(reroutedResult?.execution_result),
            ),
            synthetic_agent_hint: reroutedResult?.synthetic_agent_hint || null,
            trace_id: reroutedResult?.trace_id || null,
            why: "原始 decision 與這輪需求不一致，所以先改走 reroute。",
            alternative: deps.normalizeDecisionAlternative(decision?.alternative),
          };
          deps.copyPlannerVisibleTelemetryContext(reroutedResult, output);
          return output;
        }
      }

      if (decision.error === "planner_failed") {
        const deterministicFallback = deps.resolveDeterministicPlannerFallbackSelection({
          text,
          logger,
          sessionKey,
        });
        if (deterministicFallback?.selection?.selected_action) {
          let reroutedResult;
          try {
            reroutedResult = await toolFlowRunner({
              userIntent: text,
              payload: deterministicFallback.payload || {},
              logger,
              contentReader,
              baseUrl,
              authContext,
              forcedSelection: deterministicFallback.selection,
              disableAutoRouting: true,
              signal,
              sessionKey,
              requestId: plannerVisibleMonitor?.context?.request_id || requestId,
              telemetryContext: plannerVisibleMonitor?.context || null,
              telemetryAdapter,
            });
          } catch (error) {
            const abortedResult = deps.buildPlannerAbortResult({
              action: deterministicFallback.selection.selected_action,
              signal,
              error,
            });
            if (abortedResult) {
              reroutedResult = deps.buildPlannerAgentOutput({
                selectedAction: deterministicFallback.selection.selected_action,
                executionResult: abortedResult,
                traceId: abortedResult.trace_id || null,
                routingReason: deterministicFallback.selection.routing_reason,
                payload: deterministicFallback.payload || {},
              });
            } else {
              throw error;
            }
          }

          if (reroutedResult?.execution_result) {
            const output = {
              ok: reroutedResult?.execution_result?.ok === true,
              action: deps.cleanText(reroutedResult?.selected_action || deterministicFallback.selection.selected_action) || null,
              params: deterministicFallback.payload || {},
              error: deps.cleanText(reroutedResult?.execution_result?.error || "") || null,
              execution_result: reroutedResult?.execution_result || null,
              formatted_output: deps.normalizePlannerFormattedOutput(
                reroutedResult?.formatted_output || deps.extractPlannerFormattedOutput(reroutedResult?.execution_result),
              ),
              synthetic_agent_hint: reroutedResult?.synthetic_agent_hint || null,
              trace_id: reroutedResult?.trace_id || null,
              why: "strict planner decision 缺失時，改走 bounded deterministic read/runtime fallback。",
              alternative: deps.normalizeDecisionAlternative(decision?.alternative),
            };
            deps.copyPlannerVisibleTelemetryContext(reroutedResult, output);
            return output;
          }
        }
        deps.emitPlannerFailedAlert({
          text,
          reason: "invalid_planned_decision",
          source: "execute_planned_user_input",
        });
      }

      return {
        ok: false,
        ...decision,
        execution_result: null,
        formatted_output: null,
        trace_id: null,
      };
    }

    if (Array.isArray(decision.steps)) {
      let runtimeResult;
      try {
        runtimeResult = await multiStepRunner({
          steps: decision.steps,
          logger,
          requestText: text,
          documentFetcher,
          resume_from_step,
          previous_results,
          max_retries,
          retryable_error_types,
          authContext,
          signal,
          async dispatcher({ action, payload, requestText: stepRequestText, context }) {
            return dispatcher({
              action,
              payload,
              requestText: stepRequestText,
              context,
              logger,
              baseUrl,
              authContext,
              signal,
            });
          },
        });
      } catch (error) {
        const abortedResult = deps.buildPlannerAbortResult({ signal, error });
        if (abortedResult) {
          runtimeResult = deps.buildPlannerMultiStepOutput({
            ok: false,
            steps: decision.steps.map((step) => ({ action: step.action })),
            results: [],
            traceId: abortedResult.trace_id || null,
            error: abortedResult.error,
            stopped: true,
            stoppedAtStep: null,
            currentStepIndex: 0,
            lastError: deps.buildPlannerLastErrorRecord(abortedResult),
            retryCount: 0,
          });
        } else {
          throw error;
        }
      }

      return {
        ok: runtimeResult?.ok === true,
        steps: decision.steps,
        error: deps.cleanText(runtimeResult?.error || "") || null,
        execution_result: runtimeResult || null,
        formatted_output: null,
        trace_id: runtimeResult?.trace_id || null,
        why: deps.cleanText(decision?.why || "") || null,
        alternative: deps.normalizeDecisionAlternative(decision?.alternative),
      };
    }

    let runtimeResult;
    try {
      runtimeResult = await toolFlowRunner({
        userIntent: text,
        payload: decision.params,
        logger,
        contentReader,
        baseUrl,
        authContext,
        forcedSelection: {
          selected_action: decision.action,
          reason: "strict_user_input_planner",
        },
        disableAutoRouting: true,
        signal,
        sessionKey,
        requestId: plannerVisibleMonitor?.context?.request_id || requestId,
        telemetryContext: plannerVisibleMonitor?.context || null,
        telemetryAdapter,
      });
    } catch (error) {
      const abortedResult = deps.buildPlannerAbortResult({
        action: decision.action,
        signal,
        error,
      });
      if (abortedResult) {
        runtimeResult = deps.buildPlannerAgentOutput({
          selectedAction: decision.action,
          executionResult: abortedResult,
          traceId: abortedResult.trace_id || null,
          routingReason: "strict_user_input_planner",
          payload: decision.params,
        });
      } else {
        throw error;
      }
    }

    const output = {
      ok: runtimeResult?.execution_result?.ok === true,
      action: decision.action,
      params: decision.params,
      error: deps.cleanText(runtimeResult?.execution_result?.error || "") || null,
      execution_result: runtimeResult?.execution_result || null,
      formatted_output: deps.normalizePlannerFormattedOutput(
        runtimeResult?.formatted_output || deps.extractPlannerFormattedOutput(runtimeResult?.execution_result),
      ),
      synthetic_agent_hint: runtimeResult?.synthetic_agent_hint || null,
      trace_id: runtimeResult?.trace_id || null,
      why: deps.cleanText(decision?.why || "") || null,
      alternative: deps.normalizeDecisionAlternative(decision?.alternative),
    };
    deps.copyPlannerVisibleTelemetryContext(runtimeResult, output);
    return output;
  }

  function buildPlannedUserInputEnvelope(result = {}) {
    const chosenAction = deps.cleanText(result.action || "") || deps.getPlannerDecisionRepresentativeAction(result) || null;
    const fallbackReason = deps.cleanText(
      result.reason
      || result.execution_result?.data?.reason
      || result.execution_result?.data?.stop_reason
      || result.error
      || "",
    ) || null;
    const reasoning = deps.normalizeDecisionReasoning({
      why: result?.why || "",
      alternative: result?.alternative || null,
    });
    if (!result || typeof result !== "object") {
      deps.emitPlannerFailedAlert({
        reason: "invalid_execution_result_shape",
        source: "planned_user_input_envelope",
      });
      return {
        ok: false,
        error: "planner_failed",
        formatted_output: null,
        trace_id: null,
        trace: {
          chosen_action: null,
          fallback_reason: "planner_failed",
          reasoning,
        },
      };
    }

    if (result.error && !result.execution_result) {
      if (deps.cleanText(result.error || "") === "planner_failed") {
        deps.emitPlannerFailedAlert({
          reason: deps.cleanText(result.reason || "") || "planner_failed_without_execution_result",
          source: "planned_user_input_envelope",
        });
      }
      const envelope = {
        ok: false,
        error: deps.cleanText(result.error || "") || "planner_failed",
        ...(deps.cleanText(result.action || "") ? { action: deps.cleanText(result.action) } : {}),
        params: deps.normalizePlannerPayload(result.params),
        ...(Array.isArray(result.steps)
          ? {
              steps: result.steps
                .map((step) => ({
                  action: deps.cleanText(step?.action || "") || null,
                  ...(step?.params && typeof step.params === "object" && !Array.isArray(step.params)
                    ? { params: deps.normalizePlannerPayload(step.params) }
                    : {}),
                  ...(deps.cleanText(step?.intent || "") ? { intent: deps.cleanText(step.intent) } : {}),
                  ...(typeof step?.required === "boolean" ? { required: step.required } : {}),
                }))
                .filter((step) => step.action),
            }
          : {}),
        ...(Number.isInteger(result.step_index) ? { step_index: result.step_index } : {}),
        ...(Array.isArray(result.violations) ? { violations: result.violations } : {}),
        ...(deps.cleanText(result.reason || "") ? { reason: deps.cleanText(result.reason) } : {}),
        ...(deps.cleanText(result.previous_user_text || "") ? { previous_user_text: deps.cleanText(result.previous_user_text) } : {}),
        ...(result.semantics ? { semantics: result.semantics } : {}),
        why: reasoning.why,
        alternative: reasoning.alternative,
        formatted_output: null,
        trace_id: result.trace_id || null,
        trace: {
          chosen_action: chosenAction,
          fallback_reason: fallbackReason,
          reasoning,
        },
      };
      deps.copyPlannerVisibleTelemetryContext(result, envelope);
      return envelope;
    }

    const envelope = {
      ok: result.ok === true,
      action: deps.cleanText(result.action || "") || null,
      params: deps.normalizePlannerPayload(result.params),
      ...(Array.isArray(result.steps)
        ? {
            steps: result.steps
              .map((step) => ({
                action: deps.cleanText(step?.action || "") || null,
                ...(step?.params && typeof step.params === "object" && !Array.isArray(step.params)
                  ? { params: deps.normalizePlannerPayload(step.params) }
                  : {}),
                ...(deps.cleanText(step?.intent || "") ? { intent: deps.cleanText(step.intent) } : {}),
                ...(typeof step?.required === "boolean" ? { required: step.required } : {}),
              }))
              .filter((step) => step.action),
          }
        : {}),
      error: deps.cleanText(result.error || "") || null,
      execution_result: result.execution_result || null,
      formatted_output: deps.normalizePlannerFormattedOutput(
        result.formatted_output || deps.extractPlannerFormattedOutput(result.execution_result),
      ),
      why: reasoning.why,
      alternative: reasoning.alternative,
      trace_id: result.trace_id || null,
      trace: {
        chosen_action: chosenAction,
        fallback_reason: fallbackReason,
        reasoning,
      },
    };
    deps.copyPlannerVisibleTelemetryContext(result, envelope);
    return envelope;
  }

  return {
    version: PLANNED_USER_INPUT_RUNTIME_VERSION,
    executePlannedUserInput,
    buildPlannedUserInputEnvelope,
  };
}
