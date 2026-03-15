import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMeetingConfirmationCard,
  buildMeetingGroupMessage,
  classifyMeeting,
  createMeetingCoordinator,
  formatGeneralMeeting,
  formatWeeklyMeeting,
} from "../src/meeting-agent.mjs";

function createCoordinatorHarness() {
  const confirmations = new Map();
  const documents = new Map();
  const createdDocuments = [];
  const sentMessages = [];
  const mappings = new Map();
  const tracker = new Map();
  let confirmationSequence = 0;

  const coordinator = createMeetingCoordinator({
    sendMessage: async (_accessToken, chatId, content, options = {}) => {
      sentMessages.push({ chatId, content, options });
      return { message_id: `msg-${sentMessages.length}`, chat_id: chatId, text: content };
    },
    getMappedMeetingDocument: (accountId, projectKey, meetingType) =>
      mappings.get(`${accountId}:${projectKey}:${meetingType}`) || null,
    saveMeetingDocumentMapping: ({ accountId, projectKey, meetingType, documentId, title, chatId, projectName }) => {
      const value = {
        account_id: accountId,
        project_key: projectKey,
        project_name: projectName,
        meeting_type: meetingType,
        document_id: documentId,
        title,
        chat_id: chatId,
      };
      mappings.set(`${accountId}:${projectKey}:${meetingType}`, value);
      return value;
    },
    findSyncedMeetingDocument: () => null,
    createDocument: async (_accessToken, title) => {
      const documentId = `doc-${createdDocuments.length + 1}`;
      createdDocuments.push({ documentId, title });
      documents.set(documentId, "");
      return { document_id: documentId, title };
    },
    getDocument: async (_accessToken, documentId) => ({
      document_id: documentId,
      title: createdDocuments.find((item) => item.documentId === documentId)?.title || "existing",
      content: documents.get(documentId) || "",
      revision_id: "rev-1",
    }),
    updateDocument: async (_accessToken, documentId, content) => {
      documents.set(documentId, content);
      return { document_id: documentId, mode: "replace" };
    },
    createConfirmation: async (payload) => {
      confirmationSequence += 1;
      const confirmationId = `confirmation-${confirmationSequence}`;
      confirmations.set(confirmationId, {
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
      return {
        confirmation_id: confirmationId,
        confirmation_type: "meeting_write",
        expires_at: "2099-01-01T00:00:00.000Z",
      };
    },
    consumeConfirmation: async ({ confirmationId }) => {
      const payload = confirmations.get(confirmationId) || null;
      confirmations.delete(confirmationId);
      return payload;
    },
    listWeeklyTrackerItems: (accountId, projectKey) => {
      const items = tracker.get(`${accountId}:${projectKey}`) || [];
      return items.map((item) => ({ ...item }));
    },
    upsertWeeklyTrackerItem: (item) => {
      const key = `${item.account_id}:${item.project_key}`;
      const items = tracker.get(key) || [];
      const index = items.findIndex((existing) => existing.normalized_key === item.normalized_key);
      if (index >= 0) {
        items[index] = { ...items[index], ...item };
      } else {
        items.push({ ...item });
      }
      tracker.set(key, items);
    },
  });

  return {
    coordinator,
    documents,
    createdDocuments,
    sentMessages,
    confirmations,
    mappings,
    tracker,
  };
}

test("classifier recognizes clear weekly meetings", () => {
  const result = classifyMeeting({
    text: `
      本週 KR 進展：完成 onboarding 轉化優化
      卡點：付款頁轉化下降
      解法：本週改版 checkout
      本週 Todo：Owner: Sean 跟進 KR2 實驗
    `,
  });

  assert.equal(result.meeting_type, "weekly");
  assert.ok(result.confidence >= 0.62);
});

test("classifier recognizes general meetings", () => {
  const result = classifyMeeting({
    text: `
      客戶同步會
      主要討論新報價與交付時程
      結論：下週提供修正版 proposal
    `,
  });

  assert.equal(result.meeting_type, "general");
});

test("classifier defaults ambiguous cases to general", () => {
  const result = classifyMeeting({
    text: "今天先對齊一下需求，後續再看。",
  });

  assert.equal(result.meeting_type, "general");
});

test("weekly formatter only emits four required sections and marks missing owner", () => {
  const text = formatWeeklyMeeting({
    progress: ["完成 KR1 首版"],
    issues: ["數據回填延遲"],
    solutions: ["先補 ETL 重跑"],
    todos: [{ owner: "", title: "確認追數口徑" }],
  });

  assert.match(text, /【本週會議核心】/);
  assert.match(text, /核心進展：/);
  assert.match(text, /關鍵問題：/);
  assert.match(text, /解法：/);
  assert.match(text, /本週 Todo：/);
  assert.doesNotMatch(text, /時間：/);
  assert.match(text, /\[待確認\] 確認追數口徑/);
});

test("general formatter only emits five required sections without weekly fields", () => {
  const text = formatGeneralMeeting({
    time: "20260315",
    participants: ["Sean", "Amy"],
    main_points: ["討論專案節奏"],
    conclusions: ["先做 API 版"], 
    todos: [{ owner: "Sean", title: "整理 PRD" }],
  });

  assert.match(text, /【會議紀要】/);
  assert.match(text, /時間：20260315/);
  assert.match(text, /參與人員：Sean、Amy/);
  assert.match(text, /主要內容：/);
  assert.match(text, /關鍵結論：/);
  assert.match(text, /TODO：/);
  assert.doesNotMatch(text, /核心進展：|關鍵問題：|解法：|本週 Todo：/);
});

test("group message builder hides internal classifier fields", () => {
  const message = buildMeetingGroupMessage({
    meeting_type: "general",
    summary: {
      time: "20260315",
      participants: ["Sean"],
      main_points: ["同步進度"],
      conclusions: ["確認下週排期"],
      todos: [],
      confidence: 0.12,
      reason: "internal only",
    },
  });

  assert.doesNotMatch(message, /confidence|reason|internal only/);
  assert.match(message, /【會議紀要】/);
});

test("meeting confirmation card exposes confirm button without internal classifier fields", () => {
  const card = buildMeetingConfirmationCard({
    meetingType: "general",
    summaryContent: "【會議紀要】\n時間：20260315",
    confirmationId: "confirmation-1",
    accountId: "acct-1",
    projectName: "Alpha",
  });

  assert.equal(card.elements.at(-1).tag, "action");
  assert.match(card.elements.at(-1).actions[0].url, /confirmation_id=confirmation-1/);
  assert.doesNotMatch(JSON.stringify(card), /confidence|reason/);
});

test("meeting confirmation flow does not write document before confirm", async () => {
  const harness = createCoordinatorHarness();

  const preview = await harness.coordinator.processMeetingPreview({
    accountId: "acct-1",
    accessToken: "token",
    transcriptText: `
      客戶會議
      參與人員：Sean、Amy
      結論：下週提交新版排程
      TODO：Amy 更新 proposal
    `,
    chatId: "chat-1",
    metadata: { date: "20260315" },
  });

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0].options.cardPayload.elements.at(-1).tag, "action");
  assert.equal(harness.createdDocuments.length, 0);
  assert.equal(harness.documents.size, 0);
  assert.equal(preview.workflow_state, "pending_confirmation");
});

test("meeting confirmation writes to existing document with newest content on top", async () => {
  const harness = createCoordinatorHarness();
  harness.mappings.set("acct-1:alpha:general", {
    account_id: "acct-1",
    project_key: "alpha",
    meeting_type: "general",
    document_id: "doc-existing",
    title: "Alpha_meeting_notes",
  });
  harness.documents.set("doc-existing", "[20260301]\n\n舊內容");

  const preview = await harness.coordinator.processMeetingPreview({
    accountId: "acct-1",
    accessToken: "token",
    transcriptText: `
      Project: Alpha
      參與人員：Sean、Amy
      主要內容：同步新功能
      結論：確認先走 beta
      TODO：Sean 補 API 文件
    `,
    chatId: "chat-1",
    metadata: { date: "20260315" },
  });

  const applied = await harness.coordinator.confirmMeetingWrite({
    accountId: "acct-1",
    accessToken: "token",
    confirmationId: preview.confirmation.confirmation_id,
  });

  assert.equal(applied.target_document.document_id, "doc-existing");
  assert.equal(harness.createdDocuments.length, 0);
  const content = harness.documents.get("doc-existing");
  assert.match(content, /^\[20260315\]/);
  assert.match(content, /\[20260301\]\n\n舊內容$/);
});

test("meeting confirmation creates new general document when no existing document exists", async () => {
  const harness = createCoordinatorHarness();

  const preview = await harness.coordinator.processMeetingPreview({
    accountId: "acct-1",
    accessToken: "token",
    transcriptText: `
      客戶會議
      參與人員：Sean
      主要內容：確認交付範圍
      關鍵結論：四月啟動
    `,
    chatId: "chat-9",
    metadata: { date: "20260315" },
  });

  await harness.coordinator.confirmMeetingWrite({
    accountId: "acct-1",
    accessToken: "token",
    confirmationId: preview.confirmation.confirmation_id,
  });

  assert.equal(harness.createdDocuments.length, 1);
  assert.ok(harness.documents.get("doc-1").startsWith("[20260315]"));
});

test("prependMeetingEntry deduplicates repeated meeting content", async () => {
  const harness = createCoordinatorHarness();
  harness.documents.set("doc-existing", "[20260315]\n\n參與人員：\n- Sean");

  const result = await harness.coordinator.prependMeetingEntry({
    accessToken: "token",
    documentId: "doc-existing",
    content: "[20260315]\n\n參與人員：\n- Sean",
  });

  assert.equal(result.deduplicated, true);
  assert.equal(harness.documents.get("doc-existing"), "[20260315]\n\n參與人員：\n- Sean");
});

test("weekly todo tracker marks new, carry_over, done, and pending_confirm", async () => {
  const harness = createCoordinatorHarness();
  harness.tracker.set("acct-1:weekly-alpha", [
    {
      account_id: "acct-1",
      project_key: "weekly-alpha",
      normalized_key: "追蹤kr2|kr2",
      title: "追蹤KR2",
      owner: "Sean",
      objective: "",
      kr: "KR2",
      status: "new",
    },
  ]);

  const updates = await harness.coordinator.updateWeeklyTodoTracker(
    {
      todos: [
        { title: "追蹤KR2", owner: "Sean", objective: "", kr: "KR2" },
        { title: "補齊口徑", owner: "", objective: "", kr: "" },
        { title: "關閉舊議題", owner: "Amy", objective: "", kr: "" },
      ],
    },
    {
      accountId: "acct-1",
      projectKey: "weekly-alpha",
      sourceDate: "20260315",
      sourceMeetingId: "meeting-1",
      transcriptText: "已完成 關閉舊議題，另外 TODO 追蹤KR2 與補齊口徑",
    },
  );

  const byTitle = Object.fromEntries(updates.map((item) => [item.title, item.status]));
  assert.equal(byTitle["追蹤KR2"], "carry_over");
  assert.equal(byTitle["補齊口徑"], "pending_confirm");
  assert.equal(byTitle["關閉舊議題"], "done");
});
