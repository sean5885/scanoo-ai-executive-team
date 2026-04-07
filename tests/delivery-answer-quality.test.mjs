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

function adaptEnvelopeForCurrentNormalizer(envelope = {}) {
  return {
    ...envelope,
    execution_result: {
      ...(envelope?.execution_result && typeof envelope.execution_result === "object" ? envelope.execution_result : {}),
    },
  };
}

function assertPublicAnswerShape(response = {}, text = "") {
  assert.equal(typeof response.answer, "string");
  assert.equal(Array.isArray(response.sources), true);
  assert.equal(Array.isArray(response.limitations), true);
  assert.doesNotMatch(JSON.stringify(response), /"(?:action|execution_result|payload|result|kind|trace|trace_id|side_effects)"/);
  assert.doesNotMatch(text, /execution_result|payload|side_effects|trace_id|skill_bridge|get_runtime_info|routing_no_match|business_error/);
}

test("delivery answer quality turns SOP location search into a direct answer instead of generic search copy", async () => {
  resetPlannerRuntimeContext();
  const runtimeResult = await runPlannerToolFlow({
    userIntent: "導入 SOP 在哪",
    payload: { limit: 5 },
    logger: quietLogger,
    async dispatcher({ action }) {
      assert.equal(action, "search_company_brain_docs");
      return {
        ok: true,
        action: "company_brain_docs_search",
        items: [
          {
            doc_id: "doc_impl_sop",
            title: "導入 SOP",
            url: "https://example.com/implementation-sop",
            summary: {
              snippet: "文件位置在 Delivery / Onboarding 資料夾；需求確認、環境開通、資料準備、試跑驗收。",
            },
          },
        ],
        trace_id: "trace_delivery_location",
      };
    },
  });

  const envelope = buildPlannedUserInputEnvelope(buildExecuteLikeResult(runtimeResult, {
    limit: 5,
    q: "導入 SOP 在哪",
    query: "導入 SOP 在哪",
  }));
  const response = normalizeUserResponse({
    plannerEnvelope: adaptEnvelopeForCurrentNormalizer(envelope),
  });
  const text = renderUserResponseText(response);

  assert.equal(runtimeResult.selected_action, "search_company_brain_docs");
  assert.match(response.answer || "", /導入 SOP/);
  assert.match(response.answer || "", /Delivery \/ Onboarding 資料夾|連結/);
  assert.doesNotMatch(response.answer || "", /我已先按目前已索引的文件/);
  assert.doesNotMatch(response.limitations.join("\n"), /排除|重分配/);
  assertPublicAnswerShape(response, text);
});

test("delivery answer quality turns onboarding checklist search into a usable first answer", async () => {
  resetPlannerRuntimeContext();
  const runtimeResult = await runPlannerToolFlow({
    userIntent: "onboarding checklist 是什麼",
    payload: { limit: 5 },
    logger: quietLogger,
    async dispatcher({ action }) {
      assert.equal(action, "search_company_brain_docs");
      return {
        ok: true,
        action: "company_brain_docs_search",
        items: [
          {
            doc_id: "doc_onboarding_checklist",
            title: "Onboarding Checklist",
            url: "https://example.com/onboarding-checklist",
            summary: {
              snippet: "報到前準備、帳號開通、教育訓練、首週驗收。",
            },
          },
        ],
        trace_id: "trace_onboarding_checklist",
      };
    },
  });

  const envelope = buildPlannedUserInputEnvelope(buildExecuteLikeResult(runtimeResult, {
    limit: 5,
    q: "onboarding checklist 是什麼",
    query: "onboarding checklist 是什麼",
  }));
  const response = normalizeUserResponse({
    plannerEnvelope: adaptEnvelopeForCurrentNormalizer(envelope),
  });
  const text = renderUserResponseText(response);

  assert.equal(runtimeResult.selected_action, "search_company_brain_docs");
  assert.match(response.answer || "", /Onboarding Checklist/);
  assert.match(response.answer || "", /帳號開通|教育訓練|首週驗收/);
  assert.doesNotMatch(response.answer || "", /我已先按目前已索引的文件/);
  assertPublicAnswerShape(response, text);
});

test("delivery answer quality turns delivery start search into concrete first-step guidance", async () => {
  resetPlannerRuntimeContext();
  const runtimeResult = await runPlannerToolFlow({
    userIntent: "怎麼開始導入",
    payload: { limit: 5 },
    logger: quietLogger,
    async dispatcher({ action }) {
      assert.equal(action, "search_company_brain_docs");
      return {
        ok: true,
        action: "company_brain_docs_search",
        items: [
          {
            doc_id: "doc_impl_sop",
            title: "導入 SOP",
            url: "https://example.com/implementation-sop",
            summary: {
              snippet: "先確認導入目標與 owner，再完成環境開通、資料準備、試跑驗收。",
            },
          },
        ],
        trace_id: "trace_delivery_start",
      };
    },
  });

  const envelope = buildPlannedUserInputEnvelope(buildExecuteLikeResult(runtimeResult, {
    limit: 5,
    q: "怎麼開始導入",
    query: "怎麼開始導入",
  }));
  const response = normalizeUserResponse({
    plannerEnvelope: adaptEnvelopeForCurrentNormalizer(envelope),
  });
  const text = renderUserResponseText(response);

  assert.equal(runtimeResult.selected_action, "search_company_brain_docs");
  assert.match(response.answer || "", /導入 SOP/);
  assert.match(response.answer || "", /先確認導入目標|環境開通|資料準備/);
  assert.doesNotMatch(response.answer || "", /我已先按目前已索引的文件/);
  assertPublicAnswerShape(response, text);
});
