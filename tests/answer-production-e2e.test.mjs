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
    name: "Answer Production E2E Test",
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

async function getAnswer(port, q) {
  const response = await fetch(
    `http://127.0.0.1:${port}/answer?q=${encodeURIComponent(q)}`,
    { headers: { connection: "close" } },
  );
  const payload = await response.json();
  return { response, payload };
}

test("GET /answer returns usable success payload for normal single-intent request", async (t) => {
  const server = await startAnswerServer(t, {
    async executePlannedUserInput() {
      return {
        ok: true,
        action: "get_runtime_info",
        execution_result: {
          ok: true,
          data: {
            answer: "目前 runtime 健康，服務可正常回應。",
            sources: ["runtime health check 已完成。"],
            limitations: [],
          },
        },
      };
    },
  });
  const { port } = server.address();
  const { response, payload } = await getAnswer(port, "查 runtime info");

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.answer, "string");
  assert.equal(payload.answer.length > 0, true);
  assert.equal(Array.isArray(payload.sources), true);
  assert.equal(Array.isArray(payload.limitations), true);
});

test("GET /answer returns partial aggregated result for multi-intent request", async (t) => {
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
            return { answer: "新品上線，現在就看亮點。" };
          }
          if (payload.task === "image") {
            return { url: "hero.png" };
          }
          return { name, task: payload.task };
        },
      });
    },
  });
  const { port } = server.address();
  const { response, payload } = await getAnswer(port, "做文案、配圖、最後發布");

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.match(String(payload.answer || ""), /文案：新品上線/);
  assert.equal(Array.isArray(payload.limitations), true);
  assert.match(payload.limitations.join("\n"), /發布/);
});

test("GET /answer uses ask-user style guidance when required input is missing instead of hard failure", async (t) => {
  const server = await startAnswerServer(t, {
    async executePlannedUserInput() {
      return {
        ok: false,
        action: "search_company_brain_docs",
        error: "missing_slot",
        execution_result: {
          ok: false,
          error: "missing_slot",
          data: {
            answer: "請先提供 account_id，我才能繼續這一步。",
            sources: ["目前缺少必要參數：account_id。"],
            limitations: ["下一步：補上 account_id 後，我就可以直接接續處理。"],
          },
        },
      };
    },
  });
  const { port } = server.address();
  const { response, payload } = await getAnswer(port, "幫我查文件");

  assert.equal(response.status, 200);
  assert.equal(payload.ok, false);
  assert.equal(typeof payload.answer, "string");
  assert.match(payload.answer, /還沒拿到完整結果|目前能確認/);
  assert.equal(Array.isArray(payload.sources), true);
  assert.equal(payload.sources.length > 0, true);
  assert.equal(Array.isArray(payload.limitations), true);
  assert.match(payload.limitations.join("\n"), /換個說法|補一點背景|直接貼給我/);
});
