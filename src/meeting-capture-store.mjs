import crypto from "node:crypto";
import db from "./db.mjs";
import { nowIso, normalizeText } from "./text-utils.mjs";

const getActiveSessionStmt = db.prepare(`
  SELECT *
  FROM meeting_capture_sessions
  WHERE account_id = ? AND chat_id = ? AND status = 'active'
  ORDER BY updated_at DESC
  LIMIT 1
`);

const getLatestSessionStmt = db.prepare(`
  SELECT *
  FROM meeting_capture_sessions
  WHERE account_id = ? AND chat_id = ?
  ORDER BY updated_at DESC
  LIMIT 1
`);

const insertSessionStmt = db.prepare(`
  INSERT INTO meeting_capture_sessions (
    id, account_id, chat_id, status, started_by_open_id, source_message_id,
    started_at, ended_at, created_at, updated_at,
    source_kind, event_id, event_summary, meeting_url, event_start_time, event_end_time,
    target_document_id, target_document_title, target_document_url
  ) VALUES (
    @id, @account_id, @chat_id, @status, @started_by_open_id, @source_message_id,
    @started_at, @ended_at, @created_at, @updated_at,
    @source_kind, @event_id, @event_summary, @meeting_url, @event_start_time, @event_end_time,
    @target_document_id, @target_document_title, @target_document_url
  )
`);

const updateSessionTimestampStmt = db.prepare(`
  UPDATE meeting_capture_sessions
  SET updated_at = @updated_at
  WHERE id = @id
`);

const updateSessionMetadataStmt = db.prepare(`
  UPDATE meeting_capture_sessions
  SET updated_at = @updated_at,
      source_kind = COALESCE(@source_kind, source_kind),
      event_id = COALESCE(@event_id, event_id),
      event_summary = COALESCE(@event_summary, event_summary),
      meeting_url = COALESCE(@meeting_url, meeting_url),
      event_start_time = COALESCE(@event_start_time, event_start_time),
      event_end_time = COALESCE(@event_end_time, event_end_time),
      target_document_id = COALESCE(@target_document_id, target_document_id),
      target_document_title = COALESCE(@target_document_title, target_document_title),
      target_document_url = COALESCE(@target_document_url, target_document_url),
      audio_file_path = COALESCE(@audio_file_path, audio_file_path),
      audio_device_name = COALESCE(@audio_device_name, audio_device_name),
      audio_pid = COALESCE(@audio_pid, audio_pid),
      audio_started_at = COALESCE(@audio_started_at, audio_started_at),
      audio_stopped_at = COALESCE(@audio_stopped_at, audio_stopped_at)
  WHERE id = @id
`);

const stopSessionStmt = db.prepare(`
  UPDATE meeting_capture_sessions
  SET status = 'stopped',
      ended_at = @ended_at,
      updated_at = @updated_at
  WHERE id = @id
`);

const insertEntryStmt = db.prepare(`
  INSERT OR IGNORE INTO meeting_capture_entries (
    id, session_id, message_id, sender_open_id, sender_label, content, created_at
  ) VALUES (
    @id, @session_id, @message_id, @sender_open_id, @sender_label, @content, @created_at
  )
`);

const listEntriesStmt = db.prepare(`
  SELECT *
  FROM meeting_capture_entries
  WHERE session_id = ?
  ORDER BY created_at ASC
`);

const lowSignalCapturePhrases = new Set([
  "好",
  "好的",
  "收到",
  "了解",
  "ok",
  "okay",
  "嗯",
  "嗯嗯",
  "請記錄吧",
  "请记录吧",
  "請記錄",
  "请记录",
  "我要開會了",
  "我要开会了",
  "會議結束了",
  "会议结束了",
  "請問在持續記錄中嗎",
  "请问在持续记录中吗",
  "你還在記錄嗎",
  "你还在记录吗",
  "你還在錄嗎",
  "你还在录吗",
]);

// ---------------------------------------------------------------------------
// Capture-session shaping helpers
// ---------------------------------------------------------------------------

function buildMeetingCaptureAudioMetadata({
  filePath = "",
  deviceName = "",
  pid = null,
  startedAt = "",
  stoppedAt = "",
} = {}) {
  return {
    audio_file_path: normalizeText(filePath) || null,
    audio_device_name: normalizeText(deviceName) || null,
    audio_pid: Number.isFinite(Number(pid)) ? Number(pid) : null,
    audio_started_at: startedAt || null,
    audio_stopped_at: stoppedAt || null,
  };
}

function normalizeSpeakerLabel(value = "") {
  const speaker = normalizeText(value);
  if (!speaker) {
    return "與會者";
  }
  if (/^ou_[a-z0-9]+$/i.test(speaker)) {
    return "與會者";
  }
  return speaker;
}

function isLowSignalMeetingCaptureText(value = "") {
  const text = normalizeText(value);
  if (!text) {
    return true;
  }
  const normalized = text.toLowerCase();
  if (lowSignalCapturePhrases.has(text) || lowSignalCapturePhrases.has(normalized)) {
    return true;
  }
  return false;
}

export function getActiveMeetingCaptureSession(accountId, chatId) {
  if (!accountId || !chatId) {
    return null;
  }
  return getActiveSessionStmt.get(accountId, chatId) || null;
}

export function getLatestMeetingCaptureSession(accountId, chatId) {
  if (!accountId || !chatId) {
    return null;
  }
  return getLatestSessionStmt.get(accountId, chatId) || null;
}

export function startMeetingCaptureSession({
  accountId,
  chatId,
  startedByOpenId = "",
  sourceMessageId = "",
  sourceKind = "",
  eventId = "",
  eventSummary = "",
  meetingUrl = "",
  eventStartTime = "",
    eventEndTime = "",
    targetDocumentId = "",
    targetDocumentTitle = "",
    targetDocumentUrl = "",
    audioFilePath = "",
    audioDeviceName = "",
    audioPid = null,
    audioStartedAt = "",
    audioStoppedAt = "",
  } = {}) {
  const existing = getActiveMeetingCaptureSession(accountId, chatId);
  if (existing) {
    updateSessionMetadataStmt.run({
      id: existing.id,
      updated_at: nowIso(),
      source_kind: sourceKind || null,
      event_id: eventId || null,
      event_summary: normalizeText(eventSummary) || null,
      meeting_url: normalizeText(meetingUrl) || null,
      event_start_time: eventStartTime || null,
      event_end_time: eventEndTime || null,
      target_document_id: targetDocumentId || null,
      target_document_title: normalizeText(targetDocumentTitle) || null,
      target_document_url: normalizeText(targetDocumentUrl) || null,
      ...buildMeetingCaptureAudioMetadata({
        filePath: audioFilePath,
        deviceName: audioDeviceName,
        pid: audioPid,
        startedAt: audioStartedAt,
        stoppedAt: audioStoppedAt,
      }),
    });
    return getActiveMeetingCaptureSession(accountId, chatId) || existing;
  }

  const timestamp = nowIso();
  const session = {
    id: crypto.randomUUID(),
    account_id: accountId,
    chat_id: chatId,
    status: "active",
    started_by_open_id: startedByOpenId || null,
    source_message_id: sourceMessageId || null,
    started_at: timestamp,
    ended_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    source_kind: sourceKind || null,
    event_id: eventId || null,
    event_summary: normalizeText(eventSummary) || null,
    meeting_url: normalizeText(meetingUrl) || null,
    event_start_time: eventStartTime || null,
    event_end_time: eventEndTime || null,
    target_document_id: targetDocumentId || null,
    target_document_title: normalizeText(targetDocumentTitle) || null,
    target_document_url: normalizeText(targetDocumentUrl) || null,
    ...buildMeetingCaptureAudioMetadata({
      filePath: audioFilePath,
      deviceName: audioDeviceName,
      pid: audioPid,
      startedAt: audioStartedAt,
      stoppedAt: audioStoppedAt,
    }),
  };
  insertSessionStmt.run(session);
  return getActiveMeetingCaptureSession(accountId, chatId) || session;
}

export function attachMeetingCaptureDocument(sessionId, { documentId = "", title = "", url = "" } = {}) {
  if (!sessionId || !documentId) {
    return null;
  }
  updateSessionMetadataStmt.run({
    id: sessionId,
    updated_at: nowIso(),
    source_kind: null,
    event_id: null,
    event_summary: null,
    meeting_url: null,
    event_start_time: null,
    event_end_time: null,
    target_document_id: documentId,
    target_document_title: normalizeText(title) || null,
    target_document_url: normalizeText(url) || null,
    audio_file_path: null,
    audio_device_name: null,
    audio_pid: null,
    audio_started_at: null,
    audio_stopped_at: null,
  });
  return documentId;
}

export function clearMeetingCaptureDocument(sessionId) {
  if (!sessionId) {
    return null;
  }
  updateSessionMetadataStmt.run({
    id: sessionId,
    updated_at: nowIso(),
    source_kind: null,
    event_id: null,
    event_summary: null,
    meeting_url: null,
    event_start_time: null,
    event_end_time: null,
    target_document_id: "",
    target_document_title: "",
    target_document_url: "",
    audio_file_path: null,
    audio_device_name: null,
    audio_pid: null,
    audio_started_at: null,
    audio_stopped_at: null,
  });
  return sessionId;
}

export function attachMeetingCaptureAudio(
  sessionId,
  { filePath = "", deviceName = "", pid = null, startedAt = "", stoppedAt = "" } = {},
) {
  if (!sessionId) {
    return null;
  }
  updateSessionMetadataStmt.run({
    id: sessionId,
    updated_at: nowIso(),
    source_kind: null,
    event_id: null,
    event_summary: null,
    meeting_url: null,
    event_start_time: null,
    event_end_time: null,
    target_document_id: null,
    target_document_title: null,
    target_document_url: null,
    ...buildMeetingCaptureAudioMetadata({
      filePath,
      deviceName,
      pid,
      startedAt,
      stoppedAt,
    }),
  });
  return sessionId;
}

export function appendMeetingCaptureEntry({
  sessionId,
  messageId,
  senderOpenId = "",
  senderLabel = "",
  content = "",
  createdAt = "",
} = {}) {
  const text = normalizeText(content);
  if (!sessionId || !messageId || !text) {
    return false;
  }
  insertEntryStmt.run({
    id: crypto.randomUUID(),
    session_id: sessionId,
    message_id: messageId,
    sender_open_id: senderOpenId || null,
    sender_label: normalizeText(senderLabel) || null,
    content: text,
    created_at: createdAt || nowIso(),
  });
  updateSessionTimestampStmt.run({
    id: sessionId,
    updated_at: nowIso(),
  });
  return true;
}

export function stopMeetingCaptureSession(sessionId) {
  if (!sessionId) {
    return null;
  }
  const endedAt = nowIso();
  stopSessionStmt.run({
    id: sessionId,
    ended_at: endedAt,
    updated_at: endedAt,
  });
  return endedAt;
}

export function listMeetingCaptureEntries(sessionId) {
  if (!sessionId) {
    return [];
  }
  return listEntriesStmt.all(sessionId);
}

export function buildMeetingCaptureTranscript(entries = [], { maxEntries = 80, maxChars = 3600 } = {}) {
  const activeEntries = entries
    .filter((entry) => !isLowSignalMeetingCaptureText(entry.content))
    .slice(-Math.max(1, maxEntries));
  const perEntryBudget = Math.max(120, Math.floor(maxChars / Math.max(1, activeEntries.length)));
  const transcript = activeEntries
    .map((entry) => {
      const speaker = normalizeSpeakerLabel(entry.sender_label || entry.sender_open_id || "與會者");
      const createdAt = normalizeText(entry.created_at || "").replace("T", " ").replace(/\.\d+Z?$/, "");
      const content = normalizeText(entry.content);
      const compactContent =
        content.length <= perEntryBudget ? content : `${content.slice(0, Math.max(0, perEntryBudget - 1)).trim()}…`;
      return `[${createdAt || "待確認"}] ${speaker}: ${compactContent}`;
    })
    .filter(Boolean)
    .join("\n");

  if (transcript.length <= maxChars) {
    return transcript;
  }
  return `${transcript.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}
