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

test("/answer missing-input path asks user for required input instead of hard fail", async (t) => {
  const server = await startTestServer(t, {
    executePlannedUserInput: async () => ({
      ok: false,
      action: "search_and_detail_doc",
      error: "business_error",
      execution_result: {
        ok: false,
        error: "business_error",
        data: {
          reason: "missing_slot",
          stop_reason: "missing_slot",
          routing_reason: "missing_slot",
        },
      },
    }),
  });
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/answer?query=${encodeURIComponent("open this doc")}`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, false);
  assert.match((payload.limitations || []).join("\n"), /補上必要參數|提供/i);
  assert.doesNotMatch(payload.answer || "", /planner_failed|runtime_exception|business_error/i);
});

test("/answer tool failure still returns fail-soft user-facing reply", async (t) => {
  const server = await startTestServer(t, {
    executePlannedUserInput: async () => ({
      ok: false,
      action: "search_company_brain_docs",
      error: "business_error",
      execution_result: {
        ok: false,
        error: "business_error",
        data: {
          reason: "tool_error",
          stop_reason: "tool_error",
          message: "upstream timeout",
        },
      },
    }),
  });
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/answer?query=${encodeURIComponent("find owner")}`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, false);
  assert.equal(typeof payload.answer, "string");
  assert.equal(payload.answer.length > 0, true);
  assert.equal(Array.isArray(payload.sources), true);
  assert.equal(Array.isArray(payload.limitations), true);
});

test("/answer timeout still returns bounded fail-soft output", { timeout: 10000 }, async (t) => {
  withEnv(t, {
    ANSWER_LATENCY_BUDGET_MS: "30",
  });
  const server = await startTestServer(t, {
    executePlannedUserInput: async () => new Promise(() => {}),
  }, {
    requestTimeoutMs: 120,
  });
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/answer?query=${encodeURIComponent("find owner")}`);
  const payload = await response.json();

  assert.equal(response.status, 504);
  assert.equal(payload.ok, false);
  assert.match(payload.answer || "", /逾時|時限|安全交付/);
  assert.equal(Array.isArray(payload.limitations), true);
  assert.equal(payload.limitations.length > 0, true);
});
