import test from "node:test";
import assert from "node:assert/strict";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const [
  {
    buildPlannedUserInputEnvelope,
    resetPlannerRuntimeContext,
    runPlannerToolFlow,
  },
  {
    normalizeUserResponse,
    renderUserResponseText,
  },
] = await Promise.all([
  import("../src/executive-planner.mjs"),
  import("../src/user-response-normalizer.mjs"),
]);

test.after(() => {
  testDb.close();
});

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function buildExecuteLikeResult(runtimeResult = {}, params = {}) {
  return {
    ok: runtimeResult?.execution_result?.ok === true,
    action: runtimeResult?.selected_action || null,
    params,
    error: runtimeResult?.execution_result?.ok === false
      ? runtimeResult?.execution_result?.error || null
      : null,
    execution_result: runtimeResult?.execution_result || null,
    formatted_output: runtimeResult?.formatted_output || null,
    trace_id: runtimeResult?.trace_id || null,
    why: null,
    alternative: null,
  };
}

function assertPublicAnswerShape(response = {}, text = "") {
  assert.equal(typeof response.answer, "string");
  assert.equal(Array.isArray(response.sources), true);
  assert.equal(Array.isArray(response.limitations), true);
  assert.doesNotMatch(JSON.stringify(response), /"(?:action|execution_result|payload|result|kind|trace|trace_id|side_effects)"/);
  assert.doesNotMatch(text, /execution_result|payload|side_effects|trace_id|skill_bridge|get_runtime_info|routing_no_match|business_error/);
}

function adaptEnvelopeForCurrentNormalizer(envelope = {}, executionData = {}) {
  return {
    ...envelope,
    execution_result: {
      ...(envelope?.execution_result && typeof envelope.execution_result === "object" ? envelope.execution_result : {}),
      data: executionData,
    },
  };
}

function assertCanonicalPlannerEnvelope(envelope = {}, {
  action = null,
  ok = true,
  fallbackReason = null,
  kind = null,
} = {}) {
  assert.deepEqual(Object.keys(envelope).sort(), [
    "action",
    "alternative",
    "error",
    "execution_result",
    "formatted_output",
    "ok",
    "params",
    "trace",
    "trace_id",
    "why",
  ]);
  assert.equal(envelope.ok, ok);
  assert.equal(envelope.action, action);
  assert.equal(envelope.trace?.chosen_action, action);
  assert.equal(envelope.trace?.fallback_reason, fallbackReason);
  if (kind) {
    assert.equal(envelope.formatted_output?.kind, kind);
  }
}

test("full flow validation keeps doc query on one deterministic route and renders from canonical envelope", async () => {
  resetPlannerRuntimeContext();
  const calls = [];
  const query = "幫我找 launch checklist";
  const runtimeResult = await runPlannerToolFlow({
    userIntent: query,
    payload: { limit: 3 },
    logger: quietLogger,
    async dispatcher({ action, payload }) {
      calls.push({ action, payload });
      return {
        ok: true,
        action: "company_brain_docs_search",
        items: [
          {
            doc_id: "doc_launch_1",
            title: "Launch Checklist",
            url: "https://example.com/doc_launch_1",
          },
        ],
        trace_id: "trace_doc_query",
      };
    },
  });

  const envelope = buildPlannedUserInputEnvelope(buildExecuteLikeResult(runtimeResult, {
    limit: 3,
    q: query,
    query,
  }));
  const response = normalizeUserResponse({
    plannerEnvelope: adaptEnvelopeForCurrentNormalizer(envelope, {
      answer: "我已先按目前已索引的文件，標出和「幫我找 launch checklist」最相關的 1 份文件。",
      sources: [
        {
          title: "Launch Checklist",
          url: "https://example.com/doc_launch_1",
          snippet: "文件內容直接命中 launch checklist。",
        },
      ],
      limitations: ["如果你要，我可以再沿著這份文件補更多原文依據。"],
    }),
  });
  const text = renderUserResponseText(response);

  assert.equal(runtimeResult.selected_action, "search_company_brain_docs");
  assert.equal(runtimeResult.routing_reason, "doc_query_search");
  assert.deepEqual(calls, [{
    action: "search_company_brain_docs",
    payload: {
      limit: 3,
      q: query,
      query,
    },
  }]);
  assert.equal(runtimeResult.execution_result?.ok, true);
  assert.equal(runtimeResult.execution_result?.formatted_output?.kind, "search");
  assertCanonicalPlannerEnvelope(envelope, {
    action: "search_company_brain_docs",
    ok: true,
    fallbackReason: null,
    kind: "search",
  });
  assert.match(response.answer || "", /launch checklist/i);
  assert.match(response.sources.join("\n"), /Launch Checklist/);
  assertPublicAnswerShape(response, text);
});

test("full flow validation keeps runtime-info on one deterministic route without document-style answer leakage", async () => {
  resetPlannerRuntimeContext();
  const calls = [];
  const runtimeResult = await runPlannerToolFlow({
    userIntent: "請給我 db path 和 pid",
    logger: quietLogger,
    async dispatcher({ action, payload }) {
      calls.push({ action, payload });
      return {
        ok: true,
        action,
        data: {
          db_path: "/tmp/lark-rag.sqlite",
          node_pid: 123,
          cwd: "/tmp/runtime",
          service_start_time: "2026-03-20T00:00:00.000Z",
        },
        trace_id: "trace_runtime_info",
      };
    },
  });

  const envelope = buildPlannedUserInputEnvelope(buildExecuteLikeResult(runtimeResult, {}));
  const response = normalizeUserResponse({
    plannerEnvelope: adaptEnvelopeForCurrentNormalizer(envelope, {
      answer: "目前 runtime 有正常回應。資料庫路徑在 /tmp/lark-rag.sqlite。 目前 PID 是 123。 工作目錄是 /tmp/runtime。",
      sources: ["runtime 即時狀態：這份回覆直接來自目前 process 的即時資訊。"],
      limitations: ["這是啟動於 2026-03-20T00:00:00.000Z 的即時 runtime 快照。"],
    }),
  });
  const text = renderUserResponseText(response);

  assert.equal(runtimeResult.selected_action, "get_runtime_info");
  assert.equal(runtimeResult.routing_reason, "selector_get_runtime_info");
  assert.deepEqual(calls, [{
    action: "get_runtime_info",
    payload: {},
  }]);
  assert.equal(runtimeResult.execution_result?.ok, true);
  assert.equal(runtimeResult.execution_result?.formatted_output?.kind, "get_runtime_info");
  assertCanonicalPlannerEnvelope(envelope, {
    action: "get_runtime_info",
    ok: true,
    fallbackReason: null,
    kind: "get_runtime_info",
  });
  assert.match(response.answer || "", /runtime|PID|工作目錄|資料庫路徑/);
  assert.doesNotMatch(response.limitations.join("\n"), /未命名文件|同一組相關文件|打開「/);
  assert.doesNotMatch(text, /未命名文件|同一組相關文件|打開「/);
  assertPublicAnswerShape(response, text);
});

test("full flow validation keeps no-match fail-soft and answer-safe", async () => {
  resetPlannerRuntimeContext();
  const runtimeResult = await runPlannerToolFlow({
    userIntent: "幫我看看",
    logger: quietLogger,
  });

  const envelope = buildPlannedUserInputEnvelope(buildExecuteLikeResult(runtimeResult, {}));
  const response = normalizeUserResponse({ plannerEnvelope: adaptEnvelopeForCurrentNormalizer(envelope) });
  const text = renderUserResponseText(response);

  assert.equal(runtimeResult.selected_action, null);
  assert.equal(runtimeResult.routing_reason, "routing_no_match");
  assert.equal(runtimeResult.execution_result?.ok, false);
  assert.equal(runtimeResult.execution_result?.error, "business_error");
  assert.equal(runtimeResult.execution_result?.data?.reason, "routing_no_match");
  assertCanonicalPlannerEnvelope(envelope, {
    action: null,
    ok: false,
    fallbackReason: "routing_no_match",
  });
  assert.equal(response.ok, false);
  assert.match(response.answer || "", /一般助理|不會亂補|目前狀態|能確認/);
  assertPublicAnswerShape(response, text);
});

test("full flow validation turns mixed copy plus unsupported asks into partial success at the answer boundary", async () => {
  resetPlannerRuntimeContext();
  const requestText = "幫我寫新品上線的 FB 貼文、做一張圖片並發送出去";
  const runtimeResult = await runPlannerToolFlow({
    userIntent: requestText,
    logger: quietLogger,
  });

  const envelope = buildPlannedUserInputEnvelope(buildExecuteLikeResult(runtimeResult, {}));
  const response = normalizeUserResponse({
    plannerEnvelope: adaptEnvelopeForCurrentNormalizer(envelope),
    requestText,
  });
  const text = renderUserResponseText(response);

  assert.equal(runtimeResult.execution_result?.ok, false);
  assert.equal(response.ok, true);
  assert.match(response.answer || "", /貼文草稿/);
  assert.match(response.answer || "", /新品上線/);
  assert.match(response.limitations.join("\n"), /圖片/);
  assert.match(response.limitations.join("\n"), /發送或發布/);
  assertPublicAnswerShape(response, text);
  assert.doesNotMatch(text, /internal|routing|lane|trace|fallback_reason/i);
});

test("full flow validation does not fake partial success when every requested subtask is unavailable", async () => {
  resetPlannerRuntimeContext();
  const requestText = "幫我做一張圖片並直接發送給客戶";
  const runtimeResult = await runPlannerToolFlow({
    userIntent: requestText,
    logger: quietLogger,
  });

  const envelope = buildPlannedUserInputEnvelope(buildExecuteLikeResult(runtimeResult, {}));
  const response = normalizeUserResponse({
    plannerEnvelope: adaptEnvelopeForCurrentNormalizer(envelope),
    requestText,
  });

  assert.equal(runtimeResult.execution_result?.ok, false);
  assert.equal(response.ok, false);
  assert.equal(response.failure_class, "permission_denied");
  assert.equal(response.sources.length, 0);
  assert.match(response.answer || "", /auth-required|授權|使用者 token/);
  assert.match(response.limitations.join(" "), /重新送出這輪需求|登入授權/);
});

test("full flow validation keeps mixed intent on a single preset route and renders from the same envelope", async () => {
  resetPlannerRuntimeContext();
  const presetCalls = [];
  const runtimeResult = await runPlannerToolFlow({
    userIntent: "整理 onboarding 流程並解釋",
    payload: { limit: 5 },
    logger: quietLogger,
    async presetRunner({ preset, input }) {
      presetCalls.push({ preset, input });
      return {
        ok: true,
        preset,
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [
              {
                doc_id: "doc_onboarding_1",
                title: "Onboarding 流程",
                url: "https://example.com/onboarding",
              },
            ],
            trace_id: "trace_mixed_search",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: {
              doc_id: "doc_onboarding_1",
              title: "Onboarding 流程",
            },
            trace_id: "trace_mixed_detail",
          },
        ],
        trace_id: "trace_mixed_detail",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return {
        title: "Onboarding 流程",
        content: "內容重點：新人報到、工具開通、第一週訓練、owner 追蹤與驗收。",
      };
    },
  });

  const envelope = buildPlannedUserInputEnvelope(buildExecuteLikeResult(runtimeResult, {
    limit: 5,
    q: "整理 onboarding 流程並解釋",
    query: "整理 onboarding 流程並解釋",
  }));
  const response = normalizeUserResponse({
    plannerEnvelope: adaptEnvelopeForCurrentNormalizer(envelope, {
      answer: "我先以「Onboarding 流程」作為這輪最直接的對應文件。 內容重點：新人報到、工具開通、第一週訓練、owner 追蹤與驗收。",
      sources: [
        {
          title: "Onboarding 流程",
          url: "https://example.com/onboarding",
          snippet: "內容重點：新人報到、工具開通、第一週訓練、owner 追蹤與驗收。",
        },
      ],
      limitations: ["如果你要，我可以再把這份流程整理成 checklist。"],
    }),
  });
  const text = renderUserResponseText(response);

  assert.equal(runtimeResult.selected_action, "search_and_detail_doc");
  assert.equal(runtimeResult.routing_reason, "doc_query_search_and_detail");
  assert.equal(presetCalls.length, 1);
  assert.equal(presetCalls[0].preset, "search_and_detail_doc");
  assert.equal(runtimeResult.execution_result?.ok, true);
  assert.equal(runtimeResult.execution_result?.preset, "search_and_detail_doc");
  assert.equal(runtimeResult.execution_result?.formatted_output?.kind, "search_and_detail");
  assertCanonicalPlannerEnvelope(envelope, {
    action: "search_and_detail_doc",
    ok: true,
    fallbackReason: null,
    kind: "search_and_detail",
  });
  assert.match(response.answer || "", /Onboarding 流程/);
  assert.match(response.answer || "", /新人報到|工具開通/);
  assertPublicAnswerShape(response, text);
});
