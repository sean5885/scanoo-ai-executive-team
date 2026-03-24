import test from "node:test";
import assert from "node:assert/strict";

import { createMeetingCoordinator } from "../src/meeting-agent.mjs";
import { executeRegisteredAgent } from "../src/agent-dispatcher.mjs";
import { getRegisteredAgent } from "../src/agent-registry.mjs";
import { closeDbForTests } from "../src/db.mjs";
import { disposeLarkContentClientForTests } from "../src/lark-content.mjs";
import { setupExecutiveTaskStateTestHarness } from "./helpers/executive-task-state-harness.mjs";

setupExecutiveTaskStateTestHarness();
test.after(() => {
  disposeLarkContentClientForTests();
  closeDbForTests();
});

function createMeetingHarness() {
  const confirmations = new Map();
  const sentMessages = [];
  const documents = new Map();

  async function buildSummary({ text, metadata = {}, classification }) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const valueOf = (prefixes = []) => {
      const prefixPattern = prefixes.join("|");
      const line = lines.find((item) => new RegExp(`^(?:${prefixPattern})\\s*[:：]`, "i").test(item));
      return line ? line.replace(new RegExp(`^(?:${prefixPattern})\\s*[:：]\\s*`, "i"), "").trim() : "";
    };
    const participants = (valueOf(["參與人員", "参与人员"]) || "待確認")
      .split(/[、,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
    const todoText = valueOf(["TODO", "Todo", "todo", "待辦", "待办"]);

    if (classification.meeting_type === "weekly") {
      return {
        meeting_type: "weekly",
        time: metadata.date || "待確認",
        participants: participants.length ? participants : ["待確認"],
        progress: [valueOf(["核心進展", "進展"]) || "待確認"],
        issues: [valueOf(["關鍵問題", "卡點", "問題"]) || "待確認"],
        solutions: [valueOf(["解法", "方案"]) || "待確認"],
        todos: todoText
          ? [{ owner: todoText.split(/\s+/)[0] || "待確認", title: todoText.split(/\s+/).slice(1).join(" ").trim() || todoText }]
          : [],
      };
    }

    return {
      meeting_type: "general",
      time: metadata.date || "待確認",
      participants: participants.length ? participants : ["待確認"],
      main_points: [valueOf(["主要內容"]) || "待確認"],
      conclusions: [valueOf(["關鍵結論", "結論"]) || "待確認"],
      todos: todoText
        ? [{ owner: todoText.split(/\s+/)[0] || "待確認", title: todoText.split(/\s+/).slice(1).join(" ").trim() || todoText }]
        : [],
    };
  }

  return {
    sentMessages,
    documents,
    coordinator: createMeetingCoordinator({
      sendMessage: async (_accessToken, chatId, content, options = {}) => {
        sentMessages.push({ chatId, content, options });
        return { message_id: `msg-${sentMessages.length}`, chat_id: chatId, text: content };
      },
      getMappedMeetingDocument: () => null,
      saveMeetingDocumentMapping: () => null,
      findSyncedMeetingDocument: () => null,
      createDocument: async (_accessToken, title) => {
        documents.set("doc-1", "");
        return { document_id: "doc-1", title };
      },
      getDocument: async () => ({
        document_id: "doc-1",
        title: "meeting-doc",
        content: documents.get("doc-1") || "",
        revision_id: "rev-1",
      }),
      updateDocument: async (_accessToken, documentId, content) => {
        documents.set(documentId, content);
        return { document_id: documentId, mode: "replace" };
      },
      buildMeetingSummary: buildSummary,
      createConfirmation: async (payload) => {
        confirmations.set("confirm-1", {
          account_id: payload.accountId,
          project_key: payload.projectKey,
          project_name: payload.projectName,
          meeting_type: payload.meetingType,
          chat_id: payload.chatId,
          summary_content: payload.summaryContent,
          doc_entry_content: payload.docEntryContent,
          target_document_id: payload.targetDocumentId,
          target_document_title: payload.targetDocumentTitle,
          source_meeting_id: payload.sourceMeetingId,
          source_date: payload.sourceDate,
          weekly_todos: payload.weeklyTodos || [],
        });
        return { confirmation_id: "confirm-1" };
      },
      consumeConfirmation: async () => confirmations.get("confirm-1"),
      listWeeklyTrackerItems: () => [],
      upsertWeeklyTrackerItem: () => null,
    }),
  };
}

test("meeting integration chain can preview, send group card, confirm, and write doc", async () => {
  const harness = createMeetingHarness();

  const preview = await harness.coordinator.processMeetingPreview({
    accountId: "acct-1",
    accessToken: "token",
    transcriptText: `
      客戶會議
      參與人員：Sean、Amy
      主要內容：確認交付範圍
      關鍵結論：四月啟動
      TODO：Sean 整理 PRD
    `,
    chatId: "chat-1",
    metadata: { date: "20260317" },
  });

  assert.equal(preview.workflow_state, "awaiting_confirmation");
  assert.notEqual(preview.workflow_state, "writing_back");
  assert.equal(harness.sentMessages.length, 1);

  const confirmed = await harness.coordinator.confirmMeetingWrite({
    accountId: "acct-1",
    accessToken: "token",
    confirmationId: preview.confirmation.confirmation_id,
  });

  assert.equal(confirmed.workflow_state, "writing_back");
  assert.notEqual(confirmed.workflow_state, "completed");
  assert.match(harness.documents.get("doc-1"), /四月啟動/);
});

test("knowledge agent integration chain can retrieve and produce structured result", async () => {
  const result = await executeRegisteredAgent({
    accountId: "acct-1",
    agent: getRegisteredAgent("knowledge-conflicts"),
    requestText: "找出 Scanoo 文件衝突",
    scope: { session_key: "knowledge-chain" },
    searchFn() {
      return {
        items: [
          {
            title: "Scanoo KPI 定義 A",
            url: "https://example.com/a",
            content: "KPI 偏營運指標。",
          },
          {
            title: "Scanoo KPI 定義 B",
            url: "https://example.com/b",
            content: "KPI 偏市場 presence 指標。",
          },
        ],
      };
    },
    async textGenerator() {
      return "衝突摘要\n同一 KPI 在兩份文件中定義不同。";
    },
  });

  assert.equal(result.agentId, "knowledge-conflicts");
  assert.match(result.text, /衝突摘要/);
});
