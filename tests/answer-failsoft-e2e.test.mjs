import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;

const [{ startHttpServer }] = await Promise.all([
  import("../src/http-server.mjs"),
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

function ensureTestAccount(accountId = "acct-1") {
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
    name: "Answer Fail-Soft E2E Test",
    scope: "test",
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function createAuthorizedOverrides(overrides = {}) {
  return {
    getValidUserTokenState: async () => ({
      status: "valid",
      token: { access_token: "token-1", account_id: "acct-1" },
      account: { id: "acct-1" },
      refreshed: false,
      error: null,
    }),
    getStoredAccountContext: async () => ({ account: { id: "acct-1" } }),
    ...overrides,
  };
}

async function startAnswerServer(t, { serviceOverrides = {}, requestTimeoutMs = null } = {}) {
  ensureTestAccount("acct-1");
  const server = startHttpServer({
    listen: false,
    logger: quietLogger,
    ...(Number.isFinite(Number(requestTimeoutMs)) ? { requestTimeoutMs: Number(requestTimeoutMs) } : {}),
    serviceOverrides: createAuthorizedOverrides(serviceOverrides),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return server;
}

async function getAnswer(port, q) {
  const response = await fetch(
    `http://127.0.0.1:${port}/answer?q=${encodeURIComponent(q)}`,
    { headers: { connection: "close" } },
  );
  const payload = await response.json();
  return { response, payload };
}

test("GET /answer keeps tool failure on fail-soft boundary and hides internal trace details", async (t) => {
  const server = await startAnswerServer(t, {
    serviceOverrides: {
      async executePlannedUserInput() {
        return {
          ok: false,
          action: "search_company_brain_docs",
          error: "tool_error",
          execution_result: {
            ok: false,
            error: "tool_error",
            data: {
              answer: "目前工具暫時不可用，我先回傳保守結果。",
              sources: ["工具執行失敗，已改走 fail-soft 邊界。"],
              limitations: ["下一步：你可以讓我重試，或改成只做文字整理。"],
            },
          },
        };
      },
    },
  });
  const { port } = server.address();
  const { response, payload } = await getAnswer(port, "幫我整理最新 SOP");
  const rendered = JSON.stringify(payload);

  assert.equal(response.status, 200);
  assert.equal(payload.ok, false);
  assert.match(String(payload.answer || ""), /還沒拿到完整結果|目前能確認/);
  assert.equal(Array.isArray(payload.sources), true);
  assert.equal(payload.sources.length > 0, true);
  assert.equal(Array.isArray(payload.limitations), true);
  assert.match(payload.limitations.join("\n"), /換個說法|補一點背景|直接貼給我/);
  assert.doesNotMatch(rendered, /stack|trace_id|internal\s+error|Error:/i);
});

test("GET /answer returns bounded timeout fail-soft within latency budget", { timeout: 10000 }, async (t) => {
  withEnv(t, {
    ANSWER_LATENCY_BUDGET_MS: "600",
    AGENT_E2E_BUDGET_MS: "600",
  });
  const server = await startAnswerServer(t, {
    requestTimeoutMs: 20_000,
    serviceOverrides: {
      async executePlannedUserInput() {
        return new Promise(() => {});
      },
    },
  });
  const { port } = server.address();

  const startedAt = Date.now();
  const { response, payload } = await getAnswer(port, "幫我查 Scanoo 是什麼，整理給我");
  const elapsedMs = Date.now() - startedAt;

  assert.equal(elapsedMs < 2_000, true);
  assert.equal(response.status, 504);
  assert.equal(payload.ok, false);
  assert.match(String(payload.answer || ""), /逾時/);
});
