import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const [{ startHttpServer }] = await Promise.all([
  import("../src/http-server.mjs"),
]);

test.after(() => {
  testDb.close();
});

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    log() {},
  };
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

async function startTestServer(t, serviceOverrides = {}, options = {}) {
  const server = startHttpServer({
    listen: false,
    logger: createLogger(),
    serviceOverrides: createAuthorizedOverrides(serviceOverrides),
    ...(Number.isFinite(Number(options?.requestTimeoutMs))
      ? { requestTimeoutMs: Number(options.requestTimeoutMs) }
      : {}),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return server;
}

test("/answer accepts `query` alias and returns stable normal answer shape", async (t) => {
  const server = await startTestServer(t, {
    executePlannedUserInput: async () => ({
      ok: true,
      action: "search_company_brain_docs",
      execution_result: {
        ok: true,
        data: {
          answer: "這是正常單意圖回答。",
          sources: ["來源：test source"],
          limitations: ["下一步：可補更多條件。"],
        },
      },
    }),
  });
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/answer?query=${encodeURIComponent("test")}`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "這是正常單意圖回答。");
  assert.equal(Array.isArray(payload.sources), true);
  assert.equal(payload.sources.some((line) => String(line).includes("來源：test source")), true);
  assert.deepEqual(payload.limitations, ["下一步：可補更多條件。"]);
  assert.equal("error" in payload, false);
  assert.equal("execution_result" in payload, false);
});

test("/answer keeps multi-intent request in partial path instead of full fail", async (t) => {
  const server = await startTestServer(t, {
    executePlannedUserInput: async () => ({
      ok: false,
      action: null,
      error: "business_error",
      execution_result: {
        ok: false,
        error: "business_error",
        data: {
          reason: "routing_no_match",
          routing_reason: "routing_no_match",
          stop_reason: "business_error",
        },
      },
    }),
  });
  const { port } = server.address();
  const response = await fetch(
    `http://127.0.0.1:${port}/answer?query=${encodeURIComponent("help me summarize and draft, then generate an image and publish this")}`,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.partial, true);
  assert.match(payload.answer || "", /草稿|draft|copy/i);
  assert.match((payload.sources || []).join("\n"), /已先完成/);
  assert.match((payload.limitations || []).join("\n"), /capability_gap|blocked/i);
});
