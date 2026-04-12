export function resolveToolResultContinuation(toolExecution = {}, ctx = {}) {
  if (!toolExecution || typeof toolExecution !== 'object') {
    return { next_action: 'fallback', reason: 'missing_tool_execution' };
  }

  if (toolExecution.ok) {
    return {
      next_action: toolExecution.next || 'continue_planner',
      reason: 'tool_execution_succeeded',
      resume: true,
    };
  }

  if (ctx?.retry_count < (ctx?.retry_policy?.max_retries || 0)) {
    return {
      next_action: 'retry',
      reason: 'tool_execution_failed_retryable',
      resume: true,
    };
  }

  if (ctx?.waiting_user) {
    return {
      next_action: 'ask_user',
      reason: 'tool_execution_failed_waiting_user',
      resume: false,
    };
  }

  return {
    next_action: toolExecution.next || 'fallback',
    reason: 'tool_execution_failed_fallback',
    resume: false,
  };
}
