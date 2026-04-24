import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDbHarness } from './utils/test-db-factory.mjs';

const testDb = await createTestDbHarness();
const { db } = testDb;

const [
  { startHttpServer },
  { runAgentE2E },
] = await Promise.all([
  import('../src/http-server.mjs'),
  import('../src/planner-autonomous-workflow.mjs'),
]);

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

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
    name: 'Agent Latency Budget Test',
    scope: 'test',
    created_at: timestamp,
    updated_at: timestamp,
  });
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
  const server = startHttpServer({
    listen: false,
    logger: quietLogger,
    serviceOverrides: createAuthorizedOverrides(serviceOverrides),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return server;
}

test('runAgentE2E enforces global request budget and avoids long stall latency', { timeout: 10000 }, async () => {
  const startedAt = Date.now();
  const result = await runAgentE2E('幫我查 Scanoo 是什麼，整理給我', {
    authContext: { account_id: 'acct-1' },
    logger: quietLogger,
    request_budget_ms: 5_000,
    agent_e2e_hard_timeout_ms: 40_000,
    tool_executor: async () => new Promise(() => {}),
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(elapsedMs < 6_000, true);
  assert.equal(elapsedMs < 40_000, true);
  assert.equal(result.done, false);
  assert.equal(
    result.terminal_reason === 'agent_e2e_timeout' || result.terminal_reason === 'agent_e2e_budget_exhausted',
    true,
  );
  assert.equal(result.final?.error, 'request_timeout');
  assert.equal(String(result.final?.result?.reason || '').startsWith('agent_e2e_'), true);
});

test('/answer keeps bounded planner fallback even when AGENT_E2E rollout flags are enabled', { timeout: 12000 }, async (t) => {
  withEnv(t, {
    AGENT_E2E_ENABLED: 'true',
    AGENT_E2E_RATIO: '1',
    AGENT_E2E_LEGACY_FALLBACK_ENABLED: null,
    AGENT_E2E_BUDGET_MS: '5000',
    AGENT_E2E_HARD_TIMEOUT_MS: '40000',
  });
  const server = await startTestServer(t, {
    async executePlannedUserInput() {
      return new Promise(() => {});
    },
  });
  const { port } = server.address();

  const startedAt = Date.now();
  const response = await fetch(
    `http://127.0.0.1:${port}/answer?q=${encodeURIComponent('幫我查 Scanoo 是什麼，整理給我')}`,
    {
      headers: {
        'x-user-id': 'user-latency-budget',
        'x-account-id': 'acct-1',
      },
    },
  );
  const payload = await response.json();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(elapsedMs < 6_000, true);
  assert.equal(elapsedMs < 40_000, true);
  assert.equal(response.status, 504);
  assert.equal(payload.ok, false);
  assert.equal(typeof payload.answer, 'string');
  assert.equal(payload.answer.length > 0, true);
  assert.equal(Array.isArray(payload.limitations), true);
  assert.equal(payload.limitations.some((item) => String(item || '').includes('timeout_layer=planner')), true);
});

test('/answer legacy planner path is also bounded by latency budget when canary is not selected', { timeout: 12000 }, async (t) => {
  withEnv(t, {
    AGENT_E2E_ENABLED: 'true',
    AGENT_E2E_RATIO: '0',
    AGENT_E2E_BUDGET_MS: '5000',
    AGENT_E2E_HARD_TIMEOUT_MS: '40000',
  });
  const server = await startTestServer(t, {
    async executePlannedUserInput() {
      return new Promise(() => {});
    },
  });
  const { port } = server.address();

  const startedAt = Date.now();
  const response = await fetch(
    `http://127.0.0.1:${port}/answer?q=${encodeURIComponent('幫我查 Scanoo 是什麼，整理給我')}`,
    {
      headers: {
        'x-user-id': 'user-legacy-timeout',
        'x-account-id': 'acct-1',
      },
    },
  );
  const payload = await response.json();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(elapsedMs < 6_000, true);
  assert.equal(elapsedMs < 40_000, true);
  assert.equal(response.status, 504);
  assert.equal(payload.ok, false);
  assert.match(String(payload.answer || ''), /逾時/);
});

test('/answer keeps planner edge authority even when query asks to force agent canary', async (t) => {
  withEnv(t, {
    AGENT_E2E_ENABLED: 'true',
    AGENT_E2E_RATIO: '0',
    AGENT_E2E_LEGACY_FALLBACK_ENABLED: 'false',
    AGENT_E2E_BUDGET_MS: '5000',
  });
  let agentCalls = 0;
  const plannerCalls = [];
  const server = await startTestServer(t, {
    async runAgentE2E() {
      agentCalls += 1;
      return {
        ok: true,
        final: {
          ok: true,
          action: 'answer_user_directly',
          result: {
            answer: 'forced canary answer',
          },
        },
        terminal_reason: 'answer_user_directly',
        plan: ['answer_user_directly'],
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
            answer: 'planner edge authority answer',
            sources: [],
            limitations: [],
          },
        },
      };
    },
  });
  const { port } = server.address();
  const response = await fetch(
    `http://127.0.0.1:${port}/answer?q=${encodeURIComponent('幫我查 Scanoo 是什麼，整理給我')}&agent_e2e=force`,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.answer, 'planner edge authority answer');
  assert.equal(agentCalls, 0);
  assert.equal(plannerCalls.length, 1);
});
