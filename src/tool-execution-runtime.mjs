import { normalizeToolInvocationArgs, resolveToolContract } from './tool-layer-contract.mjs';

function normalizeText(value = '') {
  return String(value || '').trim();
}

export function resolveToolExecutor(ctx = {}) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) {
    return null;
  }
  const candidates = [
    ctx.tool_executor,
    ctx.toolExecutor,
    ctx.execute_tool,
    ctx.executeTool,
    ctx.dispatch_tool,
    ctx.dispatchTool,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'function') {
      return candidate;
    }
  }
  return null;
}

function normalizeExternalExecutionResult({
  action,
  contract,
  externalResult = null,
} = {}) {
  if (!externalResult || typeof externalResult !== 'object') {
    return {
      ok: false,
      action,
      error: 'tool_execution_failed',
      next: contract?.on_failure_next || 'fallback',
      trace_id: null,
      dispatch_result: externalResult,
    };
  }

  const ok = externalResult.ok === true;
  const externalNextAction = normalizeText(
    externalResult.next
    || externalResult.next_action
    || '',
  );
  return {
    ok,
    action,
    result: externalResult.result ?? externalResult.data ?? null,
    ...(ok
      ? {}
      : {
          error: normalizeText(externalResult.error) || 'tool_execution_failed',
        }),
    next: externalNextAction || (ok
      ? (contract?.on_success_next || 'continue_planner')
      : (contract?.on_failure_next || 'fallback')),
    trace_id: normalizeText(externalResult.trace_id || '') || null,
    dispatch_result: externalResult,
  };
}

export async function executeTool(action, args = {}, ctx = {}) {
  const contract = resolveToolContract(action);
  if (!contract) {
    return { ok: false, error: 'unknown_tool_action' };
  }
  const normalizedArgs = normalizeToolInvocationArgs(action, args);

  try {
    const injectedExecutor = resolveToolExecutor(ctx);
    if (!injectedExecutor) {
      return {
        ok: false,
        action,
        error: 'tool_executor_missing',
        next: contract.on_failure_next,
        trace_id: null,
        dispatch_result: null,
        result: {
          reason: 'tool_executor_missing',
        },
      };
    }

    const externalResult = await injectedExecutor({
      action,
      args: normalizedArgs,
      contract,
      ctx,
    });
    return normalizeExternalExecutionResult({
      action,
      contract,
      externalResult,
    });
  } catch (e) {
    return {
      ok: false,
      action,
      error: 'tool_execution_failed',
      next: contract.on_failure_next,
      trace_id: null,
      dispatch_result: null,
    };
  }
}
