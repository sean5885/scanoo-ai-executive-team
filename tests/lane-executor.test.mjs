import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
const testDb = await createTestDbHarness();
const {
  assertRoutingDecisionFinalOwner,
  assertRoutingDecisionOwner,
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
  resolveLaneExecutionPlan,
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
