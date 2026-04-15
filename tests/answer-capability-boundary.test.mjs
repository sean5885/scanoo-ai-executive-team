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

async function startTestServer(t, serviceOverrides = {}) {
  const server = startHttpServer({
    listen: false,
    logger: createLogger(),
    serviceOverrides: createAuthorizedOverrides(serviceOverrides),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return server;
}

test("/answer image request must fail-soft with explicit capability boundary", async (t) => {
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
        },
      },
    }),
  });
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/answer?query=${encodeURIComponent("generate an image")}`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, false);
  assert.match((payload.answer || "") + "\n" + (payload.limitations || []).join("\n"), /capability_gap|blocked/i);
  assert.doesNotMatch(payload.answer || "", /已成功發布|成功發布|已發送成功|發布成功/i);
});

test("/answer publish request must fail-soft with explicit capability boundary", async (t) => {
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
        },
      },
    }),
  });
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/answer?query=${encodeURIComponent("publish this")}`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, false);
  assert.match((payload.answer || "") + "\n" + (payload.limitations || []).join("\n"), /capability_gap|blocked/i);
  assert.doesNotMatch(payload.answer || "", /已成功發布|成功發布|已發送成功|發布成功/i);
});
