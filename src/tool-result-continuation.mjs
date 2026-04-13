const CANONICAL_CONTINUATION_ACTIONS = new Set([
  'continue_planner',
  'complete_task',
  'retry',
  'ask_user',
  'fallback',
]);

const LEGACY_CONTINUATION_ACTION_ALIASES = Object.freeze({
  retry_or_fallback: 'retry',
  ask_or_fallback: 'ask_user',
});

function normalizeText(value = '') {
  return String(value || '').trim();
}

export function normalizeContinuationAction(action = '', fallback = 'fallback') {
  const normalizedAction = normalizeText(action);
  if (CANONICAL_CONTINUATION_ACTIONS.has(normalizedAction)) {
    return normalizedAction;
  }
  const aliasedAction = LEGACY_CONTINUATION_ACTION_ALIASES[normalizedAction];
  if (CANONICAL_CONTINUATION_ACTIONS.has(aliasedAction)) {
    return aliasedAction;
  }
  const normalizedFallback = normalizeText(fallback);
  if (CANONICAL_CONTINUATION_ACTIONS.has(normalizedFallback)) {
    return normalizedFallback;
  }
  return 'fallback';
}

export function resolveToolResultContinuation(toolExecution = {}, ctx = {}) {
  if (!toolExecution || typeof toolExecution !== 'object') {
    return { next_action: 'fallback', reason: 'missing_tool_execution' };
  }

  const normalizedNextAction = normalizeContinuationAction(
    toolExecution.next,
    toolExecution.ok ? 'continue_planner' : 'fallback',
  );

  if (toolExecution.ok) {
    return {
      next_action: normalizedNextAction,
      reason: 'tool_execution_succeeded',
      resume: true,
    };
  }

  const retryCount = Number.isFinite(Number(ctx?.retry_count))
    ? Number(ctx.retry_count)
    : 0;
  const maxRetries = Number.isFinite(Number(ctx?.retry_policy?.max_retries))
    ? Number(ctx.retry_policy.max_retries)
    : 0;

  if (normalizedNextAction === 'retry' && retryCount < maxRetries) {
    return {
      next_action: 'retry',
      reason: 'tool_execution_failed_retryable',
      resume: true,
    };
  }

  if (normalizedNextAction === 'ask_user' || ctx?.waiting_user === true) {
    return {
      next_action: 'ask_user',
      reason: 'tool_execution_failed_waiting_user',
      resume: false,
    };
  }

  if (normalizedNextAction === 'retry') {
    return {
      next_action: 'fallback',
      reason: 'tool_execution_retry_exhausted',
      resume: false,
    };
  }

  return {
    next_action: normalizedNextAction,
    reason: 'tool_execution_failed_fallback',
    resume: false,
  };
}
