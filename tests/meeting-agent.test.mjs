import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMeetingConfirmationCard,
  buildMeetingGroupMessage,
  buildMeetingStructuredResult,
  classifyMeeting,
  createMeetingCoordinator,
  formatGeneralMeeting,
  formatWeeklyMeeting,
  parseMeetingCommand,
} from "../src/meeting-agent.mjs";
import { closeDbForTests } from "../src/db.mjs";
import { disposeLarkContentClientForTests } from "../src/lark-content.mjs";
import { setupExecutiveTaskStateTestHarness } from "./helpers/executive-task-state-harness.mjs";

setupExecutiveTaskStateTestHarness();
test.after(() => {
  disposeLarkContentClientForTests();
  closeDbForTests();
});

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
    peekConfirmation: async ({ confirmationId }) => {
      const payload = confirmations.get(confirmationId) || null;
      return payload ? { ...payload } : null;
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

test("plain 會議 text can wake meeting workflow from menu button", () => {
  const parsed = parseMeetingCommand("會議");

  assert.equal(parsed.action, "start_capture");
  assert.equal(parsed.content, "");
  assert.equal(parsed.wake_source, "menu_button");
});

test("natural-language meeting workflow intent wakes the meeting flow", () => {
  const parsed = parseMeetingCommand("你會一起參會，並做記錄然後給我確認，我同意後，你來寫進第二部分");

  assert.equal(parsed.action, "start_capture");
  assert.equal(parsed.content, "");
  assert.equal(parsed.wake_source, "natural_language_intent");
});

test("generic calendar mention does not wake the meeting flow", () => {
  const parsed = parseMeetingCommand("今天下午 5 點有會議，先幫我提醒一下");

  assert.equal(parsed, null);
});

test("meeting start phrase enters capture mode", () => {
  const parsed = parseMeetingCommand("我要開會了");

  assert.equal(parsed.action, "start_capture");
  assert.equal(parsed.wake_source, "natural_language_start");
});

test("short record request enters capture mode", () => {
  const parsed = parseMeetingCommand("請記錄吧");

  assert.equal(parsed.action, "start_capture");
  assert.equal(parsed.wake_source, "natural_language_start");
});

test("offline meeting note request enters capture mode", () => {
  const parsed = parseMeetingCommand("線下會議 請記錄");

  assert.equal(parsed.action, "start_capture");
  assert.equal(parsed.wake_source, "natural_language_start");
});

test("okr weekly meeting short context enters capture mode", () => {
  const parsed = parseMeetingCommand("okr 周例會");

  assert.equal(parsed.action, "start_capture");
  assert.equal(parsed.wake_source, "natural_language_start");
});

test("prepare to start meeting record enters capture mode", () => {
  const parsed = parseMeetingCommand("現在正要開始 請準備記錄吧");

  assert.equal(parsed.action, "start_capture");
  assert.equal(parsed.wake_source, "natural_language_start");
});

test("calendar meeting listen phrase enters calendar-backed capture mode", () => {
  const parsed = parseMeetingCommand("開始旁聽這場會議");

  assert.equal(parsed.action, "start_capture_calendar");
  assert.equal(parsed.wake_source, "natural_language_calendar_start");
});

test("meeting stop phrase exits capture mode", () => {
  const parsed = parseMeetingCommand("會議結束了");

  assert.equal(parsed.action, "stop_capture");
  assert.equal(parsed.wake_source, "natural_language_stop");
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

test("buildMeetingStructuredResult exposes decisions, action items, and knowledge writeback", () => {
  const result = buildMeetingStructuredResult({
    summary: {
      time: "20260315",
      participants: ["Sean", "Amy"],
      conclusions: ["確認下週提交新版 proposal"],
      todos: [{ owner: "Sean", title: "整理 PRD", deadline: "20260320" }],
      main_points: ["同步交付節奏"],
    },
    classification: { meeting_type: "general" },
    transcriptText: "結論：確認下週提交新版 proposal",
    projectName: "Alpha",
  });

  assert.equal(result.decisions.length, 1);
  assert.equal(result.action_items.length, 1);
  assert.equal(result.knowledge_writeback.required, true);
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
  assert.equal(preview.workflow_state, "awaiting_confirmation");
  assert.notEqual(preview.workflow_state, "writing_back");
  assert.equal(typeof preview.verification.pass, "boolean");
  assert.ok(preview.structured_result);
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
  assert.equal(applied.workflow_state, "writing_back");
  assert.notEqual(applied.workflow_state, "completed");
  assert.equal(harness.createdDocuments.length, 0);
  const content = harness.documents.get("doc-existing");
  assert.match(content, /^\[20260315\]/);
  assert.match(content, /\[20260301\]\n\n舊內容$/);
  assert.ok(Array.isArray(applied.knowledge_proposals));
  assert.ok(applied.structured_result);
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
