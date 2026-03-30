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

function pickCanonicalEnvelope(payload = {}) {
  return {
    ok: payload?.ok ?? null,
    answer: payload?.answer ?? null,
    sources: Array.isArray(payload?.sources) ? payload.sources : null,
    limitations: Array.isArray(payload?.limitations) ? payload.limitations : null,
  };
}

test("runtime shape normalization forbids mixed get_runtime_info/runtime_info naming across real flows", async (t) => {
  const { planner, answer, agent } = await collectRuntimeShapeFixtures(t);
  const identifiers = new Set([
    planner?.selected_action,
    planner?.execution_result?.action,
    planner?.execution_result?.formatted_output?.kind,
    agent?.agentId,
  ].filter(Boolean));

  assert.equal(
    identifiers.has("get_runtime_info") && identifiers.has("runtime_info"),
    false,
    `expected one canonical runtime identifier, got ${JSON.stringify([...identifiers].sort())}`,
  );
});

test("runtime shape normalization keeps execution_result.kind internal while answer and agent use the canonical envelope", async (t) => {
  const { planner, answer, answerStatus, agent } = await collectRuntimeShapeFixtures(t);

  assert.equal(answerStatus, 200);
  assert.equal(planner?.execution_result?.formatted_output?.kind, "get_runtime_info");
  assert.equal("kind" in answer, false);
  assert.equal("kind" in agent, false);
  const answerEnvelope = pickCanonicalEnvelope(answer);
  const agentEnvelope = pickCanonicalEnvelope(agent);
  assert.equal(answerEnvelope.ok, true);
  assert.match(answerEnvelope.answer || "", /runtime|PID|工作目錄|資料庫路徑/);
  assert.equal(Array.isArray(answerEnvelope.sources), true);
  assert.equal(Array.isArray(answerEnvelope.limitations), true);
  assert.equal(agentEnvelope.ok, true);
  assert.equal(agentEnvelope.answer, "目前 runtime 有正常回應。");
  assert.deepEqual(agentEnvelope.sources, ["Runtime Boundary：runtime boundary source。"]);
  assert.deepEqual(agentEnvelope.limitations, ["這是目前 runtime 的即時快照。"]);
});

test("runtime shape normalization requires answer and agent boundaries to expose the same canonical envelope keys", async (t) => {
  const { answer, agent } = await collectRuntimeShapeFixtures(t);

  assert.deepEqual(Object.keys(answer).sort(), ["answer", "limitations", "ok", "sources"]);
  assert.deepEqual(
    Object.keys(agent).filter((key) => ["answer", "limitations", "ok", "sources"].includes(key)).sort(),
    ["answer", "limitations", "ok", "sources"],
  );
});
