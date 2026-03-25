import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;
const {
  appendMeetingCaptureEntry,
  attachMeetingCaptureAudio,
  attachMeetingCaptureDocument,
  buildMeetingCaptureTranscript,
  getActiveMeetingCaptureSession,
  listMeetingCaptureEntries,
  startMeetingCaptureSession,
  stopMeetingCaptureSession,
} = await import("../src/meeting-capture-store.mjs");

test.after(() => {
  testDb.close();
});

function cleanup(accountId, chatId) {
  const sessions = db
    .prepare("SELECT id FROM meeting_capture_sessions WHERE account_id = ? AND chat_id = ?")
    .all(accountId, chatId);
  for (const session of sessions) {
    db.prepare("DELETE FROM meeting_capture_entries WHERE session_id = ?").run(session.id);
  }
  db.prepare("DELETE FROM meeting_capture_sessions WHERE account_id = ? AND chat_id = ?").run(accountId, chatId);
  db.prepare("DELETE FROM lark_tokens WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM lark_accounts WHERE id = ?").run(accountId);
}

test("meeting capture session starts, appends entries, and stops cleanly", () => {
  const accountId = "acct-meeting-test";
  const chatId = "chat-meeting-test";
  cleanup(accountId, chatId);
  db.prepare(`
    INSERT INTO lark_accounts (
      id, open_id, user_id, union_id, tenant_key, name, email, scope, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    "ou_meeting_test",
    "user_meeting_test",
    "union_meeting_test",
    "tenant_meeting_test",
    "Meeting Test",
    "",
    "meeting",
    "2026-03-16T00:00:00.000Z",
    "2026-03-16T00:00:00.000Z",
  );

  const session = startMeetingCaptureSession({
    accountId,
    chatId,
    startedByOpenId: "ou_test",
    sourceMessageId: "msg-start",
  });

  assert.equal(getActiveMeetingCaptureSession(accountId, chatId)?.id, session.id);

  appendMeetingCaptureEntry({
    sessionId: session.id,
    messageId: "msg-1",
    senderOpenId: "ou_test",
    senderLabel: "Sean",
    content: "今天先同步 KR 進展",
    createdAt: "2026-03-16T09:00:00.000Z",
  });
  appendMeetingCaptureEntry({
    sessionId: session.id,
    messageId: "msg-2",
    senderOpenId: "ou_other",
    senderLabel: "Amy",
    content: "目前卡點在付款頁轉化",
    createdAt: "2026-03-16T09:01:00.000Z",
  });

  const entries = listMeetingCaptureEntries(session.id);
  assert.equal(entries.length, 2);
  assert.match(buildMeetingCaptureTranscript(entries), /\[2026-03-16 09:00:00\] Sean: 今天先同步 KR 進展/);
  assert.match(buildMeetingCaptureTranscript(entries), /\[2026-03-16 09:01:00\] Amy: 目前卡點在付款頁轉化/);

  stopMeetingCaptureSession(session.id);
  assert.equal(getActiveMeetingCaptureSession(accountId, chatId), null);

  cleanup(accountId, chatId);
});

test("meeting capture transcript is compacted for prompt use", () => {
  const transcript = buildMeetingCaptureTranscript(
    [
      {
        sender_label: "Sean",
        content: "A".repeat(1200),
        created_at: "2026-03-16T09:00:00.000Z",
      },
      {
        sender_label: "Amy",
        content: "B".repeat(1200),
        created_at: "2026-03-16T09:01:00.000Z",
      },
      {
        sender_label: "Bob",
        content: "C".repeat(1200),
        created_at: "2026-03-16T09:02:00.000Z",
      },
    ],
    { maxEntries: 2, maxChars: 800 },
  );

  assert.doesNotMatch(transcript, /Sean/);
  assert.match(transcript, /Amy/);
  assert.match(transcript, /Bob/);
  assert.ok(transcript.length <= 800);
});

test("meeting capture session can attach a target document", () => {
  const accountId = "acct-meeting-doc-test";
  const chatId = "chat-meeting-doc-test";
  cleanup(accountId, chatId);
  db.prepare(`
    INSERT INTO lark_accounts (
      id, open_id, user_id, union_id, tenant_key, name, email, scope, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    "ou_meeting_doc_test",
    "user_meeting_doc_test",
    "union_meeting_doc_test",
    "tenant_meeting_doc_test",
    "Meeting Doc Test",
    "",
    "meeting",
    "2026-03-16T00:00:00.000Z",
    "2026-03-16T00:00:00.000Z",
  );

  const session = startMeetingCaptureSession({
    accountId,
    chatId,
    startedByOpenId: "ou_test",
  });
  attachMeetingCaptureDocument(session.id, {
    documentId: "doc-meeting-1",
    title: "Meeting Doc",
    url: "https://larksuite.com/docx/doc-meeting-1",
  });

  const updated = getActiveMeetingCaptureSession(accountId, chatId);
  assert.equal(updated.target_document_id, "doc-meeting-1");
  assert.equal(updated.target_document_title, "Meeting Doc");
  assert.equal(updated.target_document_url, "https://larksuite.com/docx/doc-meeting-1");

  cleanup(accountId, chatId);
});

test("meeting capture session can persist audio metadata", () => {
  const accountId = "acct-meeting-audio-test";
  const chatId = "chat-meeting-audio-test";
  cleanup(accountId, chatId);
  db.prepare(`
    INSERT INTO lark_accounts (
      id, open_id, user_id, union_id, tenant_key, name, email, scope, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    "ou_meeting_audio_test",
    "user_meeting_audio_test",
    "union_meeting_audio_test",
    "tenant_meeting_audio_test",
    "Meeting Audio Test",
    "",
    "meeting",
    "2026-03-16T00:00:00.000Z",
    "2026-03-16T00:00:00.000Z",
  );

  const session = startMeetingCaptureSession({
    accountId,
    chatId,
    startedByOpenId: "ou_test",
  });

  attachMeetingCaptureAudio(session.id, {
    filePath: "/tmp/test.m4a",
    deviceName: "MacBook Air的麥克風",
    pid: 4321,
    startedAt: "2026-03-16T09:00:00.000Z",
  });

  const updated = getActiveMeetingCaptureSession(accountId, chatId);
  assert.equal(updated.audio_file_path, "/tmp/test.m4a");
  assert.equal(updated.audio_device_name, "MacBook Air的麥克風");
  assert.equal(updated.audio_pid, 4321);
  assert.equal(updated.audio_started_at, "2026-03-16T09:00:00.000Z");

  cleanup(accountId, chatId);
});

test("meeting capture session keeps calendar-backed metadata", () => {
  const accountId = "acct-meeting-calendar-test";
  const chatId = "chat-meeting-calendar-test";
  cleanup(accountId, chatId);
  db.prepare(`
    INSERT INTO lark_accounts (
      id, open_id, user_id, union_id, tenant_key, name, email, scope, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    "ou_meeting_calendar_test",
    "user_meeting_calendar_test",
    "union_meeting_calendar_test",
    "tenant_meeting_calendar_test",
    "Meeting Calendar Test",
    "",
    "meeting",
    "2026-03-16T00:00:00.000Z",
    "2026-03-16T00:00:00.000Z",
  );

  startMeetingCaptureSession({
    accountId,
    chatId,
    startedByOpenId: "ou_test",
    sourceKind: "calendar_event",
    eventId: "evt-1",
    eventSummary: "Scanoo 週會",
    meetingUrl: "https://meet.example/123",
    eventStartTime: "1773651600",
    eventEndTime: "1773655200",
  });

  const session = getActiveMeetingCaptureSession(accountId, chatId);
  assert.equal(session.source_kind, "calendar_event");
  assert.equal(session.event_id, "evt-1");
  assert.equal(session.event_summary, "Scanoo 週會");
  assert.equal(session.meeting_url, "https://meet.example/123");

  cleanup(accountId, chatId);
});

test("meeting capture session can be upgraded with calendar metadata later", () => {
  const accountId = "acct-meeting-upgrade-test";
  const chatId = "chat-meeting-upgrade-test";
  cleanup(accountId, chatId);
  db.prepare(`
    INSERT INTO lark_accounts (
      id, open_id, user_id, union_id, tenant_key, name, email, scope, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    "ou_meeting_upgrade_test",
    "user_meeting_upgrade_test",
    "union_meeting_upgrade_test",
    "tenant_meeting_upgrade_test",
    "Meeting Upgrade Test",
    "",
    "meeting",
    "2026-03-16T00:00:00.000Z",
    "2026-03-16T00:00:00.000Z",
  );

  startMeetingCaptureSession({
    accountId,
    chatId,
    startedByOpenId: "ou_test",
  });

  startMeetingCaptureSession({
    accountId,
    chatId,
    startedByOpenId: "ou_test",
    sourceKind: "calendar_event",
    eventId: "evt-upgrade",
    eventSummary: "Auto-upgraded meeting",
    meetingUrl: "https://meet.example/upgrade",
  });

  const session = getActiveMeetingCaptureSession(accountId, chatId);
  assert.equal(session.source_kind, "calendar_event");
  assert.equal(session.event_id, "evt-upgrade");
  assert.equal(session.event_summary, "Auto-upgraded meeting");
  assert.equal(session.meeting_url, "https://meet.example/upgrade");

  cleanup(accountId, chatId);
});

test("meeting capture transcript filters control chatter and raw open_id labels", () => {
  const transcript = buildMeetingCaptureTranscript([
    {
      sender_label: "ou_12e07e7441a4a605bd4d204ad8a18e6d",
      created_at: "2026-03-16T09:20:27.000Z",
      content: "好的",
    },
    {
      sender_label: "ou_12e07e7441a4a605bd4d204ad8a18e6d",
      created_at: "2026-03-16T09:21:00.000Z",
      content: "本週先完成 onboarding 改版，付款頁轉化下滑要另外追。",
    },
  ]);

  assert.doesNotMatch(transcript, /好的/);
  assert.match(transcript, /\[2026-03-16 09:21:00\] 與會者: 本週先完成 onboarding 改版/);
});
