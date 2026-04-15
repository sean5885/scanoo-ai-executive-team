import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;

const [
  { startHttpServer },
  { executePlannedUserInput: coreExecutePlannedUserInput },
] = await Promise.all([
  import("../src/http-server.mjs"),
  import("../src/executive-planner.mjs"),
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
    name: "Answer Capability Boundary Test",
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

async function startAnswerServer(t, serviceOverrides = {}) {
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

test("GET /answer keeps image and publish requests inside capability-gap/blocked boundary without fake success", async (t) => {
  const server = await startAnswerServer(t, {
    async executePlannedUserInput({ text, signal }) {
      return coreExecutePlannedUserInput({
        text,
        signal,
        logger: quietLogger,
        requester: async () => {
          throw new Error("requester should not be called for task-layer short-circuit");
        },
        runSkill: async (name, payload) => {
          if (payload.task === "copywriting") {
            return { answer: "新品開跑，限時搶先看。" };
          }
          if (payload.task === "image") {
            return {
              ok: false,
              error: "business_error",
              details: {
                failure_class: "capability_gap",
                reason: "image_backend_unavailable",
              },
            };
          }
          return { name, task: payload.task };
        },
      });
    },
  });
  const { port } = server.address();
  const response = await fetch(
    `http://127.0.0.1:${port}/answer?q=${encodeURIComponent("做文案、配圖、最後發布")}`,
    {
      headers: { connection: "close" },
    },
  );
  const payload = await response.json();
  const limitationText = (payload.limitations || []).join("\n");

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.match(String(payload.answer || ""), /文案：新品開跑/);
  assert.doesNotMatch(String(payload.answer || ""), /圖片：已生成/);
  assert.match(limitationText, /圖片/);
  assert.match(limitationText, /capability|fail-closed|缺少可用 image backend/i);
  assert.match(limitationText, /發布/);
});
