import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;
const [
  { startHttpServer },
  {
    executePlannedUserInput,
    resetPlannerRuntimeContext,
    runPlannerToolFlow,
  },
  { dispatchRegisteredAgentCommand },
  { saveToken },
] = await Promise.all([
  import("../src/http-server.mjs"),
  import("../src/executive-planner.mjs"),
  import("../src/agent-dispatcher.mjs"),
  import("../src/rag-repository.mjs"),
]);

test.after(() => {
  testDb.close();
});

function createLogger() {
  return {
    log() {},
    info() {},
    warn() {},
    error() {},
  };
}

function insertAgentDispatchAccount(accountId) {
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
    name: "Runtime Shape Test",
    scope: "test",
    created_at: timestamp,
    updated_at: timestamp,
  });

  saveToken(accountId, {
    access_token: `token_${accountId}`,
    refresh_token: `refresh_${accountId}`,
    token_type: "Bearer",
    scope: "docs:read",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 120_000).toISOString(),
  });
}

async function startAnswerServer(t) {
  const fallbackLogger = createLogger();
  const server = startHttpServer({
    listen: false,
    logger: fallbackLogger,
    requestTimeoutMs: 20_000,
    serviceOverrides: {
      executePlannedUserInput: async ({
        text,
        signal,
        logger,
        ...rest
      }) => executePlannedUserInput({
        text,
        signal,
        logger: logger || fallbackLogger,
        plannedDecision: {
          action: "get_runtime_info",
          params: {},
        },
        ...rest,
      }),
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return server;
}

async function collectRuntimeShapeFixtures(t) {
  resetPlannerRuntimeContext();
  const logger = createLogger();

  const planner = await runPlannerToolFlow({
    userIntent: "查 runtime info",
    logger,
  });

  const server = await startAnswerServer(t);
  const { port } = server.address();
  const answerResponse = await fetch(
    `http://127.0.0.1:${port}/answer?q=${encodeURIComponent("查 runtime info")}`,
    {
      headers: {
        connection: "close",
      },
    },
  );
  const answer = await answerResponse.json();

  const accountId = `acct_runtime_shape_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  insertAgentDispatchAccount(accountId);
  const agent = await dispatchRegisteredAgentCommand({
    accountId,
    event: {
      text: "/ceo 查 runtime info",
    },
    scope: {
      session_key: `runtime-shape-${accountId}`,
    },
  });

  return {
    planner,
    answer,
    answerStatus: answerResponse.status,
    agent,
  };
}

function listTopLevelKeys(value) {
  return Object.keys(value && typeof value === "object" && !Array.isArray(value) ? value : {}).sort();
}

function extractSurfaceKind(value) {
  return value?.execution_result?.kind
    || value?.execution_result?.formatted_output?.kind
    || value?.kind
    || null;
}

test("runtime shape normalization forbids mixed get_runtime_info/runtime_info naming across real flows", async (t) => {
  const { planner, answer, agent } = await collectRuntimeShapeFixtures(t);
  const identifiers = new Set([
    planner?.selected_action,
    planner?.execution_result?.action,
    planner?.execution_result?.formatted_output?.kind,
    answer?.action,
    answer?.planner_action,
    answer?.kind,
    agent?.action,
    agent?.kind,
    agent?.agentId,
  ].filter(Boolean));

  assert.equal(
    identifiers.has("get_runtime_info") && identifiers.has("runtime_info"),
    false,
    `expected one canonical runtime identifier, got ${JSON.stringify([...identifiers].sort())}`,
  );
});

test("runtime shape normalization requires execution_result.kind to match across planner http and agent flows", async (t) => {
  const { planner, answer, answerStatus, agent } = await collectRuntimeShapeFixtures(t);

  assert.equal(answerStatus, 200);
  assert.equal(
    extractSurfaceKind(planner),
    extractSurfaceKind(answer),
    `planner/http kind drift: planner=${extractSurfaceKind(planner)} http=${extractSurfaceKind(answer)}`,
  );
  assert.equal(
    extractSurfaceKind(answer),
    extractSurfaceKind(agent),
    `http/agent kind drift: http=${extractSurfaceKind(answer)} agent=${extractSurfaceKind(agent)}`,
  );
});

test("runtime shape normalization requires answer planner and agent to share one response envelope", async (t) => {
  const { planner, answer, agent } = await collectRuntimeShapeFixtures(t);
  const answerKeys = listTopLevelKeys(answer);

  assert.deepEqual(
    listTopLevelKeys(planner),
    answerKeys,
    `planner envelope drift: planner=${JSON.stringify(listTopLevelKeys(planner))} answer=${JSON.stringify(answerKeys)}`,
  );
  assert.deepEqual(
    listTopLevelKeys(agent),
    answerKeys,
    `agent envelope drift: agent=${JSON.stringify(listTopLevelKeys(agent))} answer=${JSON.stringify(answerKeys)}`,
  );
});
