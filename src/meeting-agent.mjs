import crypto from "node:crypto";
import db from "./db.mjs";
import {
  agentPromptEmergencyRatio,
  agentPromptLightRatio,
  agentPromptRollingRatio,
  llmApiKey,
  llmBaseUrl,
  llmModel,
  llmTemperature,
  llmTopP,
  meetingDefaultChatId,
  meetingConfirmPath,
  meetingDocFolderToken,
  meetingPromptMaxTokens,
  meetingSummaryJsonRetryMax,
  oauthBaseUrl,
} from "./config.mjs";
import {
  consumeMeetingWriteConfirmation,
  createMeetingWriteConfirmation,
  peekMeetingWriteConfirmation,
} from "./doc-update-confirmations.mjs";
import { buildCompactSystemPrompt, governPromptSections, trimTextForBudget } from "./agent-token-governance.mjs";
import { callOpenClawTextGeneration } from "./openclaw-text-service.mjs";
import {
  createManagedDocument,
  ensureDocumentManagerPermission,
  getDocument,
  sendMessage,
  updateDocument,
} from "./lark-content.mjs";
import { registerKnowledgeWriteback } from "./executive-closed-loop.mjs";
import { EVIDENCE_TYPES, verifyMeetingWorkflowCompletion } from "./executive-verifier.mjs";
import { normalizeText, nowIso } from "./text-utils.mjs";
import { decideWriteGuard } from "./write-guard.mjs";
import { buildMeetingConfirmWritePolicy } from "./write-policy-contract.mjs";

const WEEKLY_PROGRESS_KEYWORDS = ["進展", "推进", "推進", "完成度", "完成", "達成", "okr", "kr", "目標", "objective"];
const WEEKLY_ISSUE_KEYWORDS = ["卡點", "阻塞", "問題", "风险", "風險", "瓶頸"];
const WEEKLY_SOLUTION_KEYWORDS = ["解法", "方案", "決定", "處理", "修復", "對策"];
const WEEKLY_TODO_KEYWORDS = ["todo", "待辦", "待办", "owner", "下週", "本週", "跟進", "跟进", "action item"];
const GENERAL_CONCLUSION_KEYWORDS = ["結論", "结论", "決定", "决定", "共識", "共识", "確認", "确认"];

function buildWriteGuardMessage(guard = {}) {
  if (guard.reason === "policy_enforcement_blocked") {
    return normalizeText(guard?.policy_enforcement?.message) || "External write is blocked by write policy enforcement.";
  }
  if (guard.reason === "confirmation_required") {
    return "External write requires explicit confirmation before apply.";
  }
  if (guard.reason === "preview_write_blocked") {
    return "Preview mode cannot execute external writes.";
  }
  if (guard.reason === "verifier_incomplete") {
    return "External write is blocked until preview/review verification is complete.";
  }
  return "External write is blocked by write guard.";
}
const DONE_KEYWORDS = ["完成", "已完成", "done", "結案", "close"];
const MEETING_WAKE_WORDS = ["會議", "会议", "meeting"];
const MEETING_TOPIC_SIGNALS = ["會議", "会议", "meeting", "週會", "周会", "例會", "例会"];
const MEETING_PARTICIPATION_SIGNALS = ["參會", "参会", "與會", "与会", "一起參會", "一起参会"];
const MEETING_START_SIGNALS = [
  "我要開會了",
  "我要开会了",
  "請記錄吧",
  "请记录吧",
  "請記錄",
  "请记录",
  "現在正要開始",
  "现在正要开始",
  "開始開會",
  "开始开会",
  "開始會議",
  "开始会议",
  "準備開會",
  "准备开会",
  "請準備記錄",
  "请准备记录",
  "準備記錄",
  "准备记录",
  "進入會議模式",
  "进入会议模式",
  "開始記錄會議",
  "开始记录会议",
];
const OFFLINE_MEETING_CONTEXT_SIGNALS = [
  "線下會議",
  "线下会议",
  "現場會議",
  "现场会议",
  "okr 周例會",
  "okr 周例会",
  "okr 週例會",
  "okr 週例会",
];
const MEETING_CALENDAR_START_SIGNALS = [
  "開始旁聽這場會議",
  "开始旁听这场会议",
  "開始旁聽這個會議",
  "开始旁听这个会议",
  "旁聽這場會議",
  "旁听这场会议",
  "開始跟這場會議",
  "开始跟这场会议",
];
const MEETING_STOP_SIGNALS = [
  "會議結束了",
  "会议结束了",
  "結束會議",
  "结束会议",
  "停止記錄",
  "停止记录",
  "停止會議記錄",
  "停止会议记录",
  "先結束會議",
  "先结束会议",
];
const MEETING_NOTE_SIGNALS = [
  "記錄",
  "记录",
  "紀錄",
  "紀要",
  "纪要",
  "逐字稿",
  "整理會議",
  "整理会议",
  "同步記錄",
  "同步记录",
];
const MEETING_CONFIRM_SIGNALS = [
  "確認",
  "确认",
  "同意後",
  "同意后",
  "確認後",
  "确认后",
  "寫進",
  "写进",
  "寫入",
  "写入",
  "第二部分",
  "文檔",
  "文档",
];

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
  const wakeText = normalized.toLowerCase();
  if (MEETING_WAKE_WORDS.includes(wakeText)) {
    return {
      action: "start_capture",
      content: "",
      wake_source: "menu_button",
    };
  }

  if (looksLikeMeetingStartIntent(normalized)) {
    return {
      action: "start_capture",
      content: "",
      wake_source: "natural_language_start",
    };
  }

  if (looksLikeCalendarMeetingStartIntent(normalized)) {
    return {
      action: "start_capture_calendar",
      content: "",
      wake_source: "natural_language_calendar_start",
    };
  }

  if (looksLikeMeetingStopIntent(normalized)) {
    return {
      action: "stop_capture",
      content: "",
      wake_source: "natural_language_stop",
    };
  }

  if (looksLikeNaturalLanguageMeetingIntent(normalized)) {
    return {
      action: "start_capture",
      content: "",
      wake_source: "natural_language_intent",
    };
  }

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

  if (/^\/meeting\s+(stop|end|finish)\s*$/i.test(normalized)) {
    return {
      action: "stop_capture",
      content: "",
      wake_source: "slash_stop",
    };
  }

  if (/^\/meeting\s+(current|calendar|listen)\s*$/i.test(normalized)) {
    return {
      action: "start_capture_calendar",
      content: "",
      wake_source: "slash_calendar_start",
    };
  }

  if (/^\/meeting\s+start\s*$/i.test(normalized)) {
    return {
      action: "start_capture",
      content: "",
      wake_source: "slash_start",
    };
  }

  return {
    action: "process",
    content: normalized.replace(/^\/meeting\s*/u, "").trim(),
  };
}

function hasSignal(text, signals = []) {
  return signals.some((signal) => text.includes(signal));
}

function looksLikeNaturalLanguageMeetingIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }
  const topicHits = collectSignalCount(normalized, MEETING_TOPIC_SIGNALS);
  const noteHits = collectSignalCount(normalized, MEETING_NOTE_SIGNALS);
  const confirmHits = collectSignalCount(normalized, MEETING_CONFIRM_SIGNALS);
  if (topicHits >= 1 && noteHits >= 1 && confirmHits >= 1) {
    return true;
  }
  return hasSignal(normalized, MEETING_PARTICIPATION_SIGNALS) && noteHits >= 1;
}

function looksLikeMeetingStartIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }
  if (hasSignal(normalized, MEETING_START_SIGNALS)) {
    return true;
  }
  const hasOfflineMeetingContext = hasSignal(normalized, OFFLINE_MEETING_CONTEXT_SIGNALS);
  const hasMeetingTopic = collectSignalCount(normalized, MEETING_TOPIC_SIGNALS) >= 1;
  const hasMeetingNotes = collectSignalCount(normalized, MEETING_NOTE_SIGNALS) >= 1;
  return hasOfflineMeetingContext && (hasMeetingTopic || hasMeetingNotes);
}

function looksLikeMeetingStopIntent(text) {
  const normalized = normalizeText(text);
  return Boolean(normalized) && hasSignal(normalized, MEETING_STOP_SIGNALS);
}

function looksLikeCalendarMeetingStartIntent(text) {
  const normalized = normalizeText(text);
  return Boolean(normalized) && hasSignal(normalized, MEETING_CALENDAR_START_SIGNALS);
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
    throw new Error("meeting_summary_missing_json_object");
  }

  try {
    return JSON.parse(normalized.slice(start, end + 1));
  } catch (error) {
    throw new Error(`meeting_summary_invalid_json:${error.message}`);
  }
}

function buildMeetingSummaryPrompt({ text, metadata = {}, classification }) {
  const systemPrompt = buildCompactSystemPrompt("你是會議整理助手。", [
    "只輸出 JSON。",
    "不要補充未提及內容。",
    classification.meeting_type === "weekly"
      ? "weekly 只輸出 progress、issues、solutions、todos。"
      : "general 只輸出 time、participants、main_points、conclusions、todos。",
  ]);

  const schemaText =
    classification.meeting_type === "weekly"
      ? `輸出 JSON：{"progress":["..."],"issues":["..."],"solutions":["..."],"todos":[{"owner":"...","title":"...","objective":"...","kr":"..."}]}`
      : `輸出 JSON：{"time":"YYYYMMDD或待確認","participants":["..."],"main_points":["..."],"conclusions":["..."],"todos":[{"owner":"...","title":"..."}]}`;

  const governed = governPromptSections({
    systemPrompt,
    format: "xml",
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
            ? "判定已完成。請只整理 KR 推進相關核心，不寫流水帳，不補充 CEO 支援事項；如果資訊不足，保留待確認而不是猜測。"
            : "判定已完成。請只整理會議核心，不補充未提及內容；如果資訊不足，保留待確認而不是猜測。",
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

  return {
    systemPrompt,
    prompt: governed.prompt,
  };
}

function buildMeetingSummaryRepairPrompt({ originalPrompt, malformedResponse, reason, classification }) {
  const governed = governPromptSections({
    systemPrompt: buildCompactSystemPrompt("你是會議整理 JSON 修復器。", [
      "你只能輸出合法 JSON。",
      "不能補充未提及內容。",
    ]),
    format: "xml",
    maxTokens: meetingPromptMaxTokens,
    thresholds: {
      light: agentPromptLightRatio,
      rolling: agentPromptRollingRatio,
      emergency: agentPromptEmergencyRatio,
    },
    sections: [
      {
        name: "repair_goal",
        label: "repair_goal",
        text:
          classification.meeting_type === "weekly"
            ? '修復上一輪輸出，返回合法 JSON：{"progress":["..."],"issues":["..."],"solutions":["..."],"todos":[{"owner":"...","title":"...","objective":"...","kr":"..."}]}'
            : '修復上一輪輸出，返回合法 JSON：{"time":"YYYYMMDD或待確認","participants":["..."],"main_points":["..."],"conclusions":["..."],"todos":[{"owner":"...","title":"..."}]}',
        required: true,
        maxTokens: 180,
      },
      {
        name: "repair_reason",
        label: "repair_reason",
        text: reason,
        required: true,
        maxTokens: 120,
      },
      {
        name: "malformed_response",
        label: "malformed_response",
        text: trimTextForBudget(malformedResponse, 1200, { preserveTail: true }),
        required: true,
        maxTokens: 360,
      },
      {
        name: "original_prompt",
        label: "original_prompt",
        text: originalPrompt,
        required: true,
        maxTokens: meetingPromptMaxTokens - 720,
      },
    ],
  });

  return governed.prompt;
}

async function requestMeetingSummaryJson({ systemPrompt, prompt }) {
  if (!llmApiKey) {
    return callOpenClawTextGeneration({
      systemPrompt,
      prompt,
      sessionIdSuffix: "meeting-summary",
    });
  }

  const response = await fetch(`${llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llmApiKey}`,
    },
    body: JSON.stringify({
      model: llmModel,
      temperature: llmTemperature,
      top_p: llmTopP,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `meeting_summary_llm_failed:${response.status}`);
  }
  return data.choices?.[0]?.message?.content || "";
}

async function generateMeetingSummaryWithModel({ text, metadata = {}, classification }) {
  const promptInput = buildMeetingSummaryPrompt({ text, metadata, classification });
  let prompt = promptInput.prompt;

  for (let attempt = 0; attempt <= meetingSummaryJsonRetryMax; attempt += 1) {
    let rawResponse = "";
    try {
      rawResponse = await requestMeetingSummaryJson({
        systemPrompt: promptInput.systemPrompt,
        prompt,
      });
      return extractJsonPayload(rawResponse);
    } catch (error) {
      if (attempt >= meetingSummaryJsonRetryMax) {
        return null;
      }
      prompt = buildMeetingSummaryRepairPrompt({
        originalPrompt: promptInput.prompt,
        malformedResponse: rawResponse,
        reason: error?.message || "meeting_summary_unknown_error",
        classification,
      });
    }
  }

  return null;
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

function normalizeActionItems(todos = [], defaultDeadline = "待確認") {
  const items = Array.isArray(todos) ? todos : [];
  return items
    .map((item) => ({
      title: normalizeText(item?.title),
      owner: normalizeOwner(item?.owner),
      deadline: normalizeText(item?.deadline) || defaultDeadline,
      objective: normalizeText(item?.objective),
      kr: normalizeText(item?.kr),
    }))
    .filter((item) => item.title)
    .slice(0, 8);
}

function inferMeetingConflicts(text = "", summary = {}, classification = {}) {
  const lines = splitLines(text);
  const summaryLines = classification.meeting_type === "weekly"
    ? [...(summary.issues || []), ...(summary.solutions || [])]
    : [...(summary.conclusions || []), ...(summary.main_points || [])];
  return dedupe(
    [...lines, ...summaryLines].filter((line) => /(衝突|冲突|不一致|矛盾|待確認|待确认|爭議|争议)/i.test(line)),
  ).slice(0, 6);
}

function buildMeetingKnowledgeWriteback({ summary = {}, classification = {}, projectName = "", conflicts = [] } = {}) {
  const tags = ["meeting", classification.meeting_type || "general", normalizeProjectKey(projectName || "shared")];
  const decisions = classification.meeting_type === "weekly"
    ? dedupe([...(summary.solutions || []), ...(summary.progress || [])]).slice(0, 4)
    : dedupe(summary.conclusions || []).slice(0, 4);
  const proposals = decisions.map((item, index) => ({
    title: `${projectName || "meeting"}_${classification.meeting_type || "general"}_decision_${index + 1}`,
    content: item,
    tags,
    evidence: [{ type: EVIDENCE_TYPES.summary_generated, summary: "meeting_summary" }],
  }));
  return {
    required: Boolean(proposals.length || conflicts.length),
    proposals,
    approved_items: [],
    conflict_candidates: conflicts,
  };
}

export function buildMeetingStructuredResult({
  summary = {},
  classification = {},
  transcriptText = "",
  metadata = {},
  projectName = "",
} = {}) {
  const actionItems = normalizeActionItems(summary.todos, normalizeText(metadata.deadline) || "待確認");
  const decisions = classification.meeting_type === "weekly"
    ? dedupe(summary.solutions || []).slice(0, 5)
    : dedupe(summary.conclusions || []).slice(0, 5);
  const risks = classification.meeting_type === "weekly"
    ? dedupe(summary.issues || []).slice(0, 5)
    : dedupe((summary.main_points || []).filter((item) => /(風險|风险|阻塞|卡點|依賴|依赖)/i.test(item))).slice(0, 5);
  const owners = dedupe(actionItems.map((item) => item.owner)).slice(0, 8);
  const deadlines = dedupe(actionItems.map((item) => item.deadline)).slice(0, 8);
  const openQuestions = dedupe([
    ...actionItems.filter((item) => item.owner === "待確認").map((item) => `待確認 owner：${item.title}`),
    ...actionItems.filter((item) => item.deadline === "待確認").map((item) => `待確認 deadline：${item.title}`),
    ...(Array.isArray(summary.participants) && summary.participants.includes("待確認") ? ["與會人員待確認"] : []),
  ]).slice(0, 8);
  const conflicts = inferMeetingConflicts(transcriptText, summary, classification);
  const knowledgeWriteback = buildMeetingKnowledgeWriteback({
    summary,
    classification,
    projectName,
    conflicts,
  });
  return {
    meeting_type: classification.meeting_type || "general",
    summary: buildMeetingGroupMessage({
      meeting_type: classification.meeting_type || "general",
      summary,
    }),
    decisions,
    action_items: actionItems,
    owner: owners,
    deadline: deadlines,
    risks,
    open_questions: openQuestions,
    conflicts,
    knowledge_writeback: knowledgeWriteback,
    task_writeback: {
      items: actionItems.map((item) => ({
        title: item.title,
        owner: item.owner,
        deadline: item.deadline,
      })),
    },
    follow_up_recommendations: dedupe([
      openQuestions.length ? "先把 owner 與 deadline 補齊，再正式落進追蹤系統。" : "",
      conflicts.length ? "這場會議裡有衝突或待確認內容，建議先走 proposal/conflict queue。" : "",
      decisions.length ? "可把已確認決策轉成知識提案，避免只留在會議紀要裡。" : "",
    ]).slice(0, 5),
  };
}

function buildMeetingVerification({ structuredResult = {}, summaryContent = "", extraEvidence = [] } = {}) {
  return verifyMeetingWorkflowCompletion({
    summaryContent,
    structuredResult,
    extraEvidence,
  });
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
    createDocument: createManagedDocument,
    updateDocument,
    createConfirmation: createMeetingWriteConfirmation,
    peekConfirmation: peekMeetingWriteConfirmation,
    consumeConfirmation: consumeMeetingWriteConfirmation,
    getMappedMeetingDocument,
    saveMeetingDocumentMapping,
    findSyncedMeetingDocument,
    listWeeklyTrackerItems,
    upsertWeeklyTrackerItem,
    logger: null,
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

  async function ensureMeetingDocument({
    accessToken,
    accountId,
    accountOpenId = "",
    projectKey,
    projectName,
    meetingType,
    chatId,
  }) {
    const existing = await resolveMeetingDocumentTarget({ accountId, projectKey, projectName, meetingType, chatId });
    if (existing.document_id) {
      await ensureDocumentManagerPermission(accessToken, existing.document_id, {
        tokenType: "user",
        managerOpenId: accountOpenId,
      });
      return existing;
    }

    const created = await deps.createDocument(
      accessToken,
      existing.title,
      meetingDocFolderToken || undefined,
      {
        tokenType: "user",
        managerOpenId: accountOpenId,
        source: "meeting_confirm_write",
      },
    );
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
    const structuredResult = buildMeetingStructuredResult({
      summary,
      classification,
      transcriptText: text,
      metadata,
      projectName: identity.project_name,
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
    const verification = buildMeetingVerification({
      structuredResult,
      summaryContent,
      extraEvidence: [
        {
          type: EVIDENCE_TYPES.API_call_success,
          summary: "meeting_group_message_sent",
        },
      ],
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
      structured_result: structuredResult,
      verification,
      workflow_state: "awaiting_confirmation",
    };
  }

  async function renderMeetingMinutes({
    accountId,
    transcriptText,
    metadata = {},
    chatId = "",
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
    const resolvedSourceMeetingId = sourceMeetingId || crypto.randomUUID();
    const docEntryContent = classification.meeting_type === "weekly"
      ? buildWeeklyMeetingDocEntry(summary)
      : buildGeneralMeetingDocEntry(summary);
    const weeklyTodos = classification.meeting_type === "weekly" && accountId
      ? buildWeeklyTrackerPayload(summary, {
          projectKey: identity.project_key,
          accountId,
          sourceDate: summary.time,
          sourceMeetingId: resolvedSourceMeetingId,
          transcriptText: text,
          existingItems: deps.listWeeklyTrackerItems(accountId, identity.project_key),
        })
      : [];

    const structuredResult = buildMeetingStructuredResult({
      summary,
      classification,
      transcriptText: text,
      metadata,
      projectName: identity.project_name,
    });

    return {
      meeting_type: classification.meeting_type,
      summary,
      summary_content: buildMeetingGroupMessage({
        meeting_type: classification.meeting_type,
        summary,
      }),
      doc_entry_content: docEntryContent,
      weekly_todos: weeklyTodos,
      project_name: identity.project_name,
      project_key: identity.project_key,
      source_meeting_id: resolvedSourceMeetingId,
      structured_result: structuredResult,
      verification: buildMeetingVerification({
        structuredResult,
        summaryContent: buildMeetingGroupMessage({
          meeting_type: classification.meeting_type,
          summary,
        }),
      }),
    };
  }

  async function confirmMeetingWrite({
    accountId,
    accountOpenId = "",
    accessToken,
    confirmationId,
    logger = deps.logger,
  }) {
    const pendingConfirmation = await deps.peekConfirmation({
      confirmationId,
      accountId,
    });
    if (!pendingConfirmation) {
      return null;
    }

    const writePolicy = buildMeetingConfirmWritePolicy({
      confirmationId,
      targetDocumentId: pendingConfirmation.target_document_id,
    });
    const writeGuard = decideWriteGuard({
      externalWrite: true,
      confirmed: Boolean(confirmationId),
      verifierCompleted: Boolean(
        normalizeText(pendingConfirmation.summary_content)
        && normalizeText(pendingConfirmation.doc_entry_content),
      ),
      pathname: "/api/meeting/confirm",
      writePolicy,
      scopeKey: writePolicy.scope_key,
      logger,
      owner: "meeting_agent",
      workflow: "meeting",
      operation: "meeting_confirm_write",
      details: {
        account_id: accountId,
        confirmation_id: confirmationId || null,
        project_key: pendingConfirmation.project_key || null,
        target_document_id: pendingConfirmation.target_document_id || null,
        write_policy: writePolicy,
      },
    });
    if (!writeGuard.allow) {
      return {
        ok: false,
        error: "write_guard_denied",
        message: buildWriteGuardMessage(writeGuard),
        write_guard: writeGuard,
      };
    }

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
          accountOpenId,
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

    const structuredResult = buildMeetingStructuredResult({
      summary: confirmation.meeting_type === "weekly"
        ? sanitizeWeeklySummary({
            todos: confirmation.weekly_todos,
          }, confirmation.summary_content, {
            date: confirmation.source_date,
          })
        : sanitizeGeneralSummary({}, confirmation.summary_content, {
            date: confirmation.source_date,
          }),
      classification: {
        meeting_type: confirmation.meeting_type,
      },
      transcriptText: confirmation.summary_content,
      metadata: {
        date: confirmation.source_date,
      },
      projectName: confirmation.project_name,
    });
    const proposalRecords = await registerKnowledgeWriteback({
      accountId,
      sessionKey: confirmation.chat_id || accountId,
      taskId: confirmationId,
      writeback: structuredResult.knowledge_writeback,
    });
    structuredResult.knowledge_writeback.proposal_ids = proposalRecords.map((item) => item.id).filter(Boolean);
    const verification = buildMeetingVerification({
      structuredResult,
      summaryContent: confirmation.summary_content,
      extraEvidence: [
        {
          type: EVIDENCE_TYPES.file_updated,
          summary: `document:${targetDoc.document_id}`,
        },
        {
          type: EVIDENCE_TYPES.DB_write_confirmed,
          summary: "meeting_document_mapping_saved",
        },
        ...(proposalRecords.length
          ? [
              {
                type: EVIDENCE_TYPES.knowledge_proposal_created,
                summary: `knowledge_proposals:${proposalRecords.length}`,
              },
            ]
          : []),
      ],
    });

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
      structured_result: structuredResult,
      knowledge_proposals: proposalRecords,
      verification,
      workflow_state: "writing_back",
    };
  }

  return {
    processMeetingPreview,
    confirmMeetingWrite,
    renderMeetingMinutes,
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
