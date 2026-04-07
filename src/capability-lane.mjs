import {
  collectRelatedMessageIds,
  detectDocBoundaryIntent,
  extractDocumentId,
  normalizeMessageText,
} from "./message-intent-utils.mjs";
import { resolvePlannerKnowledgeAssistantIngress } from "./planner-ingress-contract.mjs";

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

const conversationSummaryKeywords = [
  "最近對話",
  "最近对话",
  "最近聊天",
  "最近訊息",
  "最近消息",
  "總結最近",
  "总结最近",
  "總結對話",
  "总结对话",
  "整理對話",
  "整理对话",
  "整理聊天",
];

export function resolveCapabilityLane(scope, input = {}) {
  const text = normalizeMessageText(input);
  const docBoundaryIntent = detectDocBoundaryIntent(text);
  const hasDirectDocumentReference = Boolean(extractDocumentId(input));
  const hasReplyChain = collectRelatedMessageIds(input).length > 0;

  const docEditActionKeywords = [
    "評論",
    "评论",
    "改稿",
    "改文",
    "修改",
    "rewrite",
    "段落",
    "潤色",
    "润色",
    "覆寫",
    "覆盖",
    "append",
    "apply",
  ];

  const docFollowUpKeywords = [
    "看",
    "看看",
    "幫我看",
    "帮我看",
    "打開",
    "打开",
    "讀",
    "读",
    "摘要",
    "總結",
    "总结",
    "整理",
    "review",
  ];

  const docReferenceKeywords = [
    "文件",
    "文檔",
    "文档",
    "docx",
    "doccn",
    "comment",
    "評論區",
    "评论区",
  ];

  const wantsDocEdit =
    hasDirectDocumentReference ||
    hasAny(text, ["評論", "评论", "評論區", "评论区"]) ||
    (hasAny(text, docEditActionKeywords) && hasAny(text, docReferenceKeywords)) ||
    (hasReplyChain && hasAny(text, docFollowUpKeywords));

  const wantsConversationSummary = hasAny(text, conversationSummaryKeywords);
  const wantsDocumentSummary = docBoundaryIntent.wants_document_summary;
  const plannerKnowledgeIngress = resolvePlannerKnowledgeAssistantIngress(text);

  if (wantsDocEdit) {
    return {
      capability_lane: "doc-editor",
      lane_label: "文檔編輯助手",
      lane_reason: "message_mentions_doc_editing_or_comment_rewrite",
      recommended_tools: [
        "lark_doc_read",
        "lark_doc_comments",
        "lark_doc_comment_suggestion_card",
        "lark_doc_rewrite_from_comments",
        "lark_doc_update",
      ],
    };
  }

  if (wantsConversationSummary && !wantsDocumentSummary && scope?.chat_type === "group") {
    return {
      capability_lane: "group-shared-assistant",
      lane_label: "群組共享助手",
      lane_reason: "group_conversation_summary_request",
      recommended_tools: [
        "lark_message_reply_card",
        "lark_messages_list",
        "lark_calendar_primary",
      ],
    };
  }

  if (plannerKnowledgeIngress) {
    return {
      capability_lane: plannerKnowledgeIngress.capability_lane,
      lane_label: plannerKnowledgeIngress.lane_label,
      lane_reason: plannerKnowledgeIngress.lane_reason,
      recommended_tools: [
        "lark_kb_search",
        "lark_kb_answer",
        "lark_doc_read",
        "lark_drive_list",
        "lark_wiki_spaces",
        "lark_wiki_nodes",
      ],
    };
  }

  if (scope?.chat_type === "group") {
    return {
      capability_lane: "group-shared-assistant",
      lane_label: "群組共享助手",
      lane_reason: "group_chat_default_lane",
      recommended_tools: [
        "lark_message_reply_card",
        "lark_messages_list",
        "lark_calendar_primary",
      ],
    };
  }

  return {
    capability_lane: "personal-assistant",
    lane_label: "個人助手",
    lane_reason: "direct_message_default_lane",
    recommended_tools: [
      "lark_messages_list",
      "lark_calendar_primary",
      "lark_tasks_list",
      "lark_message_reply_card",
    ],
  };
}

export function buildLaneIntroReply(scope, lane) {
  const laneLabel = lane?.lane_label || "助手";
  const nextStep =
    lane?.capability_lane === "doc-editor"
      ? "我會先看正文、評論和待改位置，再給你改稿建議。"
      : lane?.capability_lane === "scanoo-compare"
        ? "我會先用 Scanoo 比較路徑整理差異、觀察點與可行建議。"
      : lane?.capability_lane === "scanoo-diagnose"
        ? "我會先用 Scanoo 診斷路徑整理問題、原因與可行建議。"
      : lane?.capability_lane === "knowledge-assistant"
        ? "我會先查公司文件與知識資料，再整理成可讀結論。"
        : lane?.capability_lane === "group-shared-assistant"
          ? "我會先用群組共享上下文處理，避免和其他私聊記憶混在一起。"
          : "我會先用你的私聊上下文處理，再決定要不要查文件或安排任務。";

  return [
    `結論：我先用「${laneLabel}」模式處理。`,
    `重點：這次會使用 ${scope?.session_key || "當前 session"}，共享知識仍走 ${scope?.workspace_key || "共享 workspace"}。`,
    `下一步：${nextStep}`,
  ].join("\n");
}

export function buildLaneFailureReply(scope, lane) {
  const laneLabel = lane?.lane_label || "助手";
  const capabilityLane = lane?.capability_lane || scope?.capability_lane || "personal-assistant";

  let detail = "我剛剛在處理這則訊息時遇到錯誤。";
  let nextStep = "請直接再問一次；如果還是不行，我可以根據你貼的原文繼續查。";

  if (capabilityLane === "doc-editor") {
    detail = "我剛剛在讀文件、回覆鏈，或評論內容時遇到錯誤。";
    nextStep = "請直接再貼一次文件卡片、文件連結或 document_id，我會重新讀取。";
  } else if (capabilityLane === "scanoo-compare") {
    detail = "我剛剛在走 Scanoo 比較路徑並整理差異分析結果時遇到錯誤。";
    nextStep = "你可以直接重問一次，或補更明確的比較對象、期間與維度讓我縮小範圍。";
  } else if (capabilityLane === "scanoo-diagnose") {
    detail = "我剛剛在走 Scanoo 診斷路徑並整理分析結果時遇到錯誤。";
    nextStep = "你可以直接重問一次，或補更明確的診斷目標、症狀與範圍讓我縮小問題。";
  } else if (capabilityLane === "knowledge-assistant") {
    detail = "我剛剛在查知識與整理答案時遇到錯誤。";
    nextStep = "你可以直接重問一次，或補一個更明確的關鍵字讓我縮小範圍。";
  } else if (capabilityLane === "group-shared-assistant") {
    detail = "我剛剛在處理群組共享上下文時遇到錯誤。";
    nextStep = "你可以直接指定要我總結哪段討論，或再發一次問題。";
  }

  return [
    `結論：${laneLabel} 這次處理失敗了。`,
    `重點：${detail}`,
    `下一步：${nextStep}`,
  ].join("\n");
}
