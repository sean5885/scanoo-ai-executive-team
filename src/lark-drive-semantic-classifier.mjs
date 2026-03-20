import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { buildCompactSystemPrompt, governPromptSections, trimTextForBudget } from "./agent-token-governance.mjs";
import {
  agentPromptEmergencyRatio,
  agentPromptLightRatio,
  agentPromptRollingRatio,
  llmModel,
  semanticClassifierPromptMaxTokens,
  semanticClassifierJsonRetryMax,
} from "./config.mjs";
import { normalizeText } from "./text-utils.mjs";

const execFile = promisify(execFileCb);

export const CATEGORIES = [
  "工程技術",
  "產品需求",
  "OKR與計畫",
  "財務報銷",
  "市場業務",
  "人事行政",
  "法務合約",
  "投資公司",
  "文檔",
  "表格",
  "簡報",
  "附件",
  "快捷方式",
  "腦圖",
  "其他",
];

const CACHE_PATH =
  process.env.SEMANTIC_CLASSIFIER_CACHE ||
  path.resolve(process.cwd(), ".data/lark-drive-semantic-cache.json");
const MAX_CONTENT_CHARS = Number.parseInt(process.env.SEMANTIC_CLASSIFIER_MAX_CHARS || "900", 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.SEMANTIC_CLASSIFIER_TIMEOUT_MS || "75000", 10);
const MAX_ITEMS_PER_RUN = Number.parseInt(process.env.SEMANTIC_CLASSIFIER_MAX_ITEMS || "24", 10);
const PROVIDER = process.env.SEMANTIC_CLASSIFIER_PROVIDER || "openclaw";
const OPENCLAW_AGENT_ID = process.env.SEMANTIC_CLASSIFIER_OPENCLAW_AGENT || "main";
const OPENCLAW_SESSION_ID =
  process.env.SEMANTIC_CLASSIFIER_OPENCLAW_SESSION || "lark-semantic-classifier-v1";

function ensureCacheDir() {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
}

function loadCache() {
  ensureCacheDir();
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  ensureCacheDir();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function hashInput(title, text) {
  return crypto.createHash("sha256").update(`${title}\n---\n${text}`).digest("hex");
}

function summarizeText(text) {
  return normalizeText(text).slice(0, MAX_CONTENT_CHARS);
}

function computeAdaptiveItemChars(itemCount) {
  const safeCount = Math.max(1, Number(itemCount || 1));
  const adaptive = Math.floor((semanticClassifierPromptMaxTokens * 4 * 0.68) / safeCount);
  return Math.max(220, Math.min(MAX_CONTENT_CHARS, adaptive));
}

function stripCodeFences(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("```")) {
    return raw;
  }
  return raw.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim();
}

function parseBatchResponse(text) {
  const raw = stripCodeFences(text);
  const match = raw.match(/\{[\s\S]*\}$/);
  const jsonText = match ? match[0] : raw;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`semantic_classifier_invalid_json:${error.message}`);
  }
  const rows = Array.isArray(parsed.results) ? parsed.results : [];
  return rows
    .map((row) => ({
      id: String(row.id || "").trim(),
      category: String(row.category || "").trim(),
      confidence: Number(row.confidence || 0),
      reason: String(row.reason || "").trim(),
    }))
    .filter((row) => row.id && CATEGORIES.includes(row.category));
}

function validateBatchRows(rows, items) {
  const rowById = new Map();
  for (const row of rows) {
    if (rowById.has(row.id)) {
      throw new Error(`semantic_classifier_duplicate_id:${row.id}`);
    }
    rowById.set(row.id, row);
  }

  const missing = items.map((item) => item.id).filter((id) => !rowById.has(id));
  if (missing.length) {
    throw new Error(`semantic_classifier_missing_rows:${missing.join(",")}`);
  }

  return items.map((item) => rowById.get(item.id)).filter(Boolean);
}

function buildPrompt(items) {
  const docs = items.map((item) => {
    const text = trimTextForBudget(item.text, computeAdaptiveItemChars(items.length), {
      keywords: [item.title, item.parent_path, item.type],
    });
    return [
      `ID: ${item.id}`,
      `Title: ${item.title}`,
      `Type: ${item.type}`,
      `Path: ${item.parent_path}`,
      "Content Summary:",
      text,
    ].join("\n");
  });

  const governed = governPromptSections({
    systemPrompt: buildCompactSystemPrompt("你是企業知識文件分類器。", [
      "根據文件標題、路徑與內容摘要判斷語義分類。",
      "證據不足時也必須選出最接近的固定分類並說明原因。",
    ]),
    format: "xml",
    maxTokens: semanticClassifierPromptMaxTokens,
    thresholds: {
      light: agentPromptLightRatio,
      rolling: agentPromptRollingRatio,
      emergency: agentPromptEmergencyRatio,
    },
    sections: [
      {
        name: "task_goal",
        label: "task_goal",
        text: [
          "請根據每份文件的標題、目前所在路徑、正文摘要做語義分類。",
          "不要只看檔名，要優先理解正文內容。",
          `分類只能從以下固定分類中選一個：${CATEGORIES.join("、")}`,
          '格式必須是：{"results":[{"id":"...","category":"...","confidence":0.0,"reason":"..."}]}',
          "每個輸入文件都必須返回一列結果。",
          "只回 JSON，不要任何額外文字。",
        ].join("\n"),
        required: true,
        maxTokens: 180,
      },
      {
        name: "documents",
        label: "documents",
        text: docs.join("\n\n---\n\n"),
        summaryText: docs
          .map((doc) => trimTextForBudget(doc, 240))
          .join("\n\n"),
        required: true,
        maxTokens: semanticClassifierPromptMaxTokens - 220,
      },
    ],
  });

  return governed.prompt;
}

function buildRepairPrompt(items, malformedResponse, reason) {
  const governed = governPromptSections({
    systemPrompt: buildCompactSystemPrompt("你是企業知識文件分類器的 JSON 修復器。", [
      "你只能修正成合法 JSON。",
      "不能省略任何文件結果，也不能增加額外說明。",
    ]),
    format: "xml",
    maxTokens: semanticClassifierPromptMaxTokens,
    thresholds: {
      light: agentPromptLightRatio,
      rolling: agentPromptRollingRatio,
      emergency: agentPromptEmergencyRatio,
    },
    sections: [
      {
        name: "repair_goal",
        label: "repair_goal",
        text: [
          "修復上一輪分類結果，輸出合法 JSON。",
          `合法分類只能使用：${CATEGORIES.join("、")}`,
          "你必須為每個文件 id 返回一列結果。",
          '格式必須是：{"results":[{"id":"...","category":"...","confidence":0.0,"reason":"..."}]}',
          "不要輸出 Markdown、解釋或程式碼框。",
        ].join("\n"),
        required: true,
        maxTokens: 160,
      },
      {
        name: "repair_reason",
        label: "repair_reason",
        text: reason,
        required: true,
        maxTokens: 120,
      },
      {
        name: "required_document_ids",
        label: "required_document_ids",
        text: items.map((item) => item.id).join("\n"),
        required: true,
        maxTokens: 120,
      },
      {
        name: "malformed_response",
        label: "malformed_response",
        text: trimTextForBudget(malformedResponse, 1400, { preserveTail: true }),
        required: true,
        maxTokens: 400,
      },
      {
        name: "original_request",
        label: "original_request",
        text: buildPrompt(items),
        required: true,
        maxTokens: semanticClassifierPromptMaxTokens - 860,
      },
    ],
  });

  return governed.prompt;
}

async function callViaOpenClaw(prompt) {
  const { stdout } = await execFile(
    "openclaw",
    [
      "agent",
      "--agent",
      OPENCLAW_AGENT_ID,
      "--session-id",
      OPENCLAW_SESSION_ID,
      "--thinking",
      "off",
      "--timeout",
      String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
      "--json",
      "--message",
      prompt,
    ],
    {
      cwd: process.cwd(),
      timeout: REQUEST_TIMEOUT_MS + 3000,
      maxBuffer: 1024 * 1024 * 8,
    },
  );

  const outer = JSON.parse(stdout);
  const payloadText = outer?.result?.payloads?.[0]?.text || "";
  if (!payloadText) {
    throw new Error("OpenClaw semantic classifier returned no payload text");
  }
  return payloadText;
}

async function callClassifier(prompt) {
  if (PROVIDER !== "openclaw") {
    throw new Error(`Unsupported semantic classifier provider: ${PROVIDER}`);
  }
  return callViaOpenClaw(prompt);
}

export async function classifyPendingItemsWithRetries(items, { classifier = callClassifier } = {}) {
  let prompt = buildPrompt(items);
  let lastError = null;

  for (let attempt = 0; attempt <= semanticClassifierJsonRetryMax; attempt += 1) {
    let content = "";
    try {
      content = await classifier(prompt);
      const rows = validateBatchRows(parseBatchResponse(content), items);
      return rows;
    } catch (error) {
      lastError = error;
      if (attempt >= semanticClassifierJsonRetryMax) {
        break;
      }
      prompt = buildRepairPrompt(items, content, error.message || "semantic_classifier_unknown_error");
    }
  }

  throw lastError || new Error("semantic_classifier_retry_exhausted");
}

export function classifyDocumentsLocally(items) {
  const rules = [
    { category: "工程技術", patterns: ["工程", "技術", "api", "系統", "架構", "程式", "開發", "sdk", "算法"] },
    { category: "產品需求", patterns: ["需求", "prd", "功能", "流程", "欄位", "驗收", "產品"] },
    { category: "OKR與計畫", patterns: ["okr", "計畫", "roadmap", "季度", "里程碑", "目標"] },
    { category: "財務報銷", patterns: ["報銷", "付款", "預算", "財務", "invoice", "發票"] },
    { category: "市場業務", patterns: ["市場", "銷售", "品牌", "商務", "客戶", "合作", "商業化"] },
    { category: "人事行政", patterns: ["人事", "招聘", "面試", "請假", "行政", "員工"] },
    { category: "法務合約", patterns: ["合約", "法務", "協議", "條款", "隱私", "專利"] },
    { category: "投資公司", patterns: ["投資", "董事會", "股東", "融資", "公司設立", "cap table"] },
    { category: "簡報", patterns: ["簡報", "deck", "ppt", "pitch"] },
    { category: "表格", patterns: ["表格", "sheet", "試算表"] },
    { category: "文檔", patterns: ["文件", "文檔", "doc", "wiki"] },
  ];

  const resolved = new Map();
  for (const item of items) {
    const haystack = `${item.title || ""}\n${item.parent_path || ""}\n${item.text || ""}`.toLowerCase();
    const match = rules.find((rule) => rule.patterns.some((pattern) => haystack.includes(pattern)));
    resolved.set(item.id, {
      category: match?.category || "其他",
      confidence: match ? 0.66 : 0.35,
      reason: match ? "local_rule_fallback" : "local_default",
      content_source: item.content_source || null,
    });
  }
  return resolved;
}

export async function classifyDocumentsSemantically(items) {
  const cache = loadCache();
  const resolved = new Map();
  const normalizedItems = Array.isArray(items) ? items : [];

  for (let start = 0; start < normalizedItems.length; start += MAX_ITEMS_PER_RUN) {
    const pending = [];
    for (const item of normalizedItems.slice(start, start + MAX_ITEMS_PER_RUN)) {
      const text = summarizeText(item.text || "");
      if (!text) {
        continue;
      }

      const cacheKey = hashInput(item.title, text);
      const cached = cache[cacheKey];
      if (cached?.category) {
        resolved.set(item.id, {
          category: cached.category,
          confidence: cached.confidence || 0,
          reason: cached.reason || "cached",
          content_source: item.content_source || null,
        });
        continue;
      }

      pending.push({
        ...item,
        text,
        cacheKey,
      });
    }

    if (!pending.length) {
      continue;
    }

    let rows = [];
    try {
      rows = await classifyPendingItemsWithRetries(pending);
    } catch {
      for (const [id, value] of classifyDocumentsLocally(pending)) {
        resolved.set(id, value);
      }
      continue;
    }

    for (const row of rows) {
      const source = pending.find((item) => item.id === row.id);
      if (!source) {
        continue;
      }
      cache[source.cacheKey] = row;
      resolved.set(source.id, {
        ...row,
        content_source: source.content_source || null,
      });
    }
  }

  saveCache(cache);
  return resolved;
}

export function semanticClassifierAvailable() {
  return Boolean(PROVIDER === "openclaw");
}

export function getSemanticClassifierInfo() {
  return {
    available: semanticClassifierAvailable(),
    provider: PROVIDER,
    model: `minimax/${llmModel} via OpenClaw`,
    cache_path: CACHE_PATH,
    host: os.hostname(),
    max_items_per_run: MAX_ITEMS_PER_RUN,
    max_content_chars: MAX_CONTENT_CHARS,
    timeout_ms: REQUEST_TIMEOUT_MS,
    openclaw_agent: OPENCLAW_AGENT_ID,
    openclaw_session_id: OPENCLAW_SESSION_ID,
  };
}
