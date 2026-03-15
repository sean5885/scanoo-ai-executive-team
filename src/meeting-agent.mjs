import crypto from "node:crypto";
import db from "./db.mjs";
import {
  agentPromptEmergencyRatio,
  agentPromptLightRatio,
  agentPromptRollingRatio,
  llmApiKey,
  llmBaseUrl,
  llmModel,
  meetingDefaultChatId,
  meetingConfirmPath,
  meetingDocFolderToken,
  meetingPromptMaxTokens,
  oauthBaseUrl,
} from "./config.mjs";
import {
  consumeMeetingWriteConfirmation,
  createMeetingWriteConfirmation,
} from "./doc-update-confirmations.mjs";
import { governPromptSections, trimTextForBudget } from "./agent-token-governance.mjs";
import { createDocument, getDocument, sendMessage, updateDocument } from "./lark-content.mjs";
import { normalizeText, nowIso } from "./text-utils.mjs";

const WEEKLY_PROGRESS_KEYWORDS = ["進展", "推进", "推進", "完成度", "完成", "達成", "okr", "kr", "目標", "objective"];
const WEEKLY_ISSUE_KEYWORDS = ["卡點", "阻塞", "問題", "风险", "風險", "瓶頸"];
const WEEKLY_SOLUTION_KEYWORDS = ["解法", "方案", "決定", "處理", "修復", "對策"];
const WEEKLY_TODO_KEYWORDS = ["todo", "待辦", "待办", "owner", "下週", "本週", "跟進", "跟进", "action item"];
const GENERAL_CONCLUSION_KEYWORDS = ["結論", "结论", "決定", "决定", "共識", "共识", "確認", "确认"];
const DONE_KEYWORDS = ["完成", "已完成", "done", "結案", "close"];

function splitLines(value) {
  return normalizeText(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function stripBullet(line) {
  return String(line || "").replace(/^\s*[-*•]\s*/, "").trim();
}

function dedupe(values = []) {
  const seen = new Set();
  const items = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    items.push(normalized);
  }
  return items;
}

function parseDelimitedList(value) {
  return dedupe(
    String(value || "")
      .split(/[、，,\/\n]/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function normalizeProjectKey(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return "default";
  }
  return normalized
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "default";
}

function sanitizeProjectName(value) {
  return normalizeText(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b(weekly|meeting|notes)\b/gi, "")
    .replace(/(週會|周会|會議紀要|会议纪要|會議|会议|紀要|纪要)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractExplicitProjectName(text, metadata = {}) {
  const direct = normalizeText(metadata.project_name || metadata.projectName || "");
  if (direct) {
    return direct;
  }
  const sourceTitle = sanitizeProjectName(
    metadata.source_title || metadata.source || metadata.document_title || metadata.doc_title || "",
  );
  if (sourceTitle) {
    return sourceTitle;
  }
  const line = splitLines(text).find((item) => /^(專案|项目|project)\s*[:：]/i.test(item));
  if (!line) {
    return "";
  }
  return normalizeText(line.replace(/^(專案|项目|project)\s*[:：]/i, ""));
}

function buildStableProjectIdentity({ text, metadata = {}, chatId = "" } = {}) {
  const explicit = extractExplicitProjectName(text, metadata);
  if (explicit) {
    return {
      project_name: explicit,
      project_key: normalizeProjectKey(explicit),
    };
  }

  const chatName = normalizeText(metadata.chat_name || metadata.chatName || "");
  if (chatName) {
    return {
      project_name: chatName,
      project_key: normalizeProjectKey(chatName),
    };
  }

  if (chatId) {
    return {
      project_name: `group_${chatId.slice(-8)}`,
      project_key: `group_${chatId}`,
    };
  }

  return {
    project_name: "shared",
    project_key: "shared",
  };
}

function parseMeetingCommand(text) {
  const normalized = String(text || "").trim();
  if (!normalized.startsWith("/meeting")) {
    return null;
  }

  const confirmMatch = normalized.match(/^\/meeting\s+confirm\s+([a-zA-Z0-9-]+)\s*$/);
  if (confirmMatch) {
    return {
      action: "confirm",
      confirmation_id: confirmMatch[1],
    };
  }

  return {
    action: "process",
    content: normalized.replace(/^\/meeting\s*/u, "").trim(),
  };
}

function collectSignalCount(text, keywords) {
  const normalized = normalizeText(text).toLowerCase();
  return keywords.reduce((count, keyword) => (normalized.includes(keyword.toLowerCase()) ? count + 1 : count), 0);
}

export function classifyMeeting({ text = "", metadata = {} } = {}) {
  const normalized = normalizeText([text, metadata.title, metadata.file_name, metadata.topic].filter(Boolean).join("\n"));
  const progressSignals = collectSignalCount(normalized, WEEKLY_PROGRESS_KEYWORDS);
  const issueSignals = collectSignalCount(normalized, WEEKLY_ISSUE_KEYWORDS);
  const solutionSignals = collectSignalCount(normalized, WEEKLY_SOLUTION_KEYWORDS);
  const todoSignals = collectSignalCount(normalized, WEEKLY_TODO_KEYWORDS);
  const categoryHits = [progressSignals > 0, issueSignals > 0, solutionSignals > 0, todoSignals > 0].filter(Boolean).length;
  const totalSignals = progressSignals + issueSignals + solutionSignals + todoSignals;

  if (categoryHits >= 3 && totalSignals >= 5) {
    return {
      meeting_type: "weekly",
      confidence: Math.min(0.96, 0.62 + totalSignals * 0.04),
      reason: "命中 KR/進展/卡點/解法/Todo 多個週會特徵。",
    };
  }

  return {
    meeting_type: "general",
    confidence: categoryHits <= 1 ? 0.86 : 0.64,
    reason: "資訊不足以證明是 KR 追蹤型週會，依規則預設為 general。",
  };
}

function extractMeetingDate(text, metadata = {}) {
  const rawCandidates = [
    metadata.date,
    metadata.meeting_date,
    metadata.source_date,
    metadata.created_at,
    metadata.file_name,
    text,
  ].filter(Boolean);

  for (const candidate of rawCandidates) {
    const value = String(candidate);
    const compact = value.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
    if (compact) {
      return `${compact[1]}${compact[2]}${compact[3]}`;
    }

    const separated = value.match(/\b(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
    if (separated) {
      const [, year, month, day] = separated;
      return `${year}${month.padStart(2, "0")}${day.padStart(2, "0")}`;
    }
  }

  return "待確認";
}

function extractParticipants(text, metadata = {}) {
  if (Array.isArray(metadata.participants) && metadata.participants.length) {
    return dedupe(metadata.participants.map((item) => normalizeText(item))).slice(0, 12);
  }

  const line = splitLines(text).find((item) => /^(參與人員|参与人员|與會|与会|参会|attendees?)\s*[:：]/i.test(item));
  if (!line) {
    return ["待確認"];
  }

  const parsed = parseDelimitedList(line.replace(/^(參與人員|参与人员|與會|与会|参会|attendees?)\s*[:：]/i, ""));
  return parsed.length ? parsed.slice(0, 12) : ["待確認"];
}

function normalizeOwner(value) {
  const normalized = normalizeText(value);
  return normalized || "待確認";
}

function parseTodoLine(line) {
  const normalized = stripBullet(line).replace(/^(todo|待辦|待办)\s*[:：]\s*/i, "");
  const bracketOwner = normalized.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (bracketOwner) {
    return {
      owner: normalizeOwner(bracketOwner[1]),
      title: normalizeText(bracketOwner[2]),
    };
  }

  const ownerPrefix = normalized.match(/^(owner|負責人|负责人)\s*[:：]\s*([^\s]+)\s+(.+)$/i);
  if (ownerPrefix) {
    return {
      owner: normalizeOwner(ownerPrefix[2]),
      title: normalizeText(ownerPrefix[3]),
    };
  }

  const looseOwner = normalized.match(/^([A-Za-z\u4e00-\u9fff]{1,24})\s+(.+)$/u);
  if (looseOwner) {
    return {
      owner: normalizeOwner(looseOwner[1]),
      title: normalizeText(looseOwner[2]),
    };
  }

  return {
    owner: "待確認",
    title: normalized,
  };
}

function pickLinesByKeywords(lines, keywords) {
  return dedupe(lines.filter((line) => keywords.some((keyword) => line.toLowerCase().includes(keyword.toLowerCase()))));
}

function fallbackLines(lines, maxItems = 3) {
  return dedupe(lines.map(stripBullet)).filter(Boolean).slice(0, maxItems);
}

function buildWeeklySummaryDeterministic(text, metadata = {}) {
  const lines = splitLines(text);
  const progress = pickLinesByKeywords(lines, WEEKLY_PROGRESS_KEYWORDS);
  const issues = pickLinesByKeywords(lines, WEEKLY_ISSUE_KEYWORDS);
  const solutions = pickLinesByKeywords(lines, WEEKLY_SOLUTION_KEYWORDS);
  const todoLines = dedupe(lines.filter((line) => WEEKLY_TODO_KEYWORDS.some((keyword) => line.toLowerCase().includes(keyword.toLowerCase()))));
  const fallback = fallbackLines(lines, 6);

  const todos = todoLines.length
    ? todoLines.map(parseTodoLine).filter((item) => item.title)
    : fallback.slice(0, 2).map((line) => ({ owner: "待確認", title: line }));

  return {
    meeting_type: "weekly",
    time: extractMeetingDate(text, metadata),
    participants: extractParticipants(text, metadata),
    progress: (progress.length ? progress : fallback.slice(0, 2)).slice(0, 4),
    issues: (issues.length ? issues : fallback.slice(2, 4)).slice(0, 4),
    solutions: (solutions.length ? solutions : fallback.slice(4, 6)).slice(0, 4),
    todos: todos.slice(0, 6),
  };
}

function buildGeneralSummaryDeterministic(text, metadata = {}) {
  const lines = splitLines(text);
  const contentLines = fallbackLines(
    lines.filter(
      (line) =>
        !/^(project|專案|项目|參與人員|参与人员|與會|与会|参会|attendees?|時間|time|todo|待辦|待办)\s*[:：]/i.test(line),
    ),
    8,
  ).slice(0, 4);
  const conclusionLines = pickLinesByKeywords(lines, GENERAL_CONCLUSION_KEYWORDS);
  const todoLines = dedupe(lines.filter((line) => WEEKLY_TODO_KEYWORDS.some((keyword) => line.toLowerCase().includes(keyword.toLowerCase()))));

  return {
    meeting_type: "general",
    time: extractMeetingDate(text, metadata),
    participants: extractParticipants(text, metadata),
    main_points: contentLines.length ? contentLines : ["待確認"],
    conclusions: (conclusionLines.length ? conclusionLines : fallbackLines(lines.slice(2), 3)).slice(0, 4),
    todos: (todoLines.length ? todoLines.map(parseTodoLine) : []).slice(0, 6),
  };
}

function sanitizeWeeklySummary(payload = {}, text = "", metadata = {}) {
  const fallback = buildWeeklySummaryDeterministic(text, metadata);
  return {
    meeting_type: "weekly",
    time: fallback.time,
    participants: fallback.participants,
    progress: dedupe((payload.progress || []).map(stripBullet)).slice(0, 4).length
      ? dedupe((payload.progress || []).map(stripBullet)).slice(0, 4)
      : fallback.progress,
    issues: dedupe((payload.issues || []).map(stripBullet)).slice(0, 4).length
      ? dedupe((payload.issues || []).map(stripBullet)).slice(0, 4)
      : fallback.issues,
    solutions: dedupe((payload.solutions || []).map(stripBullet)).slice(0, 4).length
      ? dedupe((payload.solutions || []).map(stripBullet)).slice(0, 4)
      : fallback.solutions,
    todos: Array.isArray(payload.todos) && payload.todos.length
      ? payload.todos
          .map((item) => ({
            owner: normalizeOwner(item?.owner),
            title: normalizeText(item?.title),
            objective: normalizeText(item?.objective),
            kr: normalizeText(item?.kr),
          }))
          .filter((item) => item.title)
          .slice(0, 6)
      : fallback.todos,
  };
}

function sanitizeGeneralSummary(payload = {}, text = "", metadata = {}) {
  const fallback = buildGeneralSummaryDeterministic(text, metadata);
  return {
    meeting_type: "general",
    time: normalizeText(payload.time) || fallback.time,
    participants: dedupe((payload.participants || []).map(normalizeText)).slice(0, 12).length
      ? dedupe((payload.participants || []).map(normalizeText)).slice(0, 12)
      : fallback.participants,
    main_points: dedupe((payload.main_points || []).map(stripBullet)).slice(0, 5).length
      ? dedupe((payload.main_points || []).map(stripBullet)).slice(0, 5)
      : fallback.main_points,
    conclusions: dedupe((payload.conclusions || []).map(stripBullet)).slice(0, 5).length
      ? dedupe((payload.conclusions || []).map(stripBullet)).slice(0, 5)
      : fallback.conclusions,
    todos: Array.isArray(payload.todos)
      ? payload.todos
          .map((item) => ({
            owner: normalizeOwner(item?.owner),
            title: normalizeText(item?.title),
          }))
          .filter((item) => item.title)
          .slice(0, 6)
      : fallback.todos,
  };
}

function extractJsonPayload(text) {
  const normalized = String(text || "").trim();
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(normalized.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function generateMeetingSummaryWithModel({ text, metadata = {}, classification }) {
  if (!llmApiKey) {
    return null;
  }

  const systemPrompt =
    classification.meeting_type === "weekly"
      ? "你是會議整理助手。只輸出 JSON，不補充未提及內容。weekly 只輸出 progress、issues、solutions、todos。"
      : "你是會議整理助手。只輸出 JSON，不補充未提及內容。general 只輸出 time、participants、main_points、conclusions、todos。";

  const schemaText =
    classification.meeting_type === "weekly"
      ? `輸出 JSON：{"progress":["..."],"issues":["..."],"solutions":["..."],"todos":[{"owner":"...","title":"...","objective":"...","kr":"..."}]}`
      : `輸出 JSON：{"time":"YYYYMMDD或待確認","participants":["..."],"main_points":["..."],"conclusions":["..."],"todos":[{"owner":"...","title":"..."}]}`;

  const governed = governPromptSections({
    systemPrompt,
    maxTokens: meetingPromptMaxTokens,
    thresholds: {
      light: agentPromptLightRatio,
      rolling: agentPromptRollingRatio,
      emergency: agentPromptEmergencyRatio,
    },
    sections: [
      {
        name: "task_goal",
        label: "task_goal",
        text:
          classification.meeting_type === "weekly"
            ? "判定已完成。請只整理 KR 推進相關核心，不寫流水帳，不補充 CEO 支援事項。"
            : "判定已完成。請只整理會議核心，不補充未提及內容。",
        required: true,
        maxTokens: 100,
      },
      {
        name: "output_schema",
        label: "output_schema",
        text: schemaText,
        required: true,
        maxTokens: 120,
      },
      {
        name: "metadata",
        label: "metadata",
        text: trimTextForBudget(JSON.stringify(metadata || {}, null, 2), 500),
        summaryText: trimTextForBudget(JSON.stringify(metadata || {}, null, 2), 240),
        maxTokens: 120,
      },
      {
        name: "meeting_content",
        label: "meeting_content",
        text: trimTextForBudget(text, 3600),
        summaryText: trimTextForBudget(text, 1800),
        required: true,
        maxTokens: 1400,
      },
    ],
  });

  const response = await fetch(`${llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llmApiKey}`,
    },
    body: JSON.stringify({
      model: llmModel,
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: governed.prompt },
      ],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    return null;
  }
  return extractJsonPayload(data.choices?.[0]?.message?.content || "");
}

async function buildMeetingSummary({ text, metadata = {}, classification }) {
  const generated = await generateMeetingSummaryWithModel({ text, metadata, classification });
  if (classification.meeting_type === "weekly") {
    return sanitizeWeeklySummary(generated || {}, text, metadata);
  }
  return sanitizeGeneralSummary(generated || {}, text, metadata);
}

export function formatWeeklyMeeting(summary = {}) {
  const progress = dedupe(summary.progress || []).slice(0, 4);
  const issues = dedupe(summary.issues || []).slice(0, 4);
  const solutions = dedupe(summary.solutions || []).slice(0, 4);
  const todos = Array.isArray(summary.todos) ? summary.todos : [];

  return [
    "【本週會議核心】",
    "",
    "核心進展：",
    ...(progress.length ? progress.map((item) => `- ${item}`) : ["- 未明確提及"]),
    "",
    "關鍵問題：",
    ...(issues.length ? issues.map((item) => `- ${item}`) : ["- 未明確提及"]),
    "",
    "解法：",
    ...(solutions.length ? solutions.map((item) => `- ${item}`) : ["- 未明確提及"]),
    "",
    "本週 Todo：",
    ...(todos.length
      ? todos.map((item) => `- [${normalizeOwner(item.owner)}] ${item.title}`)
      : ["- [待確認] 未明確提及"]),
  ].join("\n");
}

export function formatGeneralMeeting(summary = {}) {
  const participants = Array.isArray(summary.participants) && summary.participants.length
    ? summary.participants.join("、")
    : "待確認";
  const mainPoints = dedupe(summary.main_points || []).slice(0, 5);
  const conclusions = dedupe(summary.conclusions || []).slice(0, 5);
  const todos = Array.isArray(summary.todos) ? summary.todos : [];

  return [
    "【會議紀要】",
    `時間：${normalizeText(summary.time) || "待確認"}`,
    `參與人員：${participants}`,
    "",
    "主要內容：",
    ...(mainPoints.length ? mainPoints.map((item) => `- ${item}`) : ["- 待確認"]),
    "",
    "關鍵結論：",
    ...(conclusions.length ? conclusions.map((item) => `- ${item}`) : ["- 待確認"]),
    "",
    "TODO：",
    ...(todos.length
      ? todos.map((item) => `- [${normalizeOwner(item.owner)}] ${item.title}`)
      : ["- [待確認] 未明確提及"]),
  ].join("\n");
}

export function buildMeetingGroupMessage({ meeting_type, summary }) {
  return meeting_type === "weekly"
    ? formatWeeklyMeeting(summary)
    : formatGeneralMeeting(summary);
}

function buildGeneralMeetingDocEntry(summary = {}) {
  const participants = Array.isArray(summary.participants) && summary.participants.length
    ? summary.participants
    : ["待確認"];
  const mainPoints = dedupe(summary.main_points || []).slice(0, 5);
  const conclusions = dedupe(summary.conclusions || []).slice(0, 5);
  const todos = Array.isArray(summary.todos) ? summary.todos : [];

  return [
    `[${normalizeText(summary.time) || "待確認"}]`,
    "",
    "參與人員：",
    ...participants.map((item) => `- ${item}`),
    "",
    "主要內容：",
    ...(mainPoints.length ? mainPoints.map((item) => `- ${item}`) : ["- 待確認"]),
    "",
    "關鍵結論：",
    ...(conclusions.length ? conclusions.map((item) => `- ${item}`) : ["- 待確認"]),
    "",
    "TODO：",
    ...(todos.length
      ? todos.map((item) => `- [${normalizeOwner(item.owner)}] ${item.title}`)
      : ["- [待確認] 未明確提及"]),
  ].join("\n");
}

function buildWeeklyMeetingDocEntry(summary = {}) {
  return [`[${normalizeText(summary.time) || "待確認"}]`, "", formatWeeklyMeeting(summary)].join("\n");
}

function buildMeetingDocTitle(projectName, meetingType) {
  const normalized = normalizeText(projectName) || "shared";
  return meetingType === "weekly"
    ? `${normalized}_weekly_meeting_notes`
    : `${normalized}_meeting_notes`;
}

function buildMeetingConfirmUrl({ confirmationId, accountId }) {
  const url = new URL(meetingConfirmPath, oauthBaseUrl);
  url.searchParams.set("confirmation_id", confirmationId);
  if (accountId) {
    url.searchParams.set("account_id", accountId);
  }
  return url.toString();
}

export function buildMeetingConfirmationCard({
  meetingType,
  summaryContent,
  confirmationId,
  accountId,
  projectName,
}) {
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: meetingType === "weekly" ? "orange" : "blue",
      title: {
        tag: "plain_text",
        content: `${projectName || "meeting"}｜${meetingType === "weekly" ? "週會摘要待確認" : "會議紀要待確認"}`,
      },
    },
    elements: [
      {
        tag: "markdown",
        content: summaryContent,
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "文檔尚未寫入；請確認後才會正式落盤。",
          },
        ],
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: {
              tag: "plain_text",
              content: "確認寫入文檔",
            },
            url: buildMeetingConfirmUrl({ confirmationId, accountId }),
          },
        ],
      },
    ],
  };
}

function getMappedMeetingDocument(accountId, projectKey, meetingType) {
  return db
    .prepare(`
      SELECT *
      FROM meeting_documents
      WHERE account_id = ? AND project_key = ? AND meeting_type = ?
      LIMIT 1
    `)
    .get(accountId, projectKey, meetingType) || null;
}

function saveMeetingDocumentMapping({ accountId, projectKey, projectName, meetingType, documentId, title, chatId }) {
  const timestamp = nowIso();
  const existing = getMappedMeetingDocument(accountId, projectKey, meetingType);
  const id = existing?.id || crypto.randomUUID();

  db.prepare(`
    INSERT INTO meeting_documents (
      id, account_id, project_key, project_name, meeting_type, document_id, title, chat_id, created_at, updated_at
    ) VALUES (
      @id, @account_id, @project_key, @project_name, @meeting_type, @document_id, @title, @chat_id, @created_at, @updated_at
    )
    ON CONFLICT(account_id, project_key, meeting_type) DO UPDATE SET
      project_name = excluded.project_name,
      document_id = excluded.document_id,
      title = excluded.title,
      chat_id = excluded.chat_id,
      updated_at = excluded.updated_at
  `).run({
    id,
    account_id: accountId,
    project_key: projectKey,
    project_name: projectName || null,
    meeting_type: meetingType,
    document_id: documentId,
    title: title || null,
    chat_id: chatId || null,
    created_at: timestamp,
    updated_at: timestamp,
  });

  return getMappedMeetingDocument(accountId, projectKey, meetingType);
}

function findSyncedMeetingDocument(accountId, title) {
  return db
    .prepare(`
      SELECT document_id, title, url
      FROM lark_documents
      WHERE account_id = @account_id
        AND active = 1
        AND title = @title
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .get({ account_id: accountId, title }) || null;
}

function listWeeklyTrackerItems(accountId, projectKey) {
  return db
    .prepare(`
      SELECT *
      FROM weekly_todo_tracker
      WHERE account_id = ? AND project_key = ?
      ORDER BY updated_at DESC
    `)
    .all(accountId, projectKey);
}

function upsertWeeklyTrackerItem(item) {
  const existing = db
    .prepare(`
      SELECT id
      FROM weekly_todo_tracker
      WHERE account_id = ? AND project_key = ? AND meeting_type = 'weekly' AND normalized_key = ?
    `)
    .get(item.account_id, item.project_key, item.normalized_key);
  const timestamp = nowIso();
  const id = existing?.id || crypto.randomUUID();

  db.prepare(`
    INSERT INTO weekly_todo_tracker (
      id, account_id, project_key, meeting_type, normalized_key, title, owner, objective, kr, status,
      source_date, source_meeting_id, created_at, updated_at
    ) VALUES (
      @id, @account_id, @project_key, 'weekly', @normalized_key, @title, @owner, @objective, @kr, @status,
      @source_date, @source_meeting_id, @created_at, @updated_at
    )
    ON CONFLICT(account_id, project_key, meeting_type, normalized_key) DO UPDATE SET
      title = excluded.title,
      owner = excluded.owner,
      objective = excluded.objective,
      kr = excluded.kr,
      status = excluded.status,
      source_date = excluded.source_date,
      source_meeting_id = excluded.source_meeting_id,
      updated_at = excluded.updated_at
  `).run({
    ...item,
    id,
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function normalizeTodoKey(todo) {
  return normalizeText([todo.title, todo.objective, todo.kr].filter(Boolean).join("|"))
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function inferDoneFromTranscript(text, item) {
  const normalized = normalizeText(text).toLowerCase();
  const title = normalizeText(item.title).toLowerCase().slice(0, 18);
  if (!title) {
    return false;
  }
  return DONE_KEYWORDS.some((keyword) => {
    const normalizedKeyword = keyword.toLowerCase();
    const patterns = [
      `${normalizedKeyword}${title}`,
      `${normalizedKeyword} ${title}`,
      `${title}${normalizedKeyword}`,
      `${title} ${normalizedKeyword}`,
    ];
    return patterns.some((pattern) => normalized.includes(pattern));
  });
}

function buildWeeklyTrackerPayload(summary, {
  projectKey,
  accountId,
  sourceDate,
  sourceMeetingId,
  transcriptText,
  existingItems = [],
}) {
  const existing = Array.isArray(existingItems) ? existingItems : [];
  const existingMap = new Map(existing.map((item) => [item.normalized_key, item]));
  const items = [];

  for (const todo of summary.todos || []) {
    const normalizedKey = normalizeTodoKey(todo);
    const previous = existingMap.get(normalizedKey);
    let status = "new";
    if (normalizeOwner(todo.owner) === "待確認") {
      status = "pending_confirm";
    } else if (previous && previous.status !== "done") {
      status = "carry_over";
    }
    if (inferDoneFromTranscript(transcriptText, todo)) {
      status = "done";
    }

    items.push({
      account_id: accountId,
      project_key: projectKey,
      normalized_key: normalizedKey,
      title: todo.title,
      owner: normalizeOwner(todo.owner),
      objective: normalizeText(todo.objective),
      kr: normalizeText(todo.kr),
      status,
      source_date: sourceDate,
      source_meeting_id: sourceMeetingId,
    });
  }

  return items;
}

function defaultCoordinatorDeps() {
  return {
    sendMessage,
    getDocument,
    createDocument,
    updateDocument,
    createConfirmation: createMeetingWriteConfirmation,
    consumeConfirmation: consumeMeetingWriteConfirmation,
    getMappedMeetingDocument,
    saveMeetingDocumentMapping,
    findSyncedMeetingDocument,
    listWeeklyTrackerItems,
    upsertWeeklyTrackerItem,
  };
}

export function createMeetingCoordinator(overrides = {}) {
  const deps = {
    ...defaultCoordinatorDeps(),
    ...overrides,
  };

  async function resolveMeetingDocumentTarget({ accountId, projectKey, projectName, meetingType, chatId }) {
    const mapped = deps.getMappedMeetingDocument(accountId, projectKey, meetingType);
    if (mapped) {
      return {
        document_id: mapped.document_id,
        title: mapped.title || buildMeetingDocTitle(projectName, meetingType),
        existed: true,
      };
    }

    const title = buildMeetingDocTitle(projectName, meetingType);
    const synced = deps.findSyncedMeetingDocument(accountId, title);
    if (synced?.document_id) {
      deps.saveMeetingDocumentMapping({
        accountId,
        projectKey,
        projectName,
        meetingType,
        documentId: synced.document_id,
        title: synced.title || title,
        chatId,
      });
      return {
        document_id: synced.document_id,
        title: synced.title || title,
        existed: true,
      };
    }

    return {
      document_id: "",
      title,
      existed: false,
    };
  }

  async function ensureMeetingDocument({ accessToken, accountId, projectKey, projectName, meetingType, chatId }) {
    const existing = await resolveMeetingDocumentTarget({ accountId, projectKey, projectName, meetingType, chatId });
    if (existing.document_id) {
      return existing;
    }

    const created = await deps.createDocument(accessToken, existing.title, meetingDocFolderToken || undefined);
    deps.saveMeetingDocumentMapping({
      accountId,
      projectKey,
      projectName,
      meetingType,
      documentId: created.document_id,
      title: created.title || existing.title,
      chatId,
    });
    return {
      document_id: created.document_id,
      title: created.title || existing.title,
      existed: false,
      created: true,
    };
  }

  async function prependMeetingEntry({ accessToken, documentId, content }) {
    const current = await deps.getDocument(accessToken, documentId);
    const normalizedCurrent = normalizeText(current.content || "");
    const normalizedIncoming = normalizeText(content);
    if (normalizedCurrent.includes(normalizedIncoming)) {
      return {
        document_id: documentId,
        deduplicated: true,
        revision_id: current.revision_id || null,
      };
    }

    const nextContent = normalizedCurrent
      ? `${normalizedIncoming}\n\n${normalizedCurrent}`
      : normalizedIncoming;

    const result = await deps.updateDocument(accessToken, documentId, nextContent, "replace");
    return {
      ...result,
      deduplicated: false,
    };
  }

  async function updateWeeklyTodoTracker(summary, context) {
    const items = buildWeeklyTrackerPayload(summary, {
      ...context,
      existingItems: deps.listWeeklyTrackerItems(context.accountId, context.projectKey),
    });
    for (const item of items) {
      deps.upsertWeeklyTrackerItem(item);
    }
    return items;
  }

  async function processMeetingPreview({
    accountId,
    accessToken,
    transcriptText,
    metadata = {},
    chatId = "",
    groupChatId = "",
    projectName = "",
    sourceMeetingId = "",
  }) {
    const text = normalizeText(transcriptText);
    if (!text) {
      throw new Error("missing_meeting_content");
    }

    const classification = classifyMeeting({ text, metadata });
    const summary = await buildMeetingSummary({ text, metadata, classification });
    const identity = projectName
      ? { project_name: projectName, project_key: normalizeProjectKey(projectName) }
      : buildStableProjectIdentity({ text, metadata, chatId });
    const targetGroupId = normalizeText(groupChatId) || meetingDefaultChatId || chatId;

    if (!targetGroupId) {
      throw new Error("missing_meeting_group_chat_id");
    }

    const targetDoc = await resolveMeetingDocumentTarget({
      accountId,
      projectKey: identity.project_key,
      projectName: identity.project_name,
      meetingType: classification.meeting_type,
      chatId,
    });

    const summaryContent = buildMeetingGroupMessage({
      meeting_type: classification.meeting_type,
      summary,
    });
    const resolvedSourceMeetingId = sourceMeetingId || crypto.randomUUID();
    const docEntryContent = classification.meeting_type === "weekly"
      ? buildWeeklyMeetingDocEntry(summary)
      : buildGeneralMeetingDocEntry(summary);
    const weeklyTodos = classification.meeting_type === "weekly"
      ? buildWeeklyTrackerPayload(summary, {
          projectKey: identity.project_key,
          accountId,
          sourceDate: summary.time,
          sourceMeetingId: resolvedSourceMeetingId,
          transcriptText: text,
          existingItems: deps.listWeeklyTrackerItems(accountId, identity.project_key),
        })
      : [];
    const confirmation = await deps.createConfirmation({
      accountId,
      projectKey: identity.project_key,
      projectName: identity.project_name,
      meetingType: classification.meeting_type,
      chatId: targetGroupId,
      summaryContent,
      docEntryContent,
      targetDocumentId: targetDoc.document_id,
      targetDocumentTitle: targetDoc.title,
      sourceMeetingId: resolvedSourceMeetingId,
      sourceDate: summary.time,
      weeklyTodos,
    });
    const sent = await deps.sendMessage(accessToken, targetGroupId, summaryContent, {
      receiveIdType: "chat",
      cardPayload: buildMeetingConfirmationCard({
        meetingType: classification.meeting_type,
        summaryContent,
        confirmationId: confirmation.confirmation_id,
        accountId,
        projectName: identity.project_name,
      }),
    });

    return {
      meeting_type: classification.meeting_type,
      summary,
      summary_content: summaryContent,
      project_name: identity.project_name,
      project_key: identity.project_key,
      target_group_chat_id: targetGroupId,
      target_document: targetDoc,
      group_message: sent,
      confirmation,
      workflow_state: "pending_confirmation",
    };
  }

  async function confirmMeetingWrite({
    accountId,
    accessToken,
    confirmationId,
  }) {
    const confirmation = await deps.consumeConfirmation({
      confirmationId,
      accountId,
    });
    if (!confirmation) {
      return null;
    }

    const targetDoc = confirmation.target_document_id
      ? {
          document_id: confirmation.target_document_id,
          title: confirmation.target_document_title || buildMeetingDocTitle(confirmation.project_name, confirmation.meeting_type),
        }
      : await ensureMeetingDocument({
          accessToken,
          accountId,
          projectKey: confirmation.project_key,
          projectName: confirmation.project_name,
          meetingType: confirmation.meeting_type,
          chatId: confirmation.chat_id,
        });

    const writeResult = await prependMeetingEntry({
      accessToken,
      documentId: targetDoc.document_id,
      content: confirmation.doc_entry_content,
    });

    deps.saveMeetingDocumentMapping({
      accountId,
      projectKey: confirmation.project_key,
      projectName: confirmation.project_name,
      meetingType: confirmation.meeting_type,
      documentId: targetDoc.document_id,
      title: targetDoc.title,
      chatId: confirmation.chat_id,
    });

    let trackerUpdates = [];
    if (confirmation.meeting_type === "weekly" && Array.isArray(confirmation.weekly_todos)) {
      trackerUpdates = await updateWeeklyTodoTracker(
        {
          todos: confirmation.weekly_todos.map((item) => ({
            title: item.title,
            owner: item.owner,
            objective: item.objective,
            kr: item.kr,
          })),
        },
        {
          projectKey: confirmation.project_key,
          accountId,
          sourceDate: confirmation.source_date,
          sourceMeetingId: confirmation.source_meeting_id,
          transcriptText: confirmation.summary_content,
        },
      );
    }

    return {
      confirmation_id: confirmationId,
      meeting_type: confirmation.meeting_type,
      project_name: confirmation.project_name,
      project_key: confirmation.project_key,
      target_document: {
        document_id: targetDoc.document_id,
        title: targetDoc.title,
      },
      write_result: writeResult,
      tracker_updates: trackerUpdates,
      workflow_state: "doc_written",
    };
  }

  return {
    processMeetingPreview,
    confirmMeetingWrite,
    resolveMeetingDocumentTarget,
    prependMeetingEntry,
    updateWeeklyTodoTracker,
  };
}

export {
  parseMeetingCommand,
  buildGeneralMeetingDocEntry,
  buildWeeklyMeetingDocEntry,
  buildStableProjectIdentity,
  extractMeetingDate,
  extractParticipants,
};
