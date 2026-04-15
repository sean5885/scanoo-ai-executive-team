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
    name: "Answer Timeout Unblock Test",
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

async function startTestServer(t, serviceOverrides = {}) {
  ensureTestAccount("acct-1");
  const server = startHttpServer({
    listen: false,
    logger: quietLogger,
    serviceOverrides: createAuthorizedOverrides(serviceOverrides),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return server;
}

test("/answer query=test no longer times out on real entrypoint", { timeout: 10000 }, async (t) => {
  const server = await startTestServer(t);
  const { port } = server.address();
  const startedAt = Date.now();
  const response = await fetch(
    `http://127.0.0.1:${port}/answer?q=test`,
  );
  const payload = await response.json();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.match(String(payload.answer || ""), /answer 入口可用/);
  assert.equal(elapsedMs < 1500, true);
});

test("/answer timeout responses expose timeout layer classification", { timeout: 10000 }, async (t) => {
  const layerByQuery = new Map([
    ["timeout-planner", "planner"],
    ["timeout-tool", "tool"],
    ["timeout-external", "external_dependency"],
  ]);
  const server = await startTestServer(t, {
    async executePlannedUserInput({ text = "" } = {}) {
      if (text === "timeout-planner") {
        return {
          ok: false,
          error: "request_timeout",
          reason: "planner_request_timeout",
          execution_result: null,
        };
      }
      if (text === "timeout-tool") {
        return {
          ok: false,
          action: "search_company_brain_docs",
          error: "request_timeout",
          execution_result: {
            ok: false,
            action: "search_company_brain_docs",
            error: "request_timeout",
            data: {
              reason: "tool_execution_timeout",
            },
          },
        };
      }
      return {
        ok: false,
        action: "search_company_brain_docs",
        error: "request_timeout",
        execution_result: {
          ok: false,
          action: "search_company_brain_docs",
          error: "request_timeout",
          data: {
            reason: "upstream_dependency_timeout",
          },
        },
      };
    },
  });
  const { port } = server.address();

  for (const [query, expectedLayer] of layerByQuery.entries()) {
    const response = await fetch(
      `http://127.0.0.1:${port}/answer?q=${encodeURIComponent(query)}`,
      {
        headers: {
          "x-user-id": "user-timeout-layer",
          "x-account-id": "acct-1",
        },
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 504);
    assert.equal(payload.ok, false);
    assert.equal(
      Array.isArray(payload.limitations)
      && payload.limitations.includes(`timeout_layer=${expectedLayer}`),
      true,
    );
  }
});
