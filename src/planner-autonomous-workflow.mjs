import { selectPlannerTool } from './executive-planner.mjs';
import { getSkillMetadata, normalizeSkillArgs } from './skill-registry.mjs';
import { executeTool, resolveToolExecutor } from './tool-execution-runtime.mjs';
import { normalizeToolInvocationArgs, resolveToolContract, validateToolInvocation } from './tool-layer-contract.mjs';
import { resolveToolResultContinuation } from './tool-result-continuation.mjs';

const DEFAULT_MAX_STEPS = 6;
const DEFAULT_RETRY_POLICY = Object.freeze({ max_retries: 2 });
const DEFAULT_AGENT_E2E_HARD_TIMEOUT_MS = 12_000;
const MIN_AGENT_E2E_HARD_TIMEOUT_MS = 25;
const READ_CHAIN_HINTS = Object.freeze({
  search_company_brain_docs: 'official_read_document',
  official_read_document: 'answer_user_directly',
});
const ACTION_SKILL_HINTS = Object.freeze({
  search_company_brain_docs: 'search_and_summarize',
  official_read_document: 'document_summarize',
});
const NULL_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

function normalizeText(value = '') {
  return String(value || '').trim();
}

function toFinitePositiveNumber(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return null;
  }
  return normalized;
}

function resolveAgentE2EHardTimeoutMs(context = {}) {
  const configuredHardTimeoutMs = toFinitePositiveNumber(context.agent_e2e_hard_timeout_ms)
    || toFinitePositiveNumber(context.agent_e2e_timeout_ms)
    || toFinitePositiveNumber(context.hard_timeout_ms)
    || toFinitePositiveNumber(process.env.AGENT_E2E_HARD_TIMEOUT_MS)
    || DEFAULT_AGENT_E2E_HARD_TIMEOUT_MS;
  const requestTimeoutMs = toFinitePositiveNumber(context.request_timeout_ms);
  const boundedByRequestTimeout = requestTimeoutMs == null
    ? configuredHardTimeoutMs
    : Math.min(
        configuredHardTimeoutMs,
        Math.max(MIN_AGENT_E2E_HARD_TIMEOUT_MS, Math.floor(requestTimeoutMs - MIN_AGENT_E2E_HARD_TIMEOUT_MS)),
      );
  return Math.max(MIN_AGENT_E2E_HARD_TIMEOUT_MS, Math.floor(boundedByRequestTimeout));
}

function buildAgentE2ETimeoutExecution({
  action = '',
  timeoutMs = null,
  elapsedMs = null,
  reason = 'agent_e2e_tool_execution_timeout',
} = {}) {
  return {
    ok: false,
    action: normalizeText(action || '') || null,
    error: 'request_timeout',
    next: 'fallback',
    trace_id: null,
    dispatch_result: null,
    result: {
      reason,
      timeout_ms: toFinitePositiveNumber(timeoutMs),
      elapsed_ms: toFinitePositiveNumber(elapsedMs),
    },
  };
}

function isAgentE2ETimeoutExecution(execution = {}) {
  if (!execution || typeof execution !== 'object') {
    return false;
  }
  if (normalizeText(execution.error) !== 'request_timeout') {
    return false;
  }
  return normalizeText(execution?.result?.reason || '').startsWith('agent_e2e_');
}

async function executeToolWithHardTimeout({
  action = '',
  args = {},
  context = {},
  timeoutMs = null,
  elapsedMs = null,
} = {}) {
  const normalizedTimeoutMs = toFinitePositiveNumber(timeoutMs);
  if (!normalizedTimeoutMs) {
    return executeTool(action, args, context);
  }

  const stepContext = context && typeof context === 'object' && !Array.isArray(context)
    ? { ...context }
    : {};
  const parentSignal = stepContext.signal && typeof stepContext.signal === 'object'
    ? stepContext.signal
    : null;
  const stepController = typeof AbortController === 'function' ? new AbortController() : null;
  const propagateAbort = () => {
    if (!stepController || stepController.signal.aborted) {
      return;
    }
    stepController.abort(parentSignal?.reason || {
      name: 'AbortError',
      code: 'request_cancelled',
      message: 'Agent E2E step cancelled by parent signal.',
    });
  };
  if (stepController) {
    if (parentSignal?.aborted) {
      propagateAbort();
    } else if (parentSignal?.addEventListener) {
      parentSignal.addEventListener('abort', propagateAbort, { once: true });
    }
    stepContext.signal = stepController.signal;
  }

  const executionPromise = Promise.resolve(executeTool(action, args, stepContext));
  let timeoutTriggered = false;
  let timeoutHandle = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      timeoutTriggered = true;
      if (stepController && !stepController.signal.aborted) {
        stepController.abort({
          name: 'AbortError',
          code: 'request_timeout',
          message: `Agent E2E tool step timed out after ${Math.floor(normalizedTimeoutMs)}ms.`,
          timeout_ms: Math.floor(normalizedTimeoutMs),
        });
      }
      resolve(buildAgentE2ETimeoutExecution({
        action,
        timeoutMs: normalizedTimeoutMs,
        elapsedMs,
      }));
    }, Math.floor(normalizedTimeoutMs));
  });

  let result = null;
  try {
    result = await Promise.race([executionPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (parentSignal?.removeEventListener) {
      parentSignal.removeEventListener('abort', propagateAbort);
    }
  }

  if (timeoutTriggered) {
    executionPromise.catch(() => {});
  }

  return result;
}

function normalizeContext(ctx = {}) {
  const context = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? { ...ctx } : {};
  const retryPolicy = context.retry_policy && typeof context.retry_policy === 'object'
    ? { ...context.retry_policy }
    : { ...DEFAULT_RETRY_POLICY };
  return {
    ...context,
    retry_count: Number.isFinite(Number(context.retry_count)) ? Number(context.retry_count) : 0,
    retry_policy: {
      ...DEFAULT_RETRY_POLICY,
      ...retryPolicy,
    },
  };
}

function extractDocumentRefFromSearchResult(execution = {}, fallback = '') {
  const docs = Array.isArray(execution?.result?.docs) ? execution.result.docs : [];
  for (const item of docs) {
    if (item && typeof item === 'object') {
      const ref = normalizeText(item.document_ref || item.document_id || item.doc_id || item.id || item.ref || '');
      if (ref) {
        return ref;
      }
    }
  }
  return normalizeText(fallback || '') || 'doc-1';
}

function summarizeSearchResult(searchExecution = {}) {
  const docs = Array.isArray(searchExecution?.result?.docs) ? searchExecution.result.docs : [];
  if (docs.length === 0) {
    return '沒有找到可用文件。';
  }
  const first = docs[0];
  if (first && typeof first === 'object') {
    const title = normalizeText(first.title || first.document_ref || first.document_id || '');
    const snippet = normalizeText(first.snippet || '');
    return normalizeText(`${title}${snippet ? `：${snippet}` : ''}`) || '已取得第一份候選文件。';
  }
  return normalizeText(String(first)) || '已取得第一份候選文件。';
}

function summarizeDocumentResult(readExecution = {}) {
  const content = normalizeText(readExecution?.result?.content || '');
  if (!content) {
    return '尚未取得文件正文。';
  }
  return content;
}

function buildAnswerFromState({ userInput = '', state = {} } = {}) {
  const lines = [];
  const searchSummary = summarizeSearchResult(state.search_execution || {});
  const docSummary = summarizeDocumentResult(state.read_execution || {});
  if (state.search_execution?.ok === true) {
    lines.push(`搜尋結果：${searchSummary}`);
  }
  if (state.read_execution?.ok === true) {
    lines.push(`文件內容：${docSummary}`);
  }
  if (lines.length === 0) {
    lines.push(`目前無法完成完整檢索流程，先回覆你原始問題：${normalizeText(userInput) || '(空白輸入)'}`);
  }
  return lines.join('\n');
}

function buildPlannerInputForNextTurn({ userInput = '', lastStep = null } = {}) {
  if (!lastStep || typeof lastStep !== 'object') {
    return normalizeText(userInput);
  }
  if (lastStep.action === 'search_company_brain_docs' && lastStep.tool_execution?.ok === true) {
    return '請讀取剛找到的第一份文件，抽取可直接回答使用者的重點。';
  }
  if (lastStep.action === 'official_read_document' && lastStep.tool_execution?.ok === true) {
    return '請直接整理答案回覆使用者。';
  }
  if (lastStep.continuation?.next_action === 'retry') {
    return normalizeText(userInput);
  }
  return normalizeText(userInput);
}

function buildRoutingDecision({ plannerDecision = null, lastStep = null, state = {} } = {}) {
  const plannerAction = normalizeText(plannerDecision?.selected_action || '');
  if (!lastStep) {
    return {
      selected_action: plannerAction || null,
      reason: normalizeText(plannerDecision?.reason || ''),
      routing_reason: normalizeText(plannerDecision?.routing_reason || '') || 'routing_no_match',
      source: 'planner_decision',
    };
  }

  const continuationAction = normalizeText(lastStep?.continuation?.next_action || '');
  if (state.fail_safe_mode === true) {
    return {
      selected_action: 'answer_user_directly',
      reason: 'fail_safe_exit_mode',
      routing_reason: 'fail_safe_exit',
      source: 'continuation_fail_safe',
    };
  }
  if (continuationAction === 'retry') {
    return {
      selected_action: normalizeText(lastStep.action || '') || plannerAction || null,
      reason: 'continuation_retry_same_action',
      routing_reason: 'continuation_retry',
      source: 'continuation_retry',
    };
  }
  if (continuationAction === 'continue_planner') {
    const nextAction = READ_CHAIN_HINTS[normalizeText(lastStep.action || '')] || '';
    if (nextAction) {
      return {
        selected_action: nextAction,
        reason: `continuation_transition_${normalizeText(lastStep.action || '')}`,
        routing_reason: `continuation_${normalizeText(nextAction)}`,
        source: 'continuation_chain',
      };
    }
  }
  if (continuationAction === 'ask_user' || continuationAction === 'fallback') {
    return {
      selected_action: 'answer_user_directly',
      reason: `continuation_${continuationAction}_fail_safe`,
      routing_reason: `continuation_${continuationAction}`,
      source: 'continuation_fail_safe',
    };
  }

  return {
    selected_action: plannerAction || null,
    reason: normalizeText(plannerDecision?.reason || ''),
    routing_reason: normalizeText(plannerDecision?.routing_reason || '') || 'routing_no_match',
    source: 'planner_decision',
  };
}

function buildActionArgs({
  action = '',
  userInput = '',
  state = {},
  context = {},
} = {}) {
  const normalizedAction = normalizeText(action);
  if (normalizedAction === 'search_company_brain_docs') {
    const q = normalizeText(
      state.current_query
      || context.query
      || context.q
      || userInput
      || '',
    );
    return q ? { q } : {};
  }
  if (normalizedAction === 'official_read_document') {
    const documentRef = normalizeText(
      state.last_document_ref
      || context.document_ref
      || context.doc_id
      || '',
    ) || 'doc-1';
    return { document_ref: documentRef };
  }
  if (normalizedAction === 'answer_user_directly') {
    return {
      answer: buildAnswerFromState({ userInput, state }),
    };
  }
  return {};
}

function resolveSkillSelection({ action = '', args = {}, context = {} } = {}) {
  const directSkillMetadata = getSkillMetadata(action);
  if (directSkillMetadata) {
    return {
      skill_name: action,
      metadata: directSkillMetadata,
      normalized_input: normalizeSkillArgs(action, args),
      source: 'direct_action_skill',
    };
  }

  const hintedSkill = normalizeText(ACTION_SKILL_HINTS[action] || '');
  if (!hintedSkill) {
    return {
      skill_name: null,
      metadata: null,
      normalized_input: null,
      source: 'no_skill_hint',
    };
  }

  const metadata = getSkillMetadata(hintedSkill);
  if (!metadata) {
    return {
      skill_name: hintedSkill,
      metadata: null,
      normalized_input: null,
      source: 'missing_skill_metadata',
    };
  }

  const accountId = normalizeText(
    context?.authContext?.account_id
    || context?.authContext?.accountId
    || context?.account_id
    || context?.accountId
    || '',
  );
  const skillInput = hintedSkill === 'search_and_summarize'
    ? {
        account_id: accountId,
        query: normalizeText(args.q || args.query || ''),
        q: normalizeText(args.q || args.query || ''),
      }
    : hintedSkill === 'document_summarize'
      ? {
          account_id: accountId,
          doc_id: normalizeText(args.document_ref || args.doc_id || ''),
        }
      : { ...args };

  return {
    skill_name: hintedSkill,
    metadata,
    normalized_input: normalizeSkillArgs(hintedSkill, skillInput),
    source: 'action_skill_hint',
  };
}

function updateStateFromExecution({ action = '', execution = {}, state = {} } = {}) {
  if (normalizeText(action) === 'search_company_brain_docs' && execution?.ok === true) {
    state.search_execution = execution;
    state.last_document_ref = extractDocumentRefFromSearchResult(execution, state.last_document_ref);
    return;
  }
  if (normalizeText(action) === 'official_read_document' && execution?.ok === true) {
    state.read_execution = execution;
    return;
  }
  if (normalizeText(action) === 'answer_user_directly' && execution?.ok === true) {
    state.final_answer = normalizeText(execution?.result?.answer || '');
  }
}

export async function runAgentE2E(userInput = '', ctx = {}) {
  const normalizedUserInput = normalizeText(userInput);
  const context = normalizeContext(ctx);
  const logger = context.logger && typeof context.logger === 'object' ? context.logger : NULL_LOGGER;
  const startedAt = Date.now();
  const hardTimeoutMs = resolveAgentE2EHardTimeoutMs(context);
  const deadlineAt = startedAt + hardTimeoutMs;
  const maxSteps = Math.max(
    1,
    Number.isFinite(Number(context.max_steps)) ? Number(context.max_steps) : DEFAULT_MAX_STEPS,
  );

  const state = {
    current_query: normalizedUserInput,
    last_document_ref: normalizeText(context.document_ref || ''),
    search_execution: null,
    read_execution: null,
    final_answer: '',
    fail_safe_mode: false,
  };
  const toolExecutor = resolveToolExecutor(context);
  if (!toolExecutor) {
    logger?.warn?.('agent_e2e_terminal_exit', {
      ok: false,
      done: false,
      terminal_reason: 'tool_executor_missing',
      duration_ms: Date.now() - startedAt,
      hard_timeout_ms: hardTimeoutMs,
      steps: 0,
    });
    return {
      ok: false,
      done: false,
      terminal_reason: 'tool_executor_missing',
      plan: [],
      steps: [],
      state: {
        search_company_brain_docs: state.search_execution,
        official_read_document: state.read_execution,
        answer_user_directly: null,
        fail_safe_mode: state.fail_safe_mode,
        last_document_ref: state.last_document_ref || null,
      },
      final: {
        ok: false,
        action: null,
        error: 'tool_executor_missing',
        next: 'fallback',
        result: {
          reason: 'tool_executor_missing',
          stage: 'agent_e2e_preflight',
        },
      },
      debug: {
        chosen_skills: [],
        routing_decisions: [],
        continuation_state: [],
      },
    };
  }
  context.tool_executor = toolExecutor;
  logger?.info?.('agent_e2e_ingress_enter', {
    input_length: normalizedUserInput.length,
    max_steps: maxSteps,
    retry_max: Number(context?.retry_policy?.max_retries || 0),
    hard_timeout_ms: hardTimeoutMs,
  });
  const steps = [];
  let plannerInput = normalizedUserInput;
  let done = false;
  let terminalReason = 'max_steps_reached';

  for (let index = 0; index < maxSteps; index += 1) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = deadlineAt - Date.now();
    logger?.info?.('agent_e2e_before_planner_decision', {
      step: index + 1,
      elapsed_ms: elapsedMs,
      remaining_ms: Math.max(0, Math.floor(remainingMs)),
      planner_input_length: normalizeText(plannerInput || normalizedUserInput).length,
    });
    if (remainingMs <= 0) {
      terminalReason = 'agent_e2e_timeout';
      break;
    }

    const plannerDecision = selectPlannerTool({
      userIntent: plannerInput || normalizedUserInput,
      taskType: normalizeText(context.taskType || context.task_type || ''),
      logger,
    });
    const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
    const routingDecision = buildRoutingDecision({
      plannerDecision,
      lastStep,
      state,
    });

    let selectedAction = normalizeText(routingDecision.selected_action || '');
    if (!selectedAction) {
      selectedAction = 'answer_user_directly';
      state.fail_safe_mode = true;
      terminalReason = 'fail_safe_no_selected_action';
    }

    const actionArgs = buildActionArgs({
      action: selectedAction,
      userInput: normalizedUserInput,
      state,
      context,
    });
    const normalizedArgs = normalizeToolInvocationArgs(selectedAction, actionArgs);
    const validation = validateToolInvocation(selectedAction, normalizedArgs);
    const toolContract = resolveToolContract(selectedAction);
    const skillSelection = resolveSkillSelection({
      action: selectedAction,
      args: normalizedArgs,
      context,
    });

    let toolExecution = null;
    if (validation.ok === true) {
      logger?.info?.('agent_e2e_before_tool_execution', {
        step: index + 1,
        action: selectedAction,
        elapsed_ms: Date.now() - startedAt,
        remaining_ms: Math.max(0, Math.floor(deadlineAt - Date.now())),
      });
      toolExecution = await executeToolWithHardTimeout({
        action: selectedAction,
        args: validation.args,
        context,
        timeoutMs: deadlineAt - Date.now(),
        elapsedMs: Date.now() - startedAt,
      });
      logger?.info?.('agent_e2e_after_tool_execution', {
        step: index + 1,
        action: selectedAction,
        ok: toolExecution?.ok === true,
        error: normalizeText(toolExecution?.error || '') || null,
        elapsed_ms: Date.now() - startedAt,
      });
    } else {
      toolExecution = {
        ok: false,
        action: selectedAction,
        error: 'contract_violation',
        next: 'fallback',
        result: {
          validation_reason: validation.reason || 'missing_required_args',
          missing: Array.isArray(validation.missing) ? validation.missing : [],
        },
      };
    }

    logger?.info?.('agent_e2e_before_continuation_decision', {
      step: index + 1,
      action: selectedAction,
      tool_ok: toolExecution?.ok === true,
      tool_error: normalizeText(toolExecution?.error || '') || null,
      tool_next: normalizeText(toolExecution?.next || '') || null,
    });
    const continuation = resolveToolResultContinuation(toolExecution, context);
    const stepRecord = {
      step: index + 1,
      planner_input: plannerInput || normalizedUserInput,
      planner_decision: plannerDecision,
      routing_decision: routingDecision,
      chosen_skill: skillSelection.skill_name || null,
      skill_selection_source: skillSelection.source,
      tool_contract: toolContract ? { ...toolContract } : null,
      action: selectedAction,
      args: validation.ok === true ? validation.args : normalizedArgs,
      tool_execution: toolExecution,
      continuation,
    };
    steps.push(stepRecord);
    updateStateFromExecution({
      action: selectedAction,
      execution: toolExecution,
      state,
    });

    logger?.debug?.('agent_e2e_step', {
      step: stepRecord.step,
      action: selectedAction,
      chosen_skill: stepRecord.chosen_skill,
      routing_reason: routingDecision.routing_reason || null,
      continuation_state: continuation?.next_action || null,
    });

    if (toolExecution?.ok === true) {
      context.retry_count = 0;
    } else {
      context.retry_count += 1;
    }
    if (isAgentE2ETimeoutExecution(toolExecution)) {
      terminalReason = 'agent_e2e_timeout';
      break;
    }

    if (selectedAction === 'answer_user_directly') {
      done = toolExecution?.ok === true;
      terminalReason = done
        ? 'answer_user_directly'
        : normalizeText(toolExecution?.error || '') || 'answer_failed';
      break;
    }

    if (continuation?.next_action === 'complete_task') {
      done = true;
      terminalReason = 'complete_task';
      break;
    }
    if (continuation?.next_action === 'retry') {
      plannerInput = buildPlannerInputForNextTurn({
        userInput: normalizedUserInput,
        lastStep: stepRecord,
      });
      continue;
    }
    if (continuation?.next_action === 'continue_planner') {
      plannerInput = buildPlannerInputForNextTurn({
        userInput: normalizedUserInput,
        lastStep: stepRecord,
      });
      continue;
    }
    if (continuation?.next_action === 'ask_user' || continuation?.next_action === 'fallback') {
      state.fail_safe_mode = true;
      plannerInput = buildPlannerInputForNextTurn({
        userInput: normalizedUserInput,
        lastStep: stepRecord,
      });
      continue;
    }

    terminalReason = normalizeText(continuation?.next_action || '') || 'unknown_continuation_state';
    break;
  }

  const final = steps.length > 0
    ? steps[steps.length - 1].tool_execution
    : terminalReason === 'agent_e2e_timeout'
      ? buildAgentE2ETimeoutExecution({
          action: '',
          timeoutMs: hardTimeoutMs,
          elapsedMs: Date.now() - startedAt,
          reason: 'agent_e2e_hard_timeout',
        })
      : null;
  logger?.info?.('agent_e2e_terminal_exit', {
    ok: done,
    done,
    terminal_reason: terminalReason,
    steps: steps.length,
    duration_ms: Date.now() - startedAt,
    hard_timeout_ms: hardTimeoutMs,
    final_action: normalizeText(final?.action || '') || null,
    final_error: normalizeText(final?.error || '') || null,
  });
  return {
    ok: done,
    done,
    terminal_reason: terminalReason,
    plan: steps.map((step) => step.action),
    steps,
    state: {
      search_company_brain_docs: state.search_execution,
      official_read_document: state.read_execution,
      answer_user_directly: state.final_answer
        ? {
            ok: true,
            action: 'answer_user_directly',
            result: { answer: state.final_answer },
          }
        : null,
      fail_safe_mode: state.fail_safe_mode,
      last_document_ref: state.last_document_ref || null,
    },
    final,
    debug: {
      chosen_skills: steps.map((step) => step.chosen_skill),
      routing_decisions: steps.map((step) => ({
        step: step.step,
        selected_action: normalizeText(step.routing_decision?.selected_action || '') || null,
        routing_reason: normalizeText(step.routing_decision?.routing_reason || '') || null,
        source: normalizeText(step.routing_decision?.source || '') || null,
      })),
      continuation_state: steps.map((step) => ({
        step: step.step,
        next_action: normalizeText(step.continuation?.next_action || '') || null,
        resume: step.continuation?.resume === true,
      })),
    },
  };
}

export async function runAutonomousWorkflow(userInput = '', ctx = {}) {
  return runAgentE2E(userInput, ctx);
}
