import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
const testDb = await createTestDbHarness();
const {
  assertRoutingDecisionFinalOwner,
  assertRoutingDecisionOwner,
  buildScanooCompareFallbackQuery,
  buildScanooCompareDocsSearchReply,
  buildScanooDiagnoseOfficialReadReply,
  executePlannerBackedLaneForTest,
  filterScanooCompareDocsSearchItems,
  looksLikeChatOnlyFailurePreference,
  looksLikeCloudOrganizationExit,
  looksLikeCloudOrganizationPlainLanguageRequest,
  looksLikeCloudOrganizationReReviewRequest,
  looksLikeCloudOrganizationReviewRequest,
  looksLikeCloudOrganizationRequest,
  looksLikeCloudOrganizationWhyRequest,
  looksLikeDeleteMeetingDocRequest,
  looksLikeMeetingCaptureStatusQuery,
  pickCalendarMeetingEvent,
  maybeBuildScanooDiagnoseOfficialReadFallback,
  maybeBuildScanooCompareDocsSearchFallback,
  resolveLaneExecutionPlan,
  resolveScanooLanePreTimeoutPlan,
  resolveReferencedDocumentId,
  shouldFallbackScanooCompareToDocsSearch,
  shouldFallbackScanooDiagnoseToOfficialRead,
  shouldPreferActiveExecutiveTask,
  shouldFallbackImageTaskToTextLane,
} = await import("../src/lane-executor.mjs");
import { buildVisibleMessageText } from "../src/message-intent-utils.mjs";

test.after(() => {
  testDb.close();
});

test("pickCalendarMeetingEvent prefers the currently active meeting with meeting_url", () => {
  const selected = pickCalendarMeetingEvent(
    [
      {
        event_id: "evt-future",
        summary: "Next meeting",
        start_time: "1773658800",
        end_time: "1773662400",
        meeting_url: "https://meet.example/future",
      },
      {
        event_id: "evt-current",
        summary: "Current meeting",
        start_time: "1773651600",
        end_time: "1773655200",
        meeting_url: "https://meet.example/current",
      },
    ],
    1773653400 * 1000,
  );

  assert.equal(selected?.event_id, "evt-current");
});

test("pickCalendarMeetingEvent falls back to the nearest upcoming meeting", () => {
  const selected = pickCalendarMeetingEvent(
    [
      {
        event_id: "evt-later",
        summary: "Later meeting",
        start_time: "1773666000",
        end_time: "1773669600",
        meeting_url: "https://meet.example/later",
      },
      {
        event_id: "evt-next",
        summary: "Next meeting",
        start_time: "1773657000",
        end_time: "1773660600",
        meeting_url: "https://meet.example/next",
      },
    ],
    1773653400 * 1000,
  );

  assert.equal(selected?.event_id, "evt-next");
});

test("meeting capture status query is recognized", () => {
  assert.equal(looksLikeMeetingCaptureStatusQuery("請問在持續記錄中嗎"), true);
  assert.equal(looksLikeMeetingCaptureStatusQuery("還在錄嗎"), true);
  assert.equal(looksLikeMeetingCaptureStatusQuery("好的"), false);
});

test("visible message text excludes raw json payload duplication", () => {
  const text = buildVisibleMessageText({
    text: "好的",
    message: {
      content: "{\"text\":\"好的\"}",
    },
  });

  assert.equal(text, "好的");
});

test("delete generated meeting doc request is recognized", () => {
  assert.equal(looksLikeDeleteMeetingDocRequest("這個文檔可以直接刪掉了"), true);
  assert.equal(looksLikeDeleteMeetingDocRequest("把這個文檔刪掉吧"), true);
  assert.equal(looksLikeDeleteMeetingDocRequest("今天先整理一下"), false);
});

test("chat-only failure preference is recognized", () => {
  assert.equal(looksLikeChatOnlyFailurePreference("未來如果還是會遇到這個問題 直接在對話裡寫給我就好"), true);
  assert.equal(looksLikeChatOnlyFailurePreference("不需要再建立新文檔了"), true);
  assert.equal(looksLikeChatOnlyFailurePreference("請幫我再建一份文檔"), false);
});

test("cloud organization request is recognized", () => {
  assert.equal(looksLikeCloudOrganizationRequest("把我的雲文檔做分類 指派給對應的角色"), true);
  assert.equal(looksLikeCloudOrganizationRequest("幫我把雲文件歸類並分配角色"), true);
  assert.equal(looksLikeCloudOrganizationRequest("去學習吧 各個角色分別看完之後要告訴我哪些文檔跟你無關 我們再重新分配"), true);
  assert.equal(looksLikeCloudOrganizationRequest("幫我看今天日程"), false);
});

test("cloud organization exit is recognized", () => {
  assert.equal(looksLikeCloudOrganizationExit("退出分類模式"), true);
  assert.equal(looksLikeCloudOrganizationExit("先不要分類"), true);
  assert.equal(looksLikeCloudOrganizationExit("幫我看今天日程"), false);
});

test("cloud organization review follow-up is recognized", () => {
  assert.equal(
    looksLikeCloudOrganizationReviewRequest("先請各個 agent 去學習，告訴我哪些文檔不是你的涉獵範圍"),
    true,
  );
  assert.equal(
    looksLikeCloudOrganizationReviewRequest("我們統一再進行第二次分配"),
    true,
  );
  assert.equal(
    looksLikeCloudOrganizationReviewRequest("這些待人工確認的文件，到底為什麼不能直接分配？"),
    true,
  );
  assert.equal(looksLikeCloudOrganizationReviewRequest("幫我看今天日程"), false);
});

test("cloud organization explicit rereview follow-up is recognized", () => {
  assert.equal(
    looksLikeCloudOrganizationReReviewRequest("去學習吧 各個角色分別看完之後要告訴我哪些文檔跟你無關 我們再重新分配"),
    true,
  );
  assert.equal(looksLikeCloudOrganizationReReviewRequest("好的，現在請告訴我還有什麼內容是需要我二次做確認的"), false);
});

test("cloud organization plain-language follow-up is recognized", () => {
  assert.equal(looksLikeCloudOrganizationPlainLanguageRequest("我看不懂，請講人話"), true);
  assert.equal(looksLikeCloudOrganizationPlainLanguageRequest("這個沒在講人話"), true);
  assert.equal(looksLikeCloudOrganizationPlainLanguageRequest("幫我看今天日程"), false);
});

test("cloud organization why-follow-up is recognized", () => {
  assert.equal(looksLikeCloudOrganizationWhyRequest("這些待人工確認的文件，到底為什麼不能直接分配？"), true);
  assert.equal(looksLikeCloudOrganizationWhyRequest("為什麼不能直接分派"), true);
  assert.equal(looksLikeCloudOrganizationWhyRequest("幫我看今天日程"), false);
});

test("cloud organization active-mode follow-up remains in second-pass workflow", () => {
  assert.equal(looksLikeCloudOrganizationRequest("好的，現在請告訴我還有什麼內容是需要我二次做確認的"), false);
  assert.equal(looksLikeCloudOrganizationReviewRequest("好的，現在請告訴我還有什麼內容是需要我二次做確認的"), true);
});

test("missing final_owner throws immediately", () => {
  assert.throws(
    () => assertRoutingDecisionFinalOwner({}),
    /control_kernel_missing_final_owner/,
  );
});

test("owner assertion throws when actual dispatch owner mismatches final_owner", () => {
  assert.throws(
    () => assertRoutingDecisionOwner({ expected: "doc-editor", actual: "personal-assistant" }),
    /control_kernel_owner_mismatch: expected=doc-editor actual=personal-assistant/,
  );
});

test("owner assertion passes when executive dispatch matches final_owner", () => {
  assert.equal(
    assertRoutingDecisionOwner({ expected: "executive", actual: "executive" }),
    "executive",
  );
});

test("multimodal image exception falls back to text lane", () => {
  assert.equal(
    shouldFallbackImageTaskToTextLane({
      modality: "multimodal",
      text: "我現在不太清楚 這個是什麼東西 是什麼文件名字呢",
      error: new Error("Failed to download Lark image: 400"),
    }),
    true,
  );
  assert.equal(
    shouldFallbackImageTaskToTextLane({
      modality: "image",
      text: "",
      error: new Error("Failed to download Lark image: 400"),
    }),
    false,
  );
});

test("active meeting workflow stays on meeting follow-up path", () => {
  assert.equal(
    shouldPreferActiveExecutiveTask({
      activeTask: {
        id: "task-meeting-1",
        status: "active",
        workflow: "meeting",
      },
      lane: "personal-assistant",
      wantsCloudOrganizationFollowUp: false,
    }),
    true,
  );
});

test("lane execution plan separates document summary from recent dialogue summary", () => {
  const documentPlan = resolveLaneExecutionPlan({
    scope: {
      capability_lane: "knowledge-assistant",
    },
    event: {
      message: {
        content: JSON.stringify({
          text: "幫我整理文件重點",
        }),
      },
    },
  });
  const dialoguePlan = resolveLaneExecutionPlan({
    scope: {
      capability_lane: "personal-assistant",
    },
    event: {
      message: {
        content: JSON.stringify({
          text: "幫我總結最近對話",
        }),
      },
    },
  });

  assert.equal(documentPlan.chosen_lane, "knowledge-assistant");
  assert.equal(documentPlan.chosen_action, "planner_user_input");
  assert.equal(dialoguePlan.chosen_lane, "personal-assistant");
  assert.equal(dialoguePlan.chosen_action, "summarize_recent_dialogue");
});

test("scanoo-diagnose lane keeps a distinct execution identity while reusing planner-backed analysis", () => {
  const plan = resolveLaneExecutionPlan({
    scope: {
      capability_lane: "scanoo-diagnose",
    },
    event: {
      message: {
        content: JSON.stringify({
          text: "請幫我診斷 Scanoo onboarding funnel 為什麼掉轉換",
        }),
      },
    },
  });

  assert.equal(plan.chosen_lane, "scanoo-diagnose");
  assert.equal(plan.chosen_action, "scanoo_diagnose_user_input");
  assert.equal(plan.fallback_reason, null);
});

test("scanoo-compare lane keeps a distinct execution identity while reusing planner-backed comparison", () => {
  const plan = resolveLaneExecutionPlan({
    scope: {
      capability_lane: "scanoo-compare",
    },
    event: {
      message: {
        content: JSON.stringify({
          text: "請幫我比較 Scanoo onboarding funnel 的新舊差異",
        }),
      },
    },
  });

  assert.equal(plan.chosen_lane, "scanoo-compare");
  assert.equal(plan.chosen_action, "scanoo_compare_user_input");
  assert.equal(plan.fallback_reason, null);
});

test("scanoo-compare falls back to docs search when compare evidence is insufficient", () => {
  const shouldFallback = shouldFallbackScanooCompareToDocsSearch({
    requestText: "請幫我比較 Scanoo onboarding funnel 的新舊差異",
    plannerResult: {
      ok: false,
      error: "planner_failed",
    },
    userResponse: {
      ok: false,
      answer: "這題本來應該先走對應的查詢或流程，但這輪還沒真的執行到那個步驟，所以我先不亂補答案。",
      sources: [],
      limitations: ["目前資料不足，還不能直接比較。"],
      failure_class: "tool_omission",
    },
  });

  assert.equal(shouldFallback, true);
});

test("scanoo-diagnose falls back to official read when evidence is insufficient and no doc-read action ran", () => {
  const shouldFallback = shouldFallbackScanooDiagnoseToOfficialRead({
    requestText: "請幫我診斷這份 onboarding 文件為什麼會導致轉化下滑",
    plannerResult: {
      ok: false,
      error: "planner_failed",
      action: "search_company_brain_docs",
    },
    userResponse: {
      ok: false,
      answer: "這題本來應該先走對應的查詢或流程，但這輪還沒真的執行到那個步驟，所以我先不亂補答案。",
      sources: [],
      limitations: ["目前資料不足，還不能直接判斷根因。"],
      failure_class: "tool_omission",
    },
  });

  assert.equal(shouldFallback, true);
});

test("scanoo-diagnose does not fall back to official read when planner already chose fetch_document", () => {
  const shouldFallback = shouldFallbackScanooDiagnoseToOfficialRead({
    requestText: "請幫我診斷這份 onboarding 文件為什麼會導致轉化下滑",
    plannerResult: {
      ok: true,
      action: "fetch_document",
    },
    userResponse: {
      ok: false,
      answer: "我先讀文件。",
      sources: [],
      limitations: ["目前先讀文件。"],
      failure_class: "tool_omission",
    },
  });

  assert.equal(shouldFallback, false);
});

test("scanoo-compare fallback query shaping extracts stores and metrics", () => {
  const query = buildScanooCompareFallbackQuery("幫我比較 A店 和 B店 的流量、轉化，幫我看看");

  assert.equal(query, "A店 vs B店 + 流量 轉化");
});

test("scanoo-compare fallback query shaping removes stopwords when compare pair is incomplete", () => {
  const query = buildScanooCompareFallbackQuery("幫我看看 A店 流量 比較 一下");

  assert.equal(query, "A店 流量");
});

test("scanoo-compare docs search fallback keeps section order and returns normal compare with two valid evidences", () => {
  const reply = buildScanooCompareDocsSearchReply({
    query: "比較 A店 與 B店 的流量與轉化",
    items: [
      {
        title: "A店 onboarding weekly report",
        doc_id: "doc_scanoo_compare_1",
        summary: {
          overview: "A店在 2026-03 的流量 12000、轉化 3.2%，留存 28%。",
        },
      },
      {
        title: "B店 onboarding weekly report",
        doc_id: "doc_scanoo_compare_2",
        summary: {
          overview: "B店在 2026-03 的流量 9800、轉化 2.6%，留存 24%。",
        },
      },
    ],
  });

  assert.match(reply, /【比較對象】[\s\S]*【比較維度】[\s\S]*【核心差異】[\s\S]*【原因假設】[\s\S]*【證據 \/ 不確定性】[\s\S]*【建議行動】/);
  assert.match(reply, /A店 onboarding weekly report（doc_scanoo_compare_1）/);
  assert.match(reply, /正式比較/);
  assert.doesNotMatch(reply, /partial comparison/);
});

test("scanoo-compare docs search fallback uses partial comparison when only one side has valid evidence", () => {
  const reply = buildScanooCompareDocsSearchReply({
    query: "比較 A店 與 B店 的流量與轉化",
    items: [
      {
        title: "A店 onboarding weekly report",
        doc_id: "doc_scanoo_compare_one_sided",
        summary: {
          overview: "A店在 2026-03 的流量 12000、轉化 3.2%。",
        },
      },
    ],
  });

  assert.match(reply, /partial comparison/);
  assert.match(reply, /已確認觀察：A店 側/);
  assert.match(reply, /另一側缺口：B店 側/);
  assert.match(reply, /最小補數據/);
  assert.doesNotMatch(reply, /正式比較/);
});

test("scanoo-compare docs search fallback uses partial comparison when one query metric is missing on one side", () => {
  const reply = buildScanooCompareDocsSearchReply({
    query: "比較 A店 與 B店 的流量與轉化",
    items: [
      {
        title: "A店 onboarding weekly report",
        doc_id: "doc_scanoo_compare_metric_full",
        summary: {
          overview: "A店在 2026-03 的流量 12000、轉化 3.2%。",
        },
      },
      {
        title: "B店 onboarding weekly report",
        doc_id: "doc_scanoo_compare_metric_gap",
        summary: {
          overview: "B店在 2026-03 的流量 9800。",
        },
      },
    ],
  });

  assert.match(reply, /partial comparison/);
  assert.match(reply, /雙側對齊指標（轉化）/);
  assert.match(reply, /方向推估：就目前已知指標覆蓋/);
  assert.doesNotMatch(reply, /正式比較/);
});

test("scanoo-compare relevance gate filters demo\/test\/stub\/sample style evidence", () => {
  const filtered = filterScanooCompareDocsSearchItems([
    {
      title: "Scanoo Compare Demo",
      doc_id: "doc_scanoo_compare_demo",
      url: "https://example.com/doc_scanoo_compare_demo",
    },
    {
      title: "Scanoo Compare Success Probe",
      doc_id: "doc_scanoo_compare_success_probe",
    },
    {
      title: "Scanoo Compare Final Validation",
      doc_id: "doc_scanoo_compare_final_validation",
    },
    {
      title: "Scanoo Compare Minimal Artifact",
      doc_id: "doc_scanoo_compare_minimal_artifact",
    },
    {
      title: "Scanoo Compare Stub Sample",
      doc_id: "doc_scanoo_compare_stub_sample",
    },
    {
      title: "Scanoo Compare Test Fixture",
      doc_id: "doc_scanoo_compare_test_fixture",
    },
    {
      title: "A店 onboarding weekly report",
      doc_id: "doc_scanoo_compare_1",
      summary: {
        overview: "A店在 2026-03 的流量 12000、轉化 3.2%，留存 28%。",
      },
    },
  ], {
    query: "比較 A店 與 B店 的流量與轉化",
  });

  assert.deepEqual(filtered.map((item) => item.doc_id), ["doc_scanoo_compare_1"]);
});

test("scanoo-compare docs search fallback uses partial comparison when one valid and one invalid evidence are mixed", () => {
  const reply = buildScanooCompareDocsSearchReply({
    query: "比較 A店 與 B店 的流量與轉化",
    items: [
      {
        title: "A店 onboarding weekly report",
        doc_id: "doc_scanoo_compare_1",
        summary: {
          overview: "A店在 2026-03 的流量 12000、轉化 3.2%，留存 28%。",
        },
      },
      {
        title: "Scanoo Compare Demo",
        doc_id: "doc_scanoo_compare_demo",
      },
    ],
  });

  assert.match(reply, /partial comparison/);
  assert.match(reply, /doc_scanoo_compare_1/);
  assert.doesNotMatch(reply, /doc_scanoo_compare_demo/);
  assert.match(reply, /仍缺/);
});

test("scanoo-compare docs search fallback reports concrete gaps when no valid evidence remains", () => {
  const reply = buildScanooCompareDocsSearchReply({
    query: "比較 A店 與 B店 的流量與轉化",
    items: [
      {
        title: "Scanoo Compare Verify Fixture",
        doc_id: "doc_scanoo_compare_verify_fixture",
      },
      {
        title: "Scanoo Intro Note",
        doc_id: "doc_scanoo_compare_intro",
        summary: {
          overview: "只描述流程，沒有指標與日期。",
        },
      },
    ],
  });

  assert.match(reply, /0 份通過 relevance gate/);
  assert.match(reply, /不會直接回泛化 fallback/);
  assert.match(reply, /A店/);
  assert.match(reply, /B店/);
  assert.match(reply, /流量 \/ 轉化/);
  assert.doesNotMatch(reply, /partial comparison/);
  assert.doesNotMatch(reply, /正式比較/);
  assert.doesNotMatch(reply, /doc_scanoo_compare_verify_fixture/);
});

test("scanoo-diagnose official read fallback keeps the diagnose section order", () => {
  const reply = buildScanooDiagnoseOfficialReadReply({
    requestText: "請幫我診斷 onboarding 文件裡的轉化問題",
    document: {
      title: "Scanoo Onboarding SOP",
      document_id: "doc_scanoo_diag_1",
      content: "這份文件定義了 onboarding 的流程、角色分工與主要轉化節點。",
    },
    documentRef: {
      source: "referenced_message",
    },
  });

  assert.match(reply, /【問題現象】[\s\S]*【可能原因】[\s\S]*【目前證據】[\s\S]*【不確定性】[\s\S]*【建議下一步】/);
  assert.match(reply, /Scanoo Onboarding SOP/);
  assert.match(reply, /doc_scanoo_diag_1/);
});

test("resolveReferencedDocumentId 能從 plugin-dispatch handoff 的 document_refs 解析 obj_token", async () => {
  const logs = [];
  const result = await resolveReferencedDocumentId(
    {
      message: {
        content: JSON.stringify({
          text: "請幫我診斷這份文件",
          document_refs: [
            {
              obj_token: "MFK7dDFLFoVlOGxWCv5cTXKmnMh",
              title: "Scanoo Diagnose SOP",
            },
          ],
        }),
      },
      __lobster_plugin_dispatch: {
        plugin_context: {
          document_refs: [
            {
              obj_token: "MFK7dDFLFoVlOGxWCv5cTXKmnMh",
              title: "Scanoo Diagnose SOP",
            },
          ],
        },
      },
    },
    "user-token",
    {
      info(event, payload) {
        logs.push([event, payload]);
      },
      warn() {},
    },
  );

  assert.equal(result.documentId, "MFK7dDFLFoVlOGxWCv5cTXKmnMh");
  assert.match(result.source, /current_message|plugin_context_document_refs/);
  assert.equal(
    logs.some(([event, payload]) => (
      event === "doc_resolution_hit"
      && /current_message|plugin_context_document_refs/.test(String(payload?.source || ""))
      && payload?.document_id
    )),
    true,
  );
});

test("resolveReferencedDocumentId 會在 diagnose document_refs 只有 title 時自動 search 補 document_id", async () => {
  const logs = [];
  const event = {
    message: {
      content: JSON.stringify({
        text: "請幫我診斷這份文件",
        document_refs: [
          {
            title: "Scanoo Diagnose SOP",
          },
        ],
      }),
    },
    __lobster_plugin_dispatch: {
      plugin_context: {
        document_refs: [
          {
            title: "Scanoo Diagnose SOP",
          },
        ],
      },
    },
  };
  const result = await resolveReferencedDocumentId(
    event,
    "user-token",
    {
      info(event, payload) {
        logs.push([event, payload]);
      },
      warn(event, payload) {
        logs.push([event, payload]);
      },
      compactError(error) {
        return { message: error?.message || String(error) };
      },
    },
    {
      accountId: "acct-diagnose",
      allowDocsSearchFallback: true,
      async searchDocs() {
        return {
          items: [
            {
              title: "Scanoo Diagnose SOP",
              doc_id: "doc_diag_search_1",
            },
          ],
        };
      },
    },
  );

  assert.equal(result.documentId, "doc_diag_search_1");
  assert.equal(result.source, "plugin_context_document_refs_title_search");
  assert.equal(event.__lobster_plugin_dispatch.plugin_context.document_refs[0].document_id, "doc_diag_search_1");
  assert.equal(
    logs.some(([event, payload]) => (
      event === "doc_resolution_search_hit"
      && payload?.document_id
    )),
    true,
  );
});

test("scanoo-diagnose official read fallback 強制讀取已解析出的 document_id", async () => {
  const reply = await maybeBuildScanooDiagnoseOfficialReadFallback({
    accountId: "acct-diagnose",
    explicitAuth: {
      account_id: "acct-diagnose",
      access_token: "user-token",
    },
    requestText: "請幫我診斷 onboarding 文件裡的轉化問題",
    plannerResult: {
      ok: true,
      action: "search_company_brain_docs",
    },
    userResponse: {
      ok: true,
      answer: "先維持一般診斷回覆。",
      sources: ["planner_source"],
      limitations: [],
    },
    forceRead: true,
    resolvedDocumentRef: {
      documentId: "doc_diag_force_1",
      source: "plugin_context_document_refs_title_search",
    },
    async readDocument({ documentId }) {
      assert.equal(documentId, "doc_diag_force_1");
      return {
        title: "Scanoo Diagnose SOP",
        document_id: documentId,
        content: "這份文件定義了 onboarding 的診斷流程與主要轉化節點。",
      };
    },
    logger: {
      info() {},
      warn() {},
      compactError(error) {
        return { message: error?.message || String(error) };
      },
    },
  });

  assert.match(reply, /Scanoo Diagnose SOP/);
  assert.match(reply, /doc_diag_force_1/);
  assert.match(reply, /【目前證據】/);
});

test("scanoo-diagnose official read fallback 會在 title-only docref resolve 後強制進 official read", async () => {
  const reply = await maybeBuildScanooDiagnoseOfficialReadFallback({
    event: {
      message: {
        content: JSON.stringify({
          text: "請幫我診斷 onboarding 文件裡的轉化問題",
          document_refs: [
            {
              title: "Scanoo Diagnose SOP",
            },
          ],
        }),
      },
      __lobster_plugin_dispatch: {
        plugin_context: {
          document_refs: [
            {
              title: "Scanoo Diagnose SOP",
            },
          ],
        },
      },
    },
    accountId: "acct-diagnose",
    explicitAuth: {
      account_id: "acct-diagnose",
      access_token: "user-token",
    },
    requestText: "請幫我診斷 onboarding 文件裡的轉化問題",
    plannerResult: {
      ok: false,
      error: "planner_failed",
      action: "search_company_brain_docs",
    },
    userResponse: {
      ok: false,
      answer: "這題本來應該先走對應的查詢或流程，但這輪還沒真的執行到那個步驟，所以我先不亂補答案。",
      sources: [],
      limitations: ["目前資料不足，還不能直接判斷根因。"],
      failure_class: "tool_omission",
    },
    async searchDocs({ query }) {
      assert.equal(query, "Scanoo Diagnose SOP");
      return {
        items: [
          {
            title: "Scanoo Diagnose SOP",
            doc_id: "doc_diag_resolved_1",
          },
        ],
      };
    },
    async readDocument({ documentId }) {
      assert.equal(documentId, "doc_diag_resolved_1");
      return {
        title: "Scanoo Diagnose SOP",
        document_id: documentId,
        content: "這份文件定義了 diagnose official read 的檢查流程。",
      };
    },
    logger: {
      info() {},
      warn() {},
      compactError(error) {
        return { message: error?.message || String(error) };
      },
    },
  });

  assert.match(reply, /Scanoo Diagnose SOP/);
  assert.match(reply, /doc_diag_resolved_1/);
  assert.match(reply, /【目前證據】/);
});

test("scanoo-diagnose official read fallback resolve 失敗時回 bounded diagnose fallback，不回 generic", async () => {
  const reply = await maybeBuildScanooDiagnoseOfficialReadFallback({
    event: {
      message: {
        content: JSON.stringify({
          text: "請幫我診斷 onboarding 文件裡的轉化問題",
          document_refs: [
            {
              query: "Scanoo onboarding diagnose 手冊",
            },
          ],
        }),
      },
      __lobster_plugin_dispatch: {
        plugin_context: {
          document_refs: [
            {
              query: "Scanoo onboarding diagnose 手冊",
            },
          ],
        },
      },
    },
    accountId: "acct-diagnose",
    explicitAuth: {
      account_id: "acct-diagnose",
      access_token: "user-token",
    },
    requestText: "請幫我診斷 onboarding 文件裡的轉化問題",
    plannerResult: {
      ok: false,
      error: "planner_failed",
      action: "search_company_brain_docs",
    },
    userResponse: {
      ok: false,
      answer: "這題本來應該先走對應的查詢或流程，但這輪還沒真的執行到那個步驟，所以我先不亂補答案。",
      sources: [],
      limitations: ["目前資料不足，還不能直接判斷根因。"],
      failure_class: "tool_omission",
    },
    async searchDocs() {
      return {
        items: [],
      };
    },
    async readDocument() {
      assert.fail("readDocument should not be called when document_id cannot be resolved");
    },
    logger: {
      info() {},
      warn() {},
      compactError(error) {
        return { message: error?.message || String(error) };
      },
    },
  });

  assert.match(reply, /【問題現象】[\s\S]*【可能原因】[\s\S]*【目前證據】[\s\S]*【不確定性】[\s\S]*【建議下一步】/);
  assert.match(reply, /補出可直接讀取的 document_id/);
  assert.match(reply, /Scanoo onboarding diagnose 手冊/);
  assert.doesNotMatch(reply, /這題本來應該先走對應的查詢或流程/);
});

test("scanoo-diagnose pre-timeout fallback 會優先讀 plugin handoff 的 explicit user token", async () => {
  const logs = [];
  const reply = await maybeBuildScanooDiagnoseOfficialReadFallback({
    event: {
      context: {
        account_id: "acct-diagnose",
      },
      __lobster_plugin_dispatch: {
        plugin_context: {
          explicit_auth: {
            account_id: "acct-diagnose",
            access_token: "plugin-user-token",
            source: "plugin_dispatch_params",
          },
        },
      },
    },
    accountId: "acct-diagnose",
    explicitAuth: null,
    requestText: "請幫我診斷 onboarding 文件裡的轉化問題",
    plannerResult: {
      ok: false,
      error: "request_timeout",
    },
    userResponse: {
      ok: false,
      answer: "這次處理逾時了，我還沒有拿到可以安全交付的結果。",
      sources: [],
      limitations: [],
    },
    forceRead: true,
    resolvedDocumentRef: {
      documentId: "doc_diag_handoff_1",
      source: "plugin_context_document_refs",
    },
    async readDocument({ accountId, accessToken, documentId }) {
      assert.equal(accountId, "acct-diagnose");
      assert.equal(accessToken, "plugin-user-token");
      assert.equal(documentId, "doc_diag_handoff_1");
      return {
        title: "Scanoo Diagnose Handoff SOP",
        document_id: documentId,
        content: "這份文件定義了 diagnose handoff 後的 official read 判讀方式。",
      };
    },
    logger: {
      info(event, payload) {
        logs.push([event, payload]);
      },
      warn() {},
      compactError(error) {
        return { message: error?.message || String(error) };
      },
    },
  });

  assert.match(reply, /Scanoo Diagnose Handoff SOP/);
  assert.equal(
    logs.some(([event, payload]) => (
      event === "scanoo_diagnose_official_read_fallback_skipped"
      && payload?.reason === "missing_explicit_user_access_token"
    )),
    false,
  );
});

test("scanoo-diagnose no token + 有 context 時回 non-generic weak-but-usable diagnose", async () => {
  const logs = [];
  const reply = await maybeBuildScanooDiagnoseOfficialReadFallback({
    event: {
      __lobster_plugin_dispatch: {
        plugin_context: {
          document_refs: [
            {
              title: "Scanoo Diagnose SOP",
            },
          ],
          explicit_auth: {
            account_id: "acct-diagnose",
            source: "plugin_dispatch_params",
          },
        },
      },
    },
    accountId: "acct-diagnose",
    explicitAuth: {
      account_id: "acct-diagnose",
      source: "plugin_dispatch_params",
    },
    requestText: "請幫我診斷 onboarding 文件裡的轉化問題",
    plannerResult: {
      ok: false,
      error: "planner_failed",
      action: "search_company_brain_docs",
    },
    userResponse: {
      ok: false,
      answer: "這題本來應該先走對應的查詢或流程，但這輪還沒真的執行到那個步驟，所以我先不亂補答案。",
      sources: ["目前手上只有 plugin handoff 帶進來的文件線索。"],
      limitations: ["目前資料不足，還不能直接判斷根因。"],
      failure_class: "tool_omission",
    },
    resolvedDocumentRef: {
      documentId: "doc_diag_ctx_1",
      matchedTitle: "Scanoo Diagnose SOP",
      source: "plugin_context_document_refs_title_search",
    },
    async readDocument() {
      assert.fail("readDocument should not be called when explicit user token is missing");
    },
    logger: {
      info(event, payload) {
        logs.push([event, payload]);
      },
      warn() {},
      compactError(error) {
        return { message: error?.message || String(error) };
      },
    },
  });

  assert.match(reply, /【問題現象】[\s\S]*【可能原因】[\s\S]*【目前證據】[\s\S]*【不確定性】[\s\S]*【建議下一步】/);
  assert.match(reply, /weak-but-usable/);
  assert.match(reply, /Scanoo Diagnose SOP/);
  assert.match(reply, /doc_diag_ctx_1/);
  assert.match(reply, /explicit user access token/);
  assert.doesNotMatch(reply, /這題本來應該先走對應的查詢或流程/);
  assert.equal(
    logs.some(([event, payload]) => (
      event === "scanoo_diagnose_official_read_fallback_skipped"
      && payload?.reason === "missing_explicit_user_access_token"
      && payload?.reply_mode === "bounded_context_backed_diagnose"
    )),
    true,
  );
});

test("scanoo-diagnose no token + 無 context 時也回 explicit limitation + bounded diagnose", async () => {
  const logs = [];
  const reply = await maybeBuildScanooDiagnoseOfficialReadFallback({
    event: {
      message: {
        content: JSON.stringify({
          text: "請幫我診斷 onboarding 文件裡的轉化問題",
        }),
      },
    },
    accountId: "acct-diagnose",
    explicitAuth: {
      account_id: "acct-diagnose",
    },
    requestText: "請幫我診斷 onboarding 文件裡的轉化問題",
    plannerResult: {
      ok: false,
      error: "planner_failed",
      action: "search_company_brain_docs",
    },
    userResponse: {
      ok: false,
      answer: "這題本來應該先走對應的查詢或流程，但這輪還沒真的執行到那個步驟，所以我先不亂補答案。",
      sources: [],
      limitations: ["目前資料不足，還不能直接判斷根因。"],
      failure_class: "tool_omission",
    },
    async readDocument() {
      assert.fail("readDocument should not be called when explicit user token is missing");
    },
    logger: {
      info(event, payload) {
        logs.push([event, payload]);
      },
      warn() {},
      compactError(error) {
        return { message: error?.message || String(error) };
      },
    },
  });

  assert.match(reply, /【問題現象】[\s\S]*【可能原因】[\s\S]*【目前證據】[\s\S]*【不確定性】[\s\S]*【建議下一步】/);
  assert.match(reply, /缺少可驗證的 explicit user access token/);
  assert.match(reply, /已知觀察：使用者這輪要診斷的是/);
  assert.match(reply, /下一步可驗證動作/);
  assert.doesNotMatch(reply, /這題本來應該先走對應的查詢或流程/);
  assert.equal(
    logs.some(([event, payload]) => (
      event === "scanoo_diagnose_official_read_fallback_skipped"
      && payload?.reason === "missing_explicit_user_access_token"
      && payload?.reply_mode === "bounded_prompt_only_diagnose"
    )),
    true,
  );
});

test("scanoo lane pre-timeout plan leaves a dedicated fallback window before route timeout", () => {
  const plan = resolveScanooLanePreTimeoutPlan({
    lane: "scanoo-compare",
    requestTimeoutMs: 15000,
  });

  assert.equal(plan?.hardTimeoutMs, 15000);
  assert.equal(plan?.routeLeadTimeMs, 1500);
  assert.equal(plan?.fallbackWindowMs, 1200);
  assert.equal(plan?.plannerTimeoutMs, 12300);
});

test("scanoo-compare pre-timeout fallback forces evidence search before returning timeout", async () => {
  const reply = await maybeBuildScanooCompareDocsSearchFallback({
    accountId: "acct-compare",
    requestText: "幫我比較 A店 和 B店 的流量、轉化",
    plannerResult: {
      ok: false,
      error: "request_timeout",
    },
    userResponse: {
      ok: false,
      answer: "這次處理逾時了，我還沒有拿到可以安全交付的結果。",
      sources: [],
      limitations: [],
    },
    forceSearch: true,
    logger: {
      info() {},
    },
    async searchDocs() {
      return {
        items: [
          {
            title: "A店 vs B店 compare snapshot",
            doc_id: "doc_compare_force_1",
            summary: {
              overview: "A店與B店在 2026-03 的流量 12000/9800，轉化 3.2%/2.6%。",
            },
          },
        ],
      };
    },
  });

  assert.match(reply, /【比較對象】/);
  assert.match(reply, /A店 vs B店 compare snapshot（doc_compare_force_1）/);
  assert.doesNotMatch(reply, /這次處理逾時了/);
});

test("explicit scanoo_compare capability runs lane fast-path before planner fallback flow", async () => {
  let plannerCalls = 0;
  let compareFallbackCalls = 0;
  const reply = await executePlannerBackedLaneForTest({
    event: {
      __lobster_plugin_dispatch: {
        requested_capability: "scanoo_compare",
      },
      message: {
        chat_id: "chat-scanoo-compare",
        content: JSON.stringify({
          text: "幫我比較 A店 和 B店 的轉化差異",
        }),
      },
    },
    scope: {
      capability_lane: "scanoo-compare",
      session_key: "thread:scanoo-compare",
      chat_id: "chat-scanoo-compare",
    },
    logger: {
      info() {},
      warn() {},
      compactError(error) {
        return error;
      },
    },
    async resolveAuthContextFn() {
      return {
        account: { id: "acct-scanoo-compare" },
        token: "tenant_token",
        tokenKind: "user",
      };
    },
    async resolvePlannerExplicitAuthContextFn() {
      return null;
    },
    async maybeBuildScanooCompareDocsSearchFallbackFn() {
      compareFallbackCalls += 1;
      return "【比較對象】\n- fast-path compare ready";
    },
    async runPlannerUserInputEdgeFn() {
      plannerCalls += 1;
      return {
        plannerResult: { ok: false, error: "request_timeout" },
        plannerEnvelope: { trace: {} },
        userResponse: { ok: false, answer: "planner timeout", sources: [], limitations: [] },
      };
    },
  });

  assert.equal(compareFallbackCalls, 1);
  assert.equal(plannerCalls, 0);
  assert.match(reply.text, /fast-path compare ready/);
});

test("explicit scanoo_diagnose capability runs lane fast-path before planner fallback flow", async () => {
  let plannerCalls = 0;
  let diagnoseFallbackCalls = 0;
  const reply = await executePlannerBackedLaneForTest({
    event: {
      __lobster_plugin_dispatch: {
        requested_capability: "scanoo_diagnose",
      },
      message: {
        chat_id: "chat-scanoo-diagnose",
        content: JSON.stringify({
          text: "幫我診斷 onboarding 為何下滑",
        }),
      },
    },
    scope: {
      capability_lane: "scanoo-diagnose",
      session_key: "thread:scanoo-diagnose",
      chat_id: "chat-scanoo-diagnose",
    },
    logger: {
      info() {},
      warn() {},
      compactError(error) {
        return error;
      },
    },
    async resolveAuthContextFn() {
      return {
        account: { id: "acct-scanoo-diagnose" },
        token: "tenant_token",
        tokenKind: "user",
      };
    },
    async resolvePlannerExplicitAuthContextFn() {
      return {
        account_id: "acct-scanoo-diagnose",
        access_token: "user_access_token",
      };
    },
    async resolveReferencedDocumentIdFn() {
      return {
        documentId: "doc_scanoo_fastpath",
        source: "plugin_context_document_refs",
      };
    },
    async maybeBuildScanooDiagnoseOfficialReadFallbackFn() {
      diagnoseFallbackCalls += 1;
      return "【問題現象】\n- fast-path diagnose ready";
    },
    async runPlannerUserInputEdgeFn() {
      plannerCalls += 1;
      return {
        plannerResult: { ok: false, error: "request_timeout" },
        plannerEnvelope: { trace: {} },
        userResponse: { ok: false, answer: "planner timeout", sources: [], limitations: [] },
      };
    },
  });

  assert.equal(diagnoseFallbackCalls, 1);
  assert.equal(plannerCalls, 0);
  assert.match(reply.text, /fast-path diagnose ready/);
});

test("scanoo_compare planner fallback path no longer re-enters lane after request_timeout", async () => {
  let plannerCalls = 0;
  let compareFallbackCalls = 0;
  const reply = await executePlannerBackedLaneForTest({
    event: {
      __lobster_plugin_dispatch: {
        requested_capability: "scanoo_compare",
      },
      message: {
        chat_id: "chat-scanoo-compare-timeout",
        content: JSON.stringify({
          text: "幫我比較 A店 和 B店",
        }),
      },
    },
    scope: {
      capability_lane: "scanoo-compare",
      session_key: "thread:scanoo-compare-timeout",
      chat_id: "chat-scanoo-compare-timeout",
    },
    logger: {
      info() {},
      warn() {},
      compactError(error) {
        return error;
      },
    },
    async resolveAuthContextFn() {
      return {
        account: { id: "acct-scanoo-compare-timeout" },
        token: "tenant_token",
        tokenKind: "user",
      };
    },
    async resolvePlannerExplicitAuthContextFn() {
      return null;
    },
    async maybeBuildScanooCompareDocsSearchFallbackFn() {
      compareFallbackCalls += 1;
      return null;
    },
    async runPlannerUserInputEdgeFn() {
      plannerCalls += 1;
      return {
        plannerResult: { ok: false, error: "request_timeout" },
        plannerEnvelope: { trace: {} },
        userResponse: { ok: false, answer: "planner timeout response", sources: [], limitations: [] },
      };
    },
    renderUserResponseTextFn(userResponse) {
      return `planner:${userResponse.answer}`;
    },
  });

  assert.equal(compareFallbackCalls, 1);
  assert.equal(plannerCalls, 1);
  assert.equal(reply.text, "planner:planner timeout response");
});

test("scanoo_diagnose planner fallback path no longer re-enters lane after request_timeout", async () => {
  let plannerCalls = 0;
  let diagnoseFallbackCalls = 0;
  const reply = await executePlannerBackedLaneForTest({
    event: {
      __lobster_plugin_dispatch: {
        requested_capability: "scanoo_diagnose",
      },
      message: {
        chat_id: "chat-scanoo-diagnose-timeout",
        content: JSON.stringify({
          text: "幫我診斷這份文件",
        }),
      },
    },
    scope: {
      capability_lane: "scanoo-diagnose",
      session_key: "thread:scanoo-diagnose-timeout",
      chat_id: "chat-scanoo-diagnose-timeout",
    },
    logger: {
      info() {},
      warn() {},
      compactError(error) {
        return error;
      },
    },
    async resolveAuthContextFn() {
      return {
        account: { id: "acct-scanoo-diagnose-timeout" },
        token: "tenant_token",
        tokenKind: "user",
      };
    },
    async resolvePlannerExplicitAuthContextFn() {
      return {
        account_id: "acct-scanoo-diagnose-timeout",
        access_token: "user_access_token",
      };
    },
    async resolveReferencedDocumentIdFn() {
      return {
        documentId: "doc_scanoo_diag_timeout",
        source: "plugin_context_document_refs",
      };
    },
    async maybeBuildScanooDiagnoseOfficialReadFallbackFn() {
      diagnoseFallbackCalls += 1;
      return null;
    },
    async runPlannerUserInputEdgeFn() {
      plannerCalls += 1;
      return {
        plannerResult: { ok: false, error: "request_timeout" },
        plannerEnvelope: { trace: {} },
        userResponse: { ok: false, answer: "planner timeout diagnose", sources: [], limitations: [] },
      };
    },
    renderUserResponseTextFn(userResponse) {
      return `planner:${userResponse.answer}`;
    },
  });

  assert.equal(diagnoseFallbackCalls, 1);
  assert.equal(plannerCalls, 1);
  assert.equal(reply.text, "planner:planner timeout diagnose");
});

test("non-scanoo capability keeps original planner-first flow", async () => {
  let plannerCalls = 0;
  let compareFallbackCalls = 0;
  let diagnoseFallbackCalls = 0;
  const reply = await executePlannerBackedLaneForTest({
    event: {
      __lobster_plugin_dispatch: {
        requested_capability: "knowledge_answer",
      },
      message: {
        chat_id: "chat-knowledge",
        content: JSON.stringify({
          text: "幫我找公司 SOP",
        }),
      },
    },
    scope: {
      capability_lane: "knowledge-assistant",
      session_key: "thread:knowledge",
      chat_id: "chat-knowledge",
    },
    logger: {
      info() {},
      warn() {},
      compactError(error) {
        return error;
      },
    },
    async resolveAuthContextFn() {
      return {
        account: { id: "acct-knowledge" },
        token: "tenant_token",
        tokenKind: "user",
      };
    },
    async resolvePlannerExplicitAuthContextFn() {
      return null;
    },
    async maybeBuildScanooCompareDocsSearchFallbackFn() {
      compareFallbackCalls += 1;
      return "unexpected";
    },
    async maybeBuildScanooDiagnoseOfficialReadFallbackFn() {
      diagnoseFallbackCalls += 1;
      return "unexpected";
    },
    async runPlannerUserInputEdgeFn() {
      plannerCalls += 1;
      return {
        plannerResult: { ok: true, action: "search_company_brain_docs" },
        plannerEnvelope: { trace: {} },
        userResponse: { ok: true, answer: "planner success", sources: [], limitations: [] },
      };
    },
    renderUserResponseTextFn(userResponse) {
      return `planner:${userResponse.answer}`;
    },
  });

  assert.equal(plannerCalls, 1);
  assert.equal(compareFallbackCalls, 0);
  assert.equal(diagnoseFallbackCalls, 0);
  assert.equal(reply.text, "planner:planner success");
});

test("lane execution plan reports structured semantic mismatch instead of generic fallback for misplaced document request", () => {
  const plan = resolveLaneExecutionPlan({
    scope: {
      capability_lane: "personal-assistant",
    },
    event: {
      message: {
        content: JSON.stringify({
          text: "請整理文件摘要",
        }),
      },
    },
  });

  assert.equal(plan.chosen_action, null);
  assert.equal(plan.fallback_reason, "semantic_mismatch_document_request_in_personal_lane");
});

test("lane execution plan keeps scoped cloud-doc exclusion requests out of personal fallback", () => {
  const plan = resolveLaneExecutionPlan({
    scope: {
      capability_lane: "personal-assistant",
    },
    event: {
      message: {
        content: JSON.stringify({
          text: "把非 scanoo 的文檔摘出去",
        }),
      },
    },
  });

  assert.equal(plan.chosen_action, null);
  assert.equal(plan.fallback_reason, "semantic_mismatch_document_request_in_personal_lane");
});

test("lane execution plan keeps the exact scanooo cloud-doc rereview query out of personal lane", () => {
  const plan = resolveLaneExecutionPlan({
    scope: {
      capability_lane: "personal-assistant",
    },
    event: {
      message: {
        content: JSON.stringify({
          text: "你把我的雲端文件再看一遍，把不屬於 scanooo 的內容摘出去讓我確認",
        }),
      },
    },
  });

  assert.equal(plan.chosen_action, null);
  assert.equal(plan.fallback_reason, "semantic_mismatch_document_request_in_personal_lane");
});

test("lane execution plan keeps doc-boundary keep requests out of personal lane", () => {
  const plan = resolveLaneExecutionPlan({
    scope: {
      capability_lane: "personal-assistant",
    },
    event: {
      message: {
        content: JSON.stringify({
          text: "把公司知識庫裡要保留的文件整理一下",
        }),
      },
    },
  });

  assert.equal(plan.chosen_action, null);
  assert.equal(plan.fallback_reason, "semantic_mismatch_document_request_in_personal_lane");
});

test("lane execution plan keeps runtime-info queries out of personal lane", () => {
  const plan = resolveLaneExecutionPlan({
    scope: {
      capability_lane: "personal-assistant",
    },
    event: {
      message: {
        content: JSON.stringify({
          text: "現在 runtime 穩不穩？順便告訴我 cwd 跟 db path",
        }),
      },
    },
  });

  assert.equal(plan.chosen_action, null);
  assert.equal(plan.fallback_reason, "semantic_mismatch_document_request_in_personal_lane");
});

test("lane execution plan treats meeting summary requests as summary work instead of calendar lookup", () => {
  const plan = resolveLaneExecutionPlan({
    scope: {
      capability_lane: "personal-assistant",
    },
    event: {
      message: {
        content: JSON.stringify({
          text: "幫我整理會議",
        }),
      },
    },
  });

  assert.equal(plan.chosen_action, "summarize_recent_dialogue");
  assert.equal(plan.fallback_reason, null);
});

test("lane execution plan gives personal assistant a general catch-all for greetings", () => {
  const plan = resolveLaneExecutionPlan({
    scope: {
      capability_lane: "personal-assistant",
    },
    event: {
      message: {
        content: JSON.stringify({
          text: "你好",
        }),
      },
    },
  });

  assert.equal(plan.chosen_action, "general_assistant_action");
  assert.equal(plan.fallback_reason, null);
});

test("lane execution plan keeps mixed workflow plus copy request in the general assistant lane", () => {
  const plan = resolveLaneExecutionPlan({
    scope: {
      capability_lane: "personal-assistant",
    },
    event: {
      message: {
        content: JSON.stringify({
          text: "我希望你可以建立工作流，比如幫我寫 facebook 的貼文、做好圖片並發送，請問你可以做到嗎？",
        }),
      },
    },
  });

  assert.equal(plan.chosen_action, "general_assistant_action");
  assert.equal(plan.fallback_reason, null);
});
