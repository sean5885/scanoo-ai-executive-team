import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDbHarness } from './utils/test-db-factory.mjs';

const testDb = await createTestDbHarness();
const { db } = testDb;

const [
  { startHttpServer },
  { runPlannerToolFlow },
] = await Promise.all([
  import('../src/http-server.mjs'),
  import('../src/executive-planner.mjs'),
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
    name: 'Routing Authority Convergence Test',
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

test('/answer keeps planner edge as the only HTTP runtime authority', async (t) => {
  withEnv(t, {
    AGENT_E2E_ENABLED: 'true',
    AGENT_E2E_RATIO: '1',
    AGENT_E2E_LEGACY_FALLBACK_ENABLED: 'true',
  });

  let agentCalls = 0;
  let plannerCalls = 0;
  const { server } = await startTestServer(t, {
    async runAgentE2E() {
      agentCalls += 1;
      return {
        ok: true,
        final: {
          ok: true,
          action: 'answer_user_directly',
          result: { answer: 'agent path should never run from HTTP' },
        },
      };
    },
    async executePlannedUserInput() {
      plannerCalls += 1;
      return {
        ok: true,
        action: 'search_company_brain_docs',
        execution_result: {
          ok: true,
          data: {
            answer: 'planner edge single authority answer',
            sources: [],
            limitations: [],
          },
        },
      };
    },
  });

  const { port } = server.address();
  const response = await fetch(
    `http://127.0.0.1:${port}/answer?q=${encodeURIComponent('我要 SOP')}&agent_e2e=force`,
    {
      headers: {
        'x-user-id': 'user-routing-authority',
        'x-account-id': 'acct-1',
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.answer, 'planner edge single authority answer');
  assert.equal(agentCalls, 0);
  assert.equal(plannerCalls, 1);
});

test('continuation stays on unified planner runtime contract surface', async () => {
  let dispatchCalls = 0;
  const result = await runPlannerToolFlow({
    userIntent: '查 launch checklist',
    payload: {
      q: 'launch checklist',
    },
    disableAutoRouting: true,
    logger: {
      info() {},
      debug() {},
      warn() {},
      error() {},
    },
    selector() {
      return {
        selected_action: 'search_company_brain_docs',
        reason: 'routing authority convergence continuation test',
      };
    },
    async dispatcher({ action, payload }) {
      dispatchCalls += 1;
      return {
        ok: true,
        action,
        trace_id: 'trace_routing_authority_continuation',
        data: {
          q: payload?.q || '',
          total: 1,
          items: [
            {
              doc_id: 'doc_routing_authority_1',
              title: 'Launch Checklist',
            },
          ],
        },
      };
    },
  });

  assert.equal(dispatchCalls, 1);
  assert.equal(result.execution_result?.ok, true);
  assert.equal(result.execution_result?.trace_id, 'trace_routing_authority_continuation');
  assert.equal(result.execution_result?.data?.tool_layer?.contract?.action, 'search_company_brain_docs');
  assert.equal(result.execution_result?.data?.tool_layer?.continuation?.next_action, 'continue_planner');
  assert.equal(result.execution_result?.data?.tool_layer?.continuation_state?.state, 'continue');
});
