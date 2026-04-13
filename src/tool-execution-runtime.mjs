import { normalizeToolInvocationArgs, resolveToolContract } from './tool-layer-contract.mjs';

function normalizeText(value = '') {
  return String(value || '').trim();
}

function resolveInjectedToolExecutor(ctx = {}) {
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

function buildMockExecutionResult(action, normalizedArgs = {}) {
  if (action === 'search_company_brain_docs') {
    const query = normalizedArgs?.q ?? '';
    return {
      ok: true,
      result: {
        q: query,
        total: query ? 1 : 0,
        docs: query
          ? [{
              document_ref: 'doc-1',
              title: `Top match for ${query}`,
              snippet: `result for ${query}`,
            }]
          : [],
      },
    };
  }

  if (action === 'official_read_document') {
    return {
      ok: true,
      result: { content: `document: ${normalizedArgs.document_ref}` },
    };
  }

  if (action === 'answer_user_directly') {
    return {
      ok: true,
      result: { answer: normalizedArgs.answer },
    };
  }

  return {
    ok: false,
    error: 'unknown_tool_action',
  };
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
  return {
    ok,
    action,
    result: externalResult.result ?? externalResult.data ?? null,
    ...(ok
      ? {}
      : {
          error: normalizeText(externalResult.error) || 'tool_execution_failed',
        }),
    next: ok
      ? (contract?.on_success_next || 'continue_planner')
      : (contract?.on_failure_next || 'fallback'),
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
    const injectedExecutor = resolveInjectedToolExecutor(ctx);
    if (injectedExecutor) {
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
    }

    const mockExecution = buildMockExecutionResult(action, normalizedArgs);
    if (mockExecution.ok !== true) {
      return {
        ok: false,
        action,
        error: normalizeText(mockExecution.error) || 'tool_execution_failed',
        next: contract.on_failure_next,
      };
    }

    return {
      ok: true,
      action,
      result: mockExecution.result,
      next: contract.on_success_next,
    };
  } catch (e) {
    return {
      ok: false,
      error: 'tool_execution_failed',
      next: contract.on_failure_next,
    };
  }
}
