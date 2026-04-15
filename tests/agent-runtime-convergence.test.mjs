import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDbHarness } from './utils/test-db-factory.mjs';

const testDb = await createTestDbHarness();
const { db } = testDb;

const [
  { startHttpServer },
  { TOOL_LAYER_REGISTRY },
  { resolveToolResultContinuation },
  { runAgentE2E },
] = await Promise.all([
  import('../src/http-server.mjs'),
  import('../src/tool-layer-contract.mjs'),
  import('../src/tool-result-continuation.mjs'),
  import('../src/planner-autonomous-workflow.mjs'),
]);

test.after(() => {
  testDb.close();
});

function withEnv(t, values = {}) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  t.after(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function ensureTestAccount(accountId = 'acct-1') {
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO lark_accounts (
      id, open_id, user_id, union_id, tenant_key, name, email, scope, created_at, updated_at
    ) VALUES (
      @id, @open_id, NULL, NULL, NULL, @name, NULL, @scope, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at
  `).run({
    id: accountId,
    open_id: `ou_test_${accountId}`,
    name: 'Agent Runtime Convergence Test',
    scope: 'test',
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function createLoggerSink() {
  const calls = [];
  return {
    calls,
    logger: {
      log() {},
      info(...args) {
        calls.push(args);
      },
      warn(...args) {
        calls.push(args);
      },
      error(...args) {
        calls.push(args);
      },
    },
  };
}

function createAuthorizedOverrides(overrides = {}) {
  return {
    getValidUserTokenState: async () => ({
      status: 'valid',
      token: { access_token: 'token-1', account_id: 'acct-1' },
      account: { id: 'acct-1' },
      refreshed: false,
      error: null,
    }),
    getStoredAccountContext: async () => ({ account: { id: 'acct-1' } }),
    ...overrides,
  };
}

async function startTestServer(t, serviceOverrides = {}) {
  ensureTestAccount('acct-1');
  const sink = createLoggerSink();
  const server = startHttpServer({
    listen: false,
    logger: sink.logger,
    serviceOverrides: createAuthorizedOverrides(serviceOverrides),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return { server, calls: sink.calls };
}

test('tool-layer continuation vocabulary stays canonical', () => {
  const canonical = new Set(['continue_planner', 'complete_task', 'retry', 'ask_user', 'fallback']);
  for (const [action, contract] of Object.entries(TOOL_LAYER_REGISTRY)) {
    assert.equal(canonical.has(contract.on_success_next), true, `${action} success continuation must be canonical`);
    assert.equal(canonical.has(contract.on_failure_next), true, `${action} failure continuation must be canonical`);
  }
});

test('continuation resolution aligns legacy tokens and handles retry exhaustion deterministically', () => {
  const retryAlias = resolveToolResultContinuation(
    { ok: false, next: 'retry_or_fallback' },
    { retry_count: 0, retry_policy: { max_retries: 1 } },
  );
  assert.equal(retryAlias.next_action, 'retry');

  const exhausted = resolveToolResultContinuation(
    { ok: false, next: 'retry' },
    { retry_count: 1, retry_policy: { max_retries: 1 } },
  );
  assert.equal(exhausted.next_action, 'fallback');
});

test('runAgentE2E fails before execution when tool executor is missing', async () => {
  const result = await runAgentE2E('幫我查 Scanoo', {
    authContext: { account_id: 'acct-1' },
    retry_policy: { max_retries: 2 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.done, false);
  assert.equal(result.terminal_reason, 'tool_executor_missing');
  assert.equal(Array.isArray(result.steps), true);
  assert.equal(result.steps.length, 0);
  assert.equal(result.final?.error, 'tool_executor_missing');
});

test('runAgentE2E consumes ask_user continuation token as a terminal boundary', async () => {
  const result = await runAgentE2E('幫我查 Scanoo 文件', {
    max_steps: 4,
    retry_policy: { max_retries: 2 },
    tool_executor: async ({ action }) => ({
      ok: false,
      action,
      error: 'business_error',
      next: 'ask_user',
      trace_id: 'trace_agent_e2e_ask_user',
      data: { reason: 'need_more_info' },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.done, false);
  assert.equal(result.terminal_reason, 'ask_user');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.continuation?.next_action, 'ask_user');
});

test('runAgentE2E consumes fallback continuation token as a terminal boundary', async () => {
  const result = await runAgentE2E('幫我查 Scanoo 文件', {
    max_steps: 4,
    retry_policy: { max_retries: 2 },
    tool_executor: async ({ action }) => ({
      ok: false,
      action,
      error: 'business_error',
      next: 'fallback',
      trace_id: 'trace_agent_e2e_fallback',
      data: { reason: 'cannot_continue' },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.done, false);
  assert.equal(result.terminal_reason, 'fallback');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.continuation?.next_action, 'fallback');
});

test('runAgentE2E fail-closes unknown continuation tokens', async () => {
  const result = await runAgentE2E('幫我查 Scanoo 文件', {
    max_steps: 4,
    retry_policy: { max_retries: 2 },
    tool_executor: async ({ action }) => ({
      ok: true,
      action,
      next: 'unknown_next_token',
      trace_id: 'trace_agent_e2e_unknown',
      data: { total: 0, items: [] },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.done, false);
  assert.equal(result.terminal_reason, 'invalid_continuation_token');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.continuation?.fail_closed, true);
  assert.equal(result.steps[0]?.continuation?.invalid_next_action, 'unknown_next_token');
});

test('agent-mode ingress keeps single runtime authority by default when runAgentE2E has no final answer', async (t) => {
  withEnv(t, {
    AGENT_E2E_ENABLED: 'true',
    AGENT_E2E_RATIO: '1',
    AGENT_E2E_LEGACY_FALLBACK_ENABLED: null,
  });

  const plannerCalls = [];
  const { server } = await startTestServer(t, {
    async runAgentE2E() {
      return {
        ok: false,
        final: null,
        terminal_reason: 'max_steps_reached',
        plan: ['search_company_brain_docs'],
      };
    },
    async executePlannedUserInput(args) {
      plannerCalls.push(args);
      return {
        ok: true,
        action: 'search_company_brain_docs',
        execution_result: {
          ok: true,
          data: {
            answer: 'legacy planner fallback answer',
            sources: [],
            limitations: [],
          },
        },
      };
    },
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/answer?q=${encodeURIComponent('我要 SOP')}`, {
    headers: {
      'x-user-id': 'user-single-authority',
      'x-account-id': 'acct-1',
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.ok, false);
  assert.match(payload.answer, /單一路徑/);
  assert.equal(plannerCalls.length, 0);
});

test('agent-mode ingress can opt into explicit legacy fallback', async (t) => {
  withEnv(t, {
    AGENT_E2E_ENABLED: 'true',
    AGENT_E2E_RATIO: '1',
    AGENT_E2E_LEGACY_FALLBACK_ENABLED: 'true',
  });

  const plannerCalls = [];
  const { server, calls } = await startTestServer(t, {
    async runAgentE2E() {
      return {
        ok: false,
        final: null,
        terminal_reason: 'max_steps_reached',
        plan: ['search_company_brain_docs'],
      };
    },
    async executePlannedUserInput(args) {
      plannerCalls.push(args);
      return {
        ok: true,
        action: 'search_company_brain_docs',
        execution_result: {
          ok: true,
          data: {
            answer: 'legacy planner fallback answer',
            sources: ['來源 A'],
            limitations: [],
          },
        },
      };
    },
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/answer?q=${encodeURIComponent('我要 SOP')}`, {
    headers: {
      'x-user-id': 'user-explicit-fallback',
      'x-account-id': 'acct-1',
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.answer, 'legacy planner fallback answer');
  assert.equal(plannerCalls.length, 1);
  assert.equal(calls.some((entry) => entry[1]?.event === 'knowledge_answer_agent_e2e_fallback'), true);
});

test('normal HTTP agent ingress provides tool executor and avoids tool_executor_missing', async (t) => {
  withEnv(t, {
    AGENT_E2E_ENABLED: 'true',
    AGENT_E2E_RATIO: '1',
    AGENT_E2E_LEGACY_FALLBACK_ENABLED: null,
  });

  const dispatchCalls = [];
  const plannerCalls = [];
  const { server, calls } = await startTestServer(t, {
    async dispatchPlannerTool({ action, payload }) {
      dispatchCalls.push({ action, payload });
      if (action === 'search_company_brain_docs') {
        return {
          ok: true,
          data: {
            total: 1,
            docs: [
              {
                document_ref: 'doc-convergence-1',
                title: 'Scanoo Brief',
                snippet: 'Scanoo 是一個 AI workflow tool',
              },
            ],
          },
        };
      }
      if (action === 'official_read_document') {
        return {
          ok: true,
          data: {
            content: `document: ${payload?.document_ref || 'doc-convergence-1'}`,
          },
        };
      }
      return {
        ok: false,
        error: 'invalid_action',
      };
    },
    async executePlannedUserInput(args) {
      plannerCalls.push(args);
      return {
        ok: true,
        action: 'search_company_brain_docs',
        execution_result: {
          ok: true,
          data: {
            answer: 'planner should stay unused in this test',
            sources: [],
            limitations: [],
          },
        },
      };
    },
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/answer?q=${encodeURIComponent('幫我查 Scanoo 是什麼，整理給我')}`, {
    headers: {
      'x-user-id': 'user-http-agent-runtime',
      'x-account-id': 'acct-1',
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.match(payload.answer, /搜尋結果/);
  assert.equal(dispatchCalls.some((entry) => entry.action === 'search_company_brain_docs'), true);
  assert.equal(dispatchCalls.some((entry) => entry.action === 'official_read_document'), true);
  assert.equal(plannerCalls.length, 0);
  assert.equal(calls.some((entry) => entry[1]?.event === 'knowledge_answer_agent_e2e_fallback'), false);
});
