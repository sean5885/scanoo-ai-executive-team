import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../src/tool-execution-runtime.mjs';
import { normalizeToolInvocationArgs, validateToolInvocation } from '../src/tool-layer-contract.mjs';

test('search_company_brain_docs executes successfully with canonical q', async () => {
  const res = await executeTool('search_company_brain_docs', { q: 'scanoo' }, {
    tool_executor: async ({ args }) => ({
      ok: true,
      data: {
        q: args?.q,
        total: 1,
        docs: [{ document_ref: 'doc-test-1', title: 'Doc 1', snippet: 'snippet' }],
      },
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.action, 'search_company_brain_docs');
  assert.equal(res.next, 'continue_planner');
});

test('search_company_brain_docs executes successfully with legacy query alias', async () => {
  const res = await executeTool('search_company_brain_docs', { query: 'scanoo' }, {
    tool_executor: async ({ args }) => ({
      ok: true,
      data: {
        q: args?.q,
        total: 1,
        docs: [{ document_ref: 'doc-test-1', title: 'Doc 1', snippet: 'snippet' }],
      },
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.action, 'search_company_brain_docs');
  assert.equal(res.next, 'continue_planner');
});

test('official_read_document executes successfully', async () => {
  const res = await executeTool('official_read_document', { document_ref: 'doc-1' }, {
    tool_executor: async ({ args }) => ({
      ok: true,
      data: { content: `document: ${args?.document_ref}` },
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.next, 'continue_planner');
});

test('unknown tool returns failure', async () => {
  const res = await executeTool('unknown_tool', {}, {});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_tool_action');
});

test('executeTool fails soft when injected executor is missing', async () => {
  const res = await executeTool('search_company_brain_docs', { q: 'scanoo' }, {});
  assert.equal(res.ok, false);
  assert.equal(res.action, 'search_company_brain_docs');
  assert.equal(res.error, 'tool_executor_missing');
  assert.equal(res.next, 'retry');
});

test('executeTool delegates to injected tool executor when available', async () => {
  let calls = 0;
  const res = await executeTool('search_company_brain_docs', { q: 'scanoo' }, {
    tool_executor: async ({ action, args }) => {
      calls += 1;
      assert.equal(action, 'search_company_brain_docs');
      assert.equal(args?.q, 'scanoo');
      return {
        ok: true,
        action,
        trace_id: 'trace_tool_exec_injected',
        data: {
          q: args?.q,
          total: 1,
          docs: [
            {
              document_ref: 'doc-injected-1',
              title: 'Injected doc',
              snippet: 'from injected runtime',
            },
          ],
        },
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(res.ok, true);
  assert.equal(res.action, 'search_company_brain_docs');
  assert.equal(res.next, 'continue_planner');
  assert.equal(res.trace_id, 'trace_tool_exec_injected');
  assert.equal(res.dispatch_result?.ok, true);
  assert.equal(res.result?.docs?.[0]?.document_ref, 'doc-injected-1');
});

test('executeTool keeps failure continuation contract when injected executor fails', async () => {
  const res = await executeTool('official_read_document', { document_ref: 'doc-1' }, {
    tool_executor: async () => ({
      ok: false,
      error: 'tool_error',
      trace_id: 'trace_tool_exec_fail',
      data: {
        reason: 'upstream_failed',
      },
    }),
  });

  assert.equal(res.ok, false);
  assert.equal(res.action, 'official_read_document');
  assert.equal(res.error, 'tool_error');
  assert.equal(res.next, 'ask_user');
  assert.equal(res.trace_id, 'trace_tool_exec_fail');
});

test('executeTool enforces allowed_tools permission gate', async () => {
  const res = await executeTool('search_company_brain_docs', { q: 'scanoo' }, {
    allowed_tools: ['get_runtime_info'],
    tool_executor: async () => ({
      ok: true,
      data: { q: 'scanoo' },
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'permission_denied');
});

test('validateToolInvocation accepts canonical q for search_company_brain_docs', () => {
  const check = validateToolInvocation('search_company_brain_docs', { q: 'lobster' });
  assert.equal(check.ok, true);
});

test('validateToolInvocation accepts legacy query alias for search_company_brain_docs', () => {
  const check = validateToolInvocation('search_company_brain_docs', { query: 'lobster' });
  assert.equal(check.ok, true);
  assert.equal(check.args?.q, 'lobster');
});

test('validateToolInvocation rejects missing search query payload', () => {
  const check = validateToolInvocation('search_company_brain_docs', {});
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'missing_required_args');
  assert.deepEqual(check.missing, ['q']);
});

test('normalizeToolInvocationArgs canonicalizes legacy query alias into q', () => {
  const normalized = normalizeToolInvocationArgs('search_company_brain_docs', { query: 'okr' });
  assert.equal(normalized.q, 'okr');
  assert.equal(normalized.query, 'okr');
});
