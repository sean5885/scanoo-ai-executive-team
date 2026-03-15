import { answerQuestion } from "./answer-service.mjs";
import { generateDocumentCommentSuggestionCard } from "./comment-suggestion-workflow.mjs";
import { getPrimaryCalendar, getDocument, getMessage, listCalendarEvents, listMessages, listTasks } from "./lark-content.mjs";
import {
  buildMessageText,
  cleanText,
  collectRelatedMessageIds,
  extractDocumentId,
  normalizeMessageText,
} from "./message-intent-utils.mjs";
import { getStoredAccountContext, getStoredAccountContextByOpenId, getValidUserToken } from "./lark-user-auth.mjs";
import { buildLaneIntroReply } from "./capability-lane.mjs";
import { formatIdentifierHint } from "./runtime-observability.mjs";
import { createMeetingCoordinator, parseMeetingCommand } from "./meeting-agent.mjs";

function incomingText(event) {
  return buildMessageText(event);
}

function truncate(value, limit = 90) {
  const text = cleanText(value).replace(/\s+/g, " ");
  if (!text) {
    return "(空)";
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function hasAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  compactError(error) {
    if (!error) {
      return null;
    }
    if (error instanceof Error) {
      return { name: error.name || "Error", message: error.message || "unknown_error" };
    }
    return { message: typeof error === "string" ? error : String(error) };
  },
};

const meetingCoordinator = createMeetingCoordinator();

async function resolveReferencedDocumentId(event, accessToken, logger = noopLogger) {
  const directDocumentId = extractDocumentId(event);
  if (directDocumentId) {
    logger.info("doc_resolution_hit", {
      source: "current_message",
      document_id: formatIdentifierHint(directDocumentId),
    });
    return {
      documentId: directDocumentId,
      source: "current_message",
    };
  }

  for (const relatedMessageId of collectRelatedMessageIds(event)) {
    try {
      const related = await getMessage(accessToken, relatedMessageId);
      const relatedDocumentId = extractDocumentId({ message: related });
      if (relatedDocumentId) {
        logger.info("doc_resolution_hit", {
          source: "referenced_message",
          document_id: formatIdentifierHint(relatedDocumentId),
          referenced_message_id: formatIdentifierHint(relatedMessageId),
        });
        return {
          documentId: relatedDocumentId,
          source: "referenced_message",
          referencedMessageId: relatedMessageId,
        };
      }
    } catch {
      logger.warn("doc_resolution_related_message_failed", {
        referenced_message_id: formatIdentifierHint(relatedMessageId),
      });
      // Ignore one failed related-message lookup and continue.
    }
  }

  logger.warn("doc_resolution_miss", {
    related_message_count: collectRelatedMessageIds(event).length,
  });
  return {
    documentId: "",
    source: "none",
  };
}

function startOfDayUnix() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.floor(now.getTime() / 1000);
}

function endOfDayUnix() {
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  return Math.floor(now.getTime() / 1000);
}

async function resolveAuthContext(event, logger = noopLogger) {
  const senderOpenId = cleanText(event?.sender?.sender_id?.open_id);
  const scoped = senderOpenId ? await getStoredAccountContextByOpenId(senderOpenId) : null;
  const fallback = scoped || (await getStoredAccountContext());
  if (!fallback?.account?.id) {
    logger.warn("missing_auth_context", {
      sender_open_id: formatIdentifierHint(senderOpenId),
    });
    return null;
  }
  const token = await getValidUserToken(fallback.account.id);
  if (!token?.access_token) {
    logger.warn("missing_valid_user_token", {
      account_id: formatIdentifierHint(fallback.account.id),
    });
    return null;
  }
  return {
    account: fallback.account,
    token,
  };
}

async function executeKnowledgeAssistant({ event, scope, logger = noopLogger }) {
  const context = await resolveAuthContext(event, logger);
  if (!context) {
    return { text: buildLaneIntroReply(scope, scope) };
  }

  const text = incomingText(event);
  if (!text) {
    return { text: buildLaneIntroReply(scope, scope) };
  }

  const result = await answerQuestion(context.account.id, text, undefined, {
    workflowStateKey: `knowledge-lane:${scope.session_key || scope.chat_id || context.account.id}`,
  });
  const sources = (result.sources || []).slice(0, 3).map((item) => `- ${item.title}`).join("\n") || "- 目前沒有額外來源";
  return {
    text: [
      "結論",
      result.answer || "目前找不到對應知識。",
      "",
      "重點",
      sources,
      "",
      "下一步",
      "- 如果要，我可以再把這題展開成更完整的整理版本。",
    ].join("\n"),
  };
}

function formatUnixDate(value) {
  const numeric = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "待確認";
  }

  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) {
    return "待確認";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

async function executeMeetingCommand({ event, scope, logger = noopLogger }) {
  const command = parseMeetingCommand(normalizeMessageText(event));
  if (!command) {
    return null;
  }

  const context = await resolveAuthContext(event, logger);
  if (!context) {
    return { text: buildLaneIntroReply(scope, scope) };
  }

  if (command.action === "confirm") {
    const result = await meetingCoordinator.confirmMeetingWrite({
      accountId: context.account.id,
      accessToken: context.token.access_token,
      confirmationId: command.confirmation_id,
    });
    if (!result) {
      return {
        text: [
          "結論",
          "這個 meeting confirmation 不存在、已過期，或不屬於你目前的授權帳號。",
          "",
          "下一步",
          "- 請重新執行一次 /meeting 生成新的摘要預覽。",
        ].join("\n"),
      };
    }

    return {
      text: [
        "結論",
        "我已完成確認並寫入對應文檔。",
        "",
        "重點",
        `- 會議類型：${result.meeting_type === "weekly" ? "weekly" : "general"}`,
        `- 目標文檔：${result.target_document.title || result.target_document.document_id}`,
        result.write_result?.deduplicated ? "- 這次內容與現有紀要重複，已略過重複插入。" : "- 新紀要已插入文檔最上方。",
        result.meeting_type === "weekly"
          ? `- 週會 Todo tracker 已更新 ${result.tracker_updates.length} 筆。`
          : "- 本次不更新週會 Todo tracker。",
      ].join("\n"),
    };
  }

  const documentRef = await resolveReferencedDocumentId(event, context.token.access_token, logger);
  let transcriptText = command.content;
  let referencedDocument = null;
  if (documentRef.documentId) {
    referencedDocument = await getDocument(context.token.access_token, documentRef.documentId);
    transcriptText = referencedDocument.content || transcriptText;
  }

  if (!cleanText(transcriptText)) {
    return {
      text: [
        "結論",
        "我已切到 /meeting，但這次沒有拿到可整理的會議內容。",
        "",
        "下一步",
        "- 直接把逐字稿貼在 /meeting 後面，或回覆一份會議文件後再輸入 /meeting。",
      ].join("\n"),
    };
  }

  const result = await meetingCoordinator.processMeetingPreview({
    accountId: context.account.id,
    accessToken: context.token.access_token,
    transcriptText,
    metadata: {
      date: formatUnixDate(event?.message?.create_time),
      source: referencedDocument?.title || null,
    },
    chatId: cleanText(event?.message?.chat_id),
    sourceMeetingId: cleanText(event?.message?.message_id),
  });

  return {
    text: [
      "結論",
      "我已先把會議摘要發到指定群組，現在停在待確認，不會先寫文檔。",
      "",
      "重點",
      `- 會議類型：${result.meeting_type === "weekly" ? "weekly" : "general"}`,
      `- 專案鍵：${result.project_name}`,
      `- 目標群組：${result.target_group_chat_id}`,
      `- 文檔目標：${result.target_document.title}${result.target_document.existed ? "（已找到既有文檔）" : "（確認後會自動建立）"}`,
      "",
      "下一步",
      `- 若確認寫入文檔，請回覆：/meeting confirm ${result.confirmation.confirmation_id}`,
    ].join("\n"),
  };
}

async function executeDocEditor({ event, scope, logger = noopLogger }) {
  const context = await resolveAuthContext(event, logger);
  if (!context) {
    return { text: buildLaneIntroReply(scope, scope) };
  }

  const text = incomingText(event);
  const documentRef = await resolveReferencedDocumentId(event, context.token.access_token, logger);
  const documentId = documentRef.documentId;
  if (!documentId) {
    logger.warn("doc_editor_missing_document_id", {
      related_message_count: collectRelatedMessageIds(event).length,
    });
    return {
      text: [
        "結論",
        "我已切到文檔編輯模式，但這次訊息裡沒有解析到可讀取的文件 token。",
        "",
        "重點",
        "- 你這次很可能是傳了文件卡片或回覆了一則文件分享訊息。",
        "- 目前我會先讀當前訊息，再補讀你回覆的上游訊息；如果兩邊都沒有 token，就無法直接打開正文。",
        "",
        "下一步",
        "- 直接貼 doc 連結或 document_id，我就能直接打開。",
      ].join("\n"),
    };
  }

  if (hasAny(normalizeMessageText({ text }), ["評論", "评论", "改稿", "rewrite", "修改"])) {
    const result = await generateDocumentCommentSuggestionCard({
      accessToken: context.token.access_token,
      accountId: context.account.id,
      documentId,
      messageId: "",
      replyInThread: true,
      resolveComments: false,
      markSeen: false,
    });
    if (!result.has_new_comments) {
      return {
        text: [
          "結論",
          "目前這份文件沒有新的未處理評論需要生成改稿建議。",
          "",
          "重點",
          "- 如果你要，我還是可以直接讀正文後幫你提出優化建議。",
          "",
          "下一步",
          "- 你也可以直接叫我讀這份文件並整理修改方向。",
        ].join("\n"),
      };
    }
    return {
      cardTitle: result.rewrite_preview_card?.title || "評論改稿建議",
      text: result.rewrite_preview_card?.content || "我已生成評論改稿建議。",
      replyMode: "card",
      accessToken: context.token.access_token,
    };
  }

  const document = await getDocument(context.token.access_token, documentId);
  return {
    text: [
      "結論",
      `我已讀到「${document.title || document.document_id}」。`,
      "",
      "重點",
      documentRef.source === "referenced_message"
        ? `- 這份文件是從你回覆的上一則訊息裡解析出來的。`
        : "- 這份文件是直接從你這次訊息裡解析出來的。",
      `- 文檔摘要：${truncate(document.content, 180)}`,
      "",
      "下一步",
      "- 如果你要，我可以接著抓評論、整理修改建議，或直接生成改稿預覽。",
    ].join("\n"),
  };
}

async function executePersonalAssistant({ event, scope, logger = noopLogger }) {
  const context = await resolveAuthContext(event, logger);
  if (!context) {
    return { text: buildLaneIntroReply(scope, scope) };
  }

  const text = normalizeMessageText(event);
  if (hasAny(text, ["日程", "行程", "calendar", "會議", "会议"])) {
    const calendar = await getPrimaryCalendar(context.token.access_token);
    const events = await listCalendarEvents(context.token.access_token, calendar.calendar_id, {
      startTime: startOfDayUnix().toString(),
      endTime: endOfDayUnix().toString(),
    });
    const items = (events.items || []).slice(0, 5).map((item) => `- ${item.summary || "(未命名日程)"}`).join("\n") || "- 今天還沒有抓到日程";
    return {
      text: ["結論", "我先幫你看今天的日程。", "", "重點", items, "", "下一步", "- 如果你要，我可以再幫你整理成可直接轉發的行程摘要。"].join("\n"),
    };
  }

  if (hasAny(text, ["任務", "task", "待辦", "todo"])) {
    const tasks = await listTasks(context.token.access_token, {});
    const items = (tasks.items || []).slice(0, 5).map((item) => `- ${item.summary || "(未命名任務)"}`).join("\n") || "- 目前沒有抓到任務";
    return {
      text: ["結論", "我先幫你看目前任務。", "", "重點", items, "", "下一步", "- 如果你要，我可以再幫你挑出最該先做的 3 件事。"].join("\n"),
    };
  }

  return {
    text: [
      "結論",
      "我會先用你的私聊上下文處理這件事。",
      "",
      "重點",
      "- 這條 lane 比較適合：個人任務、日程、訊息整理、私人工作流。",
      "",
      "下一步",
      "- 你可以直接叫我看今天日程、整理待辦，或幫你總結最近對話。",
    ].join("\n"),
  };
}

async function executeGroupSharedAssistant({ event, scope, logger = noopLogger }) {
  const context = await resolveAuthContext(event, logger);
  if (!context) {
    return { text: buildLaneIntroReply(scope, scope) };
  }

  const text = normalizeMessageText(event);
  const chatId = cleanText(event?.message?.chat_id);
  if (chatId && hasAny(text, ["總結", "总结", "整理", "回覆", "回复", "怎麼回", "怎么回"])) {
    const messages = await listMessages(context.token.access_token, chatId, {
      containerIdType: "chat",
      pageSize: 8,
    });
    const items = (messages.items || [])
      .slice(0, 5)
      .map((item) => `- ${truncate(item.text || item.content, 96)}`)
      .join("\n") || "- 目前沒有抓到足夠的群聊內容";
    return {
      text: [
        "結論",
        "我先用群組共享模式整理這段對話。",
        "",
        "重點",
        items,
        "",
        "下一步",
        "- 如果你要，我可以直接幫你起一版群裡可發出的回覆。",
      ].join("\n"),
    };
  }

  return {
    text: [
      "結論",
      "我會先用群組共享上下文處理這件事。",
      "",
      "重點",
      "- 這條 lane 比較適合：群聊摘要、群內回覆建議、共享知識協作。",
      "",
      "下一步",
      "- 你可以直接叫我整理這段群聊，或幫你起草回覆。",
    ].join("\n"),
  };
}

export async function executeCapabilityLane({ event, scope, logger = noopLogger }) {
  const meetingReply = await executeMeetingCommand({ event, scope, logger });
  if (meetingReply) {
    return meetingReply;
  }

  const lane = scope?.capability_lane || "personal-assistant";
  if (lane === "knowledge-assistant") {
    return executeKnowledgeAssistant({ event, scope, logger });
  }
  if (lane === "doc-editor") {
    return executeDocEditor({ event, scope, logger });
  }
  if (lane === "group-shared-assistant") {
    return executeGroupSharedAssistant({ event, scope, logger });
  }
  return executePersonalAssistant({ event, scope, logger });
}
