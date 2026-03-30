import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const [
  { startHttpServer },
  {
    executePlannedUserInput,
    resetPlannerRuntimeContext,
    runPlannerToolFlow,
  },
  { executeRegisteredAgent },
  { getRegisteredAgent },
] = await Promise.all([
  import("../src/http-server.mjs"),
  import("../src/executive-planner.mjs"),
  import("../src/agent-dispatcher.mjs"),
  import("../src/agent-registry.mjs"),
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

  const agent = await executeRegisteredAgent({
    accountId: "acct_runtime_shape_test",
    agent: getRegisteredAgent("ceo"),
    requestText: "查 runtime info",
    scope: {
      session_key: "runtime-shape-agent-boundary",
    },
    searchFn() {
      return {
        items: [
          {
            id: "runtime-shape-source",
            snippet: "runtime boundary source",
            metadata: {
              title: "Runtime Boundary",
              url: "https://example.com/runtime-boundary",
            },
          },
        ],
      };
    },
    async textGenerator() {
      return JSON.stringify({
        ok: true,
        kind: "get_runtime_info",
        answer: "目前 runtime 有正常回應。",
        sources: ["Runtime Boundary：runtime boundary source。"],
        limitations: ["這是目前 runtime 的即時快照。"],
      });
    },
  });

  return {
    planner,
    answer,
    answerStatus: answerResponse.status,
    agent,
  };
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
  assert.equal(planner?.execution_result?.formatted_output?.kind, "get_runtime_info");
  assert.equal(answer?.kind, "get_runtime_info");
  assert.equal(agent?.kind, "get_runtime_info");
  assert.equal(
    planner?.execution_result?.formatted_output?.kind,
    answer?.kind,
    `planner/http kind drift: planner=${planner?.execution_result?.formatted_output?.kind} http=${answer?.kind}`,
  );
  assert.equal(
    answer?.kind,
    agent?.kind,
    `http/agent kind drift: http=${answer?.kind} agent=${agent?.kind}`,
  );
});

test.todo("runtime shape normalization requires answer planner and agent to share one response envelope");
