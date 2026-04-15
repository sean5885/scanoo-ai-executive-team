import { selectPlannerTool } from './executive-planner.mjs';
import { getSkillMetadata, normalizeSkillArgs } from './skill-registry.mjs';
import { executeTool, resolveToolExecutor } from './tool-execution-runtime.mjs';
import { normalizeToolInvocationArgs, resolveToolContract, validateToolInvocation } from './tool-layer-contract.mjs';
import { resolveToolResultContinuation } from './tool-result-continuation.mjs';

const DEFAULT_MAX_STEPS = 6;
const DEFAULT_RETRY_POLICY = Object.freeze({ max_retries: 2 });
const DEFAULT_AGENT_E2E_REQUEST_BUDGET_MS = 5_000;
const MIN_AGENT_E2E_REQUEST_BUDGET_MS = 25;
const DEFAULT_AGENT_E2E_HARD_TIMEOUT_MS = 12_000;
const MIN_AGENT_E2E_HARD_TIMEOUT_MS = 25;
const DEFAULT_AGENT_E2E_FAST_FAIL_MS = 200;
const MIN_AGENT_E2E_FAST_FAIL_MS = 25;
const DEFAULT_AGENT_E2E_STEP_FLOOR_MS = 700;
const MIN_AGENT_E2E_STEP_FLOOR_MS = 100;
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

function resolveAgentE2ERequestBudgetMs(context = {}) {
  const configuredBudgetMs = toFinitePositiveNumber(context.agent_e2e_budget_ms)
    || toFinitePositiveNumber(context.request_budget_ms)
    || toFinitePositiveNumber(context.budget_ms)
    || toFinitePositiveNumber(process.env.AGENT_E2E_BUDGET_MS)
    || DEFAULT_AGENT_E2E_REQUEST_BUDGET_MS;
  const requestTimeoutMs = toFinitePositiveNumber(context.request_timeout_ms);
  const boundedByRequestTimeout = requestTimeoutMs == null
    ? configuredBudgetMs
    : Math.min(
        configuredBudgetMs,
        Math.max(MIN_AGENT_E2E_REQUEST_BUDGET_MS, Math.floor(requestTimeoutMs)),
      );
  return Math.max(MIN_AGENT_E2E_REQUEST_BUDGET_MS, Math.floor(boundedByRequestTimeout));
}

function resolveAgentE2EHardTimeoutMs(context = {}, requestBudgetMs = null) {
  const configuredHardTimeoutMs = toFinitePositiveNumber(context.agent_e2e_step_timeout_ms)
    || toFinitePositiveNumber(context.agent_e2e_hard_timeout_ms)
    || toFinitePositiveNumber(context.agent_e2e_timeout_ms)
    || toFinitePositiveNumber(context.hard_timeout_ms)
    || toFinitePositiveNumber(process.env.AGENT_E2E_STEP_TIMEOUT_MS)
    || toFinitePositiveNumber(process.env.AGENT_E2E_HARD_TIMEOUT_MS)
    || DEFAULT_AGENT_E2E_HARD_TIMEOUT_MS;
  const normalizedRequestBudgetMs = toFinitePositiveNumber(requestBudgetMs);
  const boundedByRequestBudget = normalizedRequestBudgetMs == null
    ? configuredHardTimeoutMs
    : Math.min(
        configuredHardTimeoutMs,
        Math.max(MIN_AGENT_E2E_HARD_TIMEOUT_MS, Math.floor(normalizedRequestBudgetMs)),
      );
  return Math.max(MIN_AGENT_E2E_HARD_TIMEOUT_MS, Math.floor(boundedByRequestBudget));
}

function resolveAgentE2EFastFailThresholdMs(context = {}, requestBudgetMs = null) {
  const configuredFastFailMs = toFinitePositiveNumber(context.agent_e2e_fast_fail_ms)
    || toFinitePositiveNumber(process.env.AGENT_E2E_FAST_FAIL_MS)
    || DEFAULT_AGENT_E2E_FAST_FAIL_MS;
  const normalizedRequestBudgetMs = toFinitePositiveNumber(requestBudgetMs);
  const boundedByRequestBudget = normalizedRequestBudgetMs == null
    ? configuredFastFailMs
    : Math.min(
        configuredFastFailMs,
        Math.max(MIN_AGENT_E2E_FAST_FAIL_MS, Math.floor(normalizedRequestBudgetMs)),
      );
  return Math.max(MIN_AGENT_E2E_FAST_FAIL_MS, Math.floor(boundedByRequestBudget));
}

function resolveDynamicMaxSteps({ baseMaxSteps = DEFAULT_MAX_STEPS, remainingMs = 0, context = {} } = {}) {
  const normalizedBaseMaxSteps = Math.max(
    1,
    Number.isFinite(Number(baseMaxSteps)) ? Math.floor(Number(baseMaxSteps)) : DEFAULT_MAX_STEPS,
  );
  const stepFloorMs = toFinitePositiveNumber(context.agent_e2e_step_floor_ms)
    || toFinitePositiveNumber(context.agent_e2e_min_step_budget_ms)
    || toFinitePositiveNumber(process.env.AGENT_E2E_STEP_FLOOR_MS)
    || DEFAULT_AGENT_E2E_STEP_FLOOR_MS;
  const normalizedStepFloorMs = Math.max(MIN_AGENT_E2E_STEP_FLOOR_MS, Math.floor(stepFloorMs));
  const normalizedRemainingMs = Math.max(0, Math.floor(Number(remainingMs) || 0));
  const affordableSteps = Math.max(1, Math.floor(normalizedRemainingMs / normalizedStepFloorMs));
  return Math.max(1, Math.min(normalizedBaseMaxSteps, affordableSteps));
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

function buildAgentE2ELatencyBudgetExecution({
  action = '',
  timeoutMs = null,
  elapsedMs = null,
  remainingMs = null,
  budgetMs = null,
  reason = 'agent_e2e_budget_exhausted',
  state = {},
  userInput = '',
} = {}) {
  const timeoutExecution = buildAgentE2ETimeoutExecution({
    action,
    timeoutMs: toFinitePositiveNumber(timeoutMs) || toFinitePositiveNumber(budgetMs),
    elapsedMs,
    reason,
  });
  const partialAnswer = normalizeText(buildAnswerFromState({ userInput, state }));
  return {
    ...timeoutExecution,
    result: {
      ...timeoutExecution.result,
      budget_ms: toFinitePositiveNumber(budgetMs),
      remaining_ms: Number.isFinite(Number(remainingMs))
        ? Math.max(0, Math.floor(Number(remainingMs)))
        : null,
      partial_answer: partialAnswer || null,
    },
  };
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
  const requestBudgetMs = resolveAgentE2ERequestBudgetMs(context);
  const configuredDeadlineAt = toFinitePositiveNumber(context.request_deadline_at)
    || toFinitePositiveNumber(context.agent_e2e_deadline_at)
    || toFinitePositiveNumber(context.deadline_at);
  const requestDeadlineAt = configuredDeadlineAt == null
    ? startedAt + requestBudgetMs
    : Math.min(Math.floor(configuredDeadlineAt), startedAt + requestBudgetMs);
  const hardTimeoutMs = resolveAgentE2EHardTimeoutMs(context, requestBudgetMs);
  const fastFailThresholdMs = resolveAgentE2EFastFailThresholdMs(context, requestBudgetMs);
  const maxSteps = Math.max(
    1,
    Number.isFinite(Number(context.max_steps)) ? Number(context.max_steps) : DEFAULT_MAX_STEPS,
  );
  context.request_budget_ms = requestBudgetMs;
  context.request_deadline_at = requestDeadlineAt;
  context.agent_e2e_deadline_at = requestDeadlineAt;
  context.agent_e2e_step_timeout_ms = hardTimeoutMs;
  context.agent_e2e_fast_fail_ms = fastFailThresholdMs;

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
    request_budget_ms: requestBudgetMs,
    request_deadline_at: requestDeadlineAt,
    hard_timeout_ms: hardTimeoutMs,
    fast_fail_threshold_ms: fastFailThresholdMs,
  });
  const steps = [];
  let plannerInput = normalizedUserInput;
  let done = false;
  let terminalReason = 'max_steps_reached';

  for (let index = 0; index < maxSteps; index += 1) {
    const loopStartedAt = Date.now();
    const elapsedMs = loopStartedAt - startedAt;
    const remainingMs = requestDeadlineAt - loopStartedAt;
    const dynamicMaxSteps = resolveDynamicMaxSteps({
      baseMaxSteps: maxSteps,
      remainingMs,
      context,
    });
    logger?.info?.('agent_e2e_before_planner_decision', {
      step: index + 1,
      elapsed_ms: elapsedMs,
      remaining_ms: Math.max(0, Math.floor(remainingMs)),
      dynamic_max_steps: dynamicMaxSteps,
      planner_input_length: normalizeText(plannerInput || normalizedUserInput).length,
    });
    if (loopStartedAt > requestDeadlineAt || remainingMs <= 0) {
      terminalReason = 'agent_e2e_timeout';
      break;
    }
    if (index >= dynamicMaxSteps) {
      terminalReason = 'latency_budget_step_cap';
      state.fail_safe_mode = true;
      break;
    }
    if (remainingMs < fastFailThresholdMs) {
      terminalReason = 'agent_e2e_budget_exhausted';
      state.fail_safe_mode = true;
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
    let forceBudgetExit = false;
    if (validation.ok === true) {
      const remainingBeforeToolMs = requestDeadlineAt - Date.now();
      context.agent_e2e_remaining_ms = Math.max(0, Math.floor(remainingBeforeToolMs));
      logger?.info?.('agent_e2e_before_tool_execution', {
        step: index + 1,
        action: selectedAction,
        elapsed_ms: Date.now() - startedAt,
        remaining_ms: Math.max(0, Math.floor(remainingBeforeToolMs)),
      });
      if (remainingBeforeToolMs < fastFailThresholdMs) {
        forceBudgetExit = true;
        state.fail_safe_mode = true;
        toolExecution = buildAgentE2ELatencyBudgetExecution({
          action: selectedAction,
          timeoutMs: requestBudgetMs,
          elapsedMs: Date.now() - startedAt,
          remainingMs: remainingBeforeToolMs,
          budgetMs: requestBudgetMs,
          reason: 'agent_e2e_budget_fast_fail',
          state,
          userInput: normalizedUserInput,
        });
      } else {
        const stepTimeoutMs = Math.max(
          MIN_AGENT_E2E_HARD_TIMEOUT_MS,
          Math.floor(Math.min(hardTimeoutMs, Math.max(0, remainingBeforeToolMs))),
        );
        toolExecution = await executeToolWithHardTimeout({
          action: selectedAction,
          args: validation.args,
          context,
          timeoutMs: stepTimeoutMs,
          elapsedMs: Date.now() - startedAt,
        });
      }
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
    const continuation = forceBudgetExit
      ? {
          next_action: 'fallback',
          reason: 'agent_e2e_budget_fast_fail',
          resume: false,
        }
      : resolveToolResultContinuation(toolExecution, context);
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
    if (forceBudgetExit) {
      terminalReason = 'agent_e2e_budget_exhausted';
      break;
    }
    if (isAgentE2ETimeoutExecution(toolExecution)) {
      const timeoutReason = normalizeText(toolExecution?.result?.reason || '');
      terminalReason = timeoutReason.includes('budget')
        ? 'agent_e2e_budget_exhausted'
        : 'agent_e2e_timeout';
      break;
    }

    if (selectedAction === 'answer_user_directly') {
      done = toolExecution?.ok === true;
      terminalReason = done
        ? 'answer_user_directly'
        : normalizeText(toolExecution?.error || '') || 'answer_failed';
      break;
    }

    const continuationAction = normalizeText(continuation?.next_action || '');
    if (continuation?.fail_closed === true) {
      state.fail_safe_mode = true;
      terminalReason = normalizeText(continuation?.reason || '') || 'invalid_continuation_token';
      break;
    }
    if (continuationAction === 'complete_task') {
      done = true;
      terminalReason = 'complete_task';
      break;
    }
    if (continuationAction === 'retry') {
      plannerInput = buildPlannerInputForNextTurn({
        userInput: normalizedUserInput,
        lastStep: stepRecord,
      });
      continue;
    }
    if (continuationAction === 'continue_planner') {
      plannerInput = buildPlannerInputForNextTurn({
        userInput: normalizedUserInput,
        lastStep: stepRecord,
      });
      continue;
    }
    if (continuationAction === 'ask_user') {
      state.fail_safe_mode = true;
      terminalReason = 'ask_user';
      break;
    }
    if (continuationAction === 'fallback') {
      state.fail_safe_mode = true;
      terminalReason = 'fallback';
      break;
    }

    terminalReason = continuationAction || 'unknown_continuation_state';
    break;
  }

  const final = steps.length > 0
    ? steps[steps.length - 1].tool_execution
    : terminalReason === 'agent_e2e_timeout'
      ? buildAgentE2ETimeoutExecution({
          action: '',
          timeoutMs: requestBudgetMs,
          elapsedMs: Date.now() - startedAt,
          reason: 'agent_e2e_hard_timeout',
        })
      : terminalReason === 'agent_e2e_budget_exhausted' || terminalReason === 'latency_budget_step_cap'
        ? buildAgentE2ELatencyBudgetExecution({
            action: '',
            timeoutMs: requestBudgetMs,
            elapsedMs: Date.now() - startedAt,
            remainingMs: requestDeadlineAt - Date.now(),
            budgetMs: requestBudgetMs,
            reason: terminalReason === 'latency_budget_step_cap'
              ? 'agent_e2e_step_cap_by_budget'
              : 'agent_e2e_budget_exhausted',
            state,
            userInput: normalizedUserInput,
          })
      : null;
  logger?.info?.('agent_e2e_terminal_exit', {
    ok: done,
    done,
    terminal_reason: terminalReason,
    steps: steps.length,
    duration_ms: Date.now() - startedAt,
    request_budget_ms: requestBudgetMs,
    request_deadline_at: requestDeadlineAt,
    hard_timeout_ms: hardTimeoutMs,
    fast_fail_threshold_ms: fastFailThresholdMs,
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
