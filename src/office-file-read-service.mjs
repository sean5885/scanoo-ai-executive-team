import JSZip from "jszip";
import mammoth from "mammoth";
import { readFile } from "node:fs/promises";
import * as XLSX from "xlsx";

import { llmApiKey, officeReadMaxBytes } from "./config.mjs";
import { downloadDriveFileBuffer, downloadMessageFileResourceBuffer } from "./lark-connectors.mjs";
import { generateText } from "./llm/generate-text.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { normalizeText } from "./text-utils.mjs";

const DEFAULT_MAX_BYTES = Number.isFinite(Number(officeReadMaxBytes)) && Number(officeReadMaxBytes) > 0
  ? Number(officeReadMaxBytes)
  : 30 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 24_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
const OFFICE_MODEL_CONTEXT_MAX_CHARS = 12_000;
const OFFICE_MODEL_DOC_MAX_CHARS = 4_000;
const OFFICE_MODEL_LIMITATION_MAX_ITEMS = 4;
const OFFICE_WORKBOOK_SHEET_LIMIT = 3;
const OFFICE_WORKBOOK_ROW_LIMIT = 12;
const OFFICE_WORKBOOK_COL_LIMIT = 8;
const OFFICE_PRESENTATION_SLIDE_LIMIT = 12;
const OFFICE_SNIPPET_LIMIT = 3;
const SUPPORTED_OFFICE_INPUT_KINDS = new Set([
  "url",
  "local_path",
  "lark_file_token",
  "file_token",
  "lark_file_key",
  "file_key",
]);

const OFFICE_INPUT_KIND_PRIORITY = new Map([
  ["lark_file_key", 1],
  ["file_key", 1],
  ["lark_file_token", 2],
  ["file_token", 2],
  ["url", 3],
  ["local_path", 4],
]);

const OFFICE_EXT_KIND_MAP = new Map([
  ["doc", "document"],
  ["docx", "document"],
  ["docm", "document"],
  ["dotx", "document"],
  ["dotm", "document"],
  ["xls", "spreadsheet"],
  ["xlsx", "spreadsheet"],
  ["xlsm", "spreadsheet"],
  ["xltx", "spreadsheet"],
  ["xltm", "spreadsheet"],
  ["ppt", "presentation"],
  ["pptx", "presentation"],
  ["pptm", "presentation"],
  ["potx", "presentation"],
  ["potm", "presentation"],
]);

const OFFICE_KIND_LABELS = {
  document: "Word 文件",
  spreadsheet: "表格",
  presentation: "簡報",
};

function formatBytesMb(bytes = 0) {
  const normalized = Number(bytes);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "未知";
  }
  return `${(normalized / (1024 * 1024)).toFixed(1)} MB`;
}

function decodeXmlEntities(value = "") {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeExtLike(value = "") {
  return cleanText(value).toLowerCase().replace(/^\./, "");
}

function resolveExtFromName(name = "") {
  const normalized = cleanText(name).toLowerCase();
  if (!normalized) {
    return "";
  }
  const match = normalized.match(/\.([a-z0-9]{1,12})(?:$|[?#])/i);
  return match ? normalizeExtLike(match[1]) : "";
}

function inferOfficeKind({ ext = "", mime = "", name = "", value = "" } = {}) {
  const normalizedExt = normalizeExtLike(ext)
    || resolveExtFromName(name)
    || resolveExtFromName(value);
  if (normalizedExt && OFFICE_EXT_KIND_MAP.has(normalizedExt)) {
    return {
      ext: normalizedExt,
      fileKind: OFFICE_EXT_KIND_MAP.get(normalizedExt),
    };
  }

  const normalizedMime = cleanText(mime).toLowerCase();
  if (/wordprocessingml|msword/.test(normalizedMime)) {
    return { ext: normalizedExt || "docx", fileKind: "document" };
  }
  if (/spreadsheetml|excel|sheet/.test(normalizedMime)) {
    return { ext: normalizedExt || "xlsx", fileKind: "spreadsheet" };
  }
  if (/presentationml|powerpoint/.test(normalizedMime)) {
    return { ext: normalizedExt || "pptx", fileKind: "presentation" };
  }

  return {
    ext: normalizedExt,
    fileKind: "",
  };
}

function normalizeOfficeReadFailureMessage(rawMessage = "", { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const normalized = cleanText(rawMessage);
  if (!normalized) {
    return "辦公檔讀取失敗，請確認檔案權限或格式。";
  }

  if (
    /missing_access_token_for_lark_office_download|missing_user_access_token|oauth_reauth_required/i.test(normalized)
  ) {
    return "缺少可用的使用者授權，暫時無法讀取這份附件。請先重新完成 Lark OAuth 後再試。";
  }

  if (/im:message\.p2p_msg:get_as_user|im:message\.group_msg:get_as_user|code=234009/i.test(normalized)) {
    return "目前缺少訊息附件讀取權限（im:message.*:get_as_user），請補齊 scope 並重新完成 Lark OAuth。";
  }

  if (/download_stream_too_large|office_file_too_large/i.test(normalized)) {
    return `檔案超過目前附件讀取上限（${formatBytesMb(maxBytes)}），請縮小檔案或分檔後再試。`;
  }

  if (/missing_message_id_for_message_file_key/i.test(normalized)) {
    return "附件缺少可用的 message_id，無法走訊息附件下載流程。";
  }

  if (/message_file_resource_fetch_failed/i.test(normalized) && /status=502/i.test(normalized)) {
    return "Lark 訊息附件服務目前回傳 502（upstream 連線中斷），這份附件暫時無法直接下載；請稍後再試或重傳附件。";
  }

  if (/message_file_resource_fetch_failed/i.test(normalized) && /drive_fallback_failed/i.test(normalized)) {
    return "訊息附件下載與 Drive 備援都失敗，請確認附件仍可被授權帳號存取。";
  }

  if (/message_file_resource_fetch_failed/i.test(normalized)) {
    return "無法透過訊息附件通道下載這份附件，請確認訊息附件權限後重試。";
  }

  if (/drive_fallback_failed/i.test(normalized)) {
    return "Drive 備援下載失敗，請確認附件是否為可存取的 Drive 檔案。";
  }

  if (/unsupported_office_type/i.test(normalized)) {
    return "這份附件目前不是已支援的 Word / Excel / PowerPoint 格式。";
  }

  return normalized.slice(0, 180);
}

function buildOfficeReadLimitation(input = {}, error = null, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const label = cleanText(input?.name || input?.value || "附件");
  const rawMessage = error instanceof Error ? error.message : String(error || "");
  return `${label}：${normalizeOfficeReadFailureMessage(rawMessage, { maxBytes })}`;
}

function normalizeOfficeInput(input = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const kind = cleanText(input.kind).toLowerCase();
  const value = cleanText(input.value);
  if (!kind || !value) {
    return null;
  }
  const name = cleanText(input.name);
  const mime = cleanText(input.mime).toLowerCase();
  const inferred = inferOfficeKind({
    ext: cleanText(input.ext),
    mime,
    name,
    value,
  });
  return {
    kind,
    value,
    name,
    mime,
    ext: inferred.ext,
    fileKind: inferred.fileKind,
  };
}

function isSupportedOfficeInputKind(kind = "") {
  return SUPPORTED_OFFICE_INPUT_KINDS.has(cleanText(kind).toLowerCase());
}

function prioritizeOfficeInputs(inputs = []) {
  return [...inputs].sort((a, b) => {
    const aPriority = OFFICE_INPUT_KIND_PRIORITY.get(cleanText(a?.kind).toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const bPriority = OFFICE_INPUT_KIND_PRIORITY.get(cleanText(b?.kind).toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
    return cleanText(a?.value).localeCompare(cleanText(b?.value));
  });
}

function toTextPreview(rawText = "", maxChars = DEFAULT_MAX_TEXT_CHARS) {
  const normalized = cleanText(
    String(rawText || "")
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " "),
  );
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, maxChars);
}

async function fetchOfficeBufferFromUrl(url, {
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`office_url_fetch_failed:${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    if (bytes.length > maxBytes) {
      throw new Error("office_file_too_large");
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveOfficeBufferFromInput(input, {
  accessToken = "",
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  messageId = "",
} = {}) {
  if (input.kind === "url") {
    return {
      buffer: await fetchOfficeBufferFromUrl(input.value, { maxBytes, timeoutMs }),
      source: {
        source_type: input.ext || "url",
        source_id: input.value,
        source_label: input.name || input.value,
      },
    };
  }

  if (input.kind === "local_path") {
    const bytes = await readFile(input.value);
    if (bytes.length > maxBytes) {
      throw new Error("office_file_too_large");
    }
    return {
      buffer: bytes,
      source: {
        source_type: input.ext || "local_path",
        source_id: input.value,
        source_label: input.name || input.value,
      },
    };
  }

  if (["lark_file_token", "file_token", "lark_file_key", "file_key"].includes(input.kind)) {
    if (!cleanText(accessToken)) {
      throw new Error("missing_access_token_for_lark_office_download");
    }
    let download = null;
    if (input.kind === "lark_file_key" || input.kind === "file_key") {
      const canTryMessageResource = Boolean(cleanText(messageId));
      let messageResourceError = null;
      if (canTryMessageResource) {
        try {
          download = await downloadMessageFileResourceBuffer(accessToken, messageId, input.value, {
            maxBytes,
          });
        } catch (error) {
          messageResourceError = error;
        }
      }
      if (!download) {
        if (!canTryMessageResource) {
          throw new Error("missing_message_id_for_message_file_key");
        }
        throw messageResourceError instanceof Error
          ? messageResourceError
          : new Error("message_file_resource_fetch_failed");
      }
    } else {
      download = await downloadDriveFileBuffer(accessToken, input.value, {
        maxBytes,
      });
    }
    return {
      buffer: download.buffer,
      source: {
        source_type: (input.kind === "lark_file_key" || input.kind === "file_key")
          ? "lark_message_resource"
          : "lark_drive",
        source_id: input.value,
        source_label: input.name || input.value,
        ...(download.content_type ? { content_type: download.content_type } : {}),
      },
    };
  }

  throw new Error(`unsupported_office_input_kind:${input.kind}`);
}

function buildWorkbookRowsText(rows = []) {
  const lines = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const values = (Array.isArray(row) ? row : [])
      .slice(0, OFFICE_WORKBOOK_COL_LIMIT)
      .map((cell) => cleanText(String(cell ?? "")))
      .filter(Boolean);
    if (!values.length) {
      continue;
    }
    lines.push(values.join(" | "));
    if (lines.length >= OFFICE_WORKBOOK_ROW_LIMIT) {
      break;
    }
  }
  return lines;
}

async function extractDocxTextFromBuffer(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  const text = toTextPreview(result?.value || "");
  if (!text) {
    throw new Error("office_text_empty");
  }
  return {
    text,
    metadata: {
      file_kind: "document",
      warnings: Array.isArray(result?.messages) ? result.messages.length : 0,
    },
  };
}

async function extractWorkbookTextFromBuffer(buffer) {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellFormula: false,
    cellHTML: false,
    cellText: true,
    dense: true,
  });
  const sheetNames = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames.slice(0, OFFICE_WORKBOOK_SHEET_LIMIT) : [];
  const sections = [];
  for (const sheetName of sheetNames) {
    const sheet = workbook?.Sheets?.[sheetName];
    if (!sheet) {
      continue;
    }
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      blankrows: false,
      raw: false,
      defval: "",
    });
    const lines = buildWorkbookRowsText(rows);
    if (!lines.length) {
      continue;
    }
    sections.push([
      `工作表：${sheetName}`,
      ...lines,
    ].join("\n"));
  }
  const text = toTextPreview(sections.join("\n\n"));
  if (!text) {
    throw new Error("office_text_empty");
  }
  return {
    text,
    metadata: {
      file_kind: "spreadsheet",
      sheet_count: Array.isArray(workbook?.SheetNames) ? workbook.SheetNames.length : null,
    },
  };
}

function extractSlideTexts(xml = "") {
  const matches = [...String(xml || "").matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)];
  return matches
    .map((match) => decodeXmlEntities(match[1] || ""))
    .map((item) => cleanText(item))
    .filter(Boolean);
}

async function extractPresentationTextFromBuffer(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => {
      const leftNumber = Number.parseInt(left.match(/slide(\d+)\.xml/i)?.[1] || "0", 10);
      const rightNumber = Number.parseInt(right.match(/slide(\d+)\.xml/i)?.[1] || "0", 10);
      return leftNumber - rightNumber;
    })
    .slice(0, OFFICE_PRESENTATION_SLIDE_LIMIT);
  const sections = [];
  for (const slideFile of slideFiles) {
    const xml = await zip.file(slideFile)?.async("string");
    const texts = extractSlideTexts(xml);
    if (!texts.length) {
      continue;
    }
    const slideNumber = Number.parseInt(slideFile.match(/slide(\d+)\.xml/i)?.[1] || "0", 10) || (sections.length + 1);
    sections.push(`第 ${slideNumber} 頁：${texts.join(" ")}`);
  }
  const text = toTextPreview(sections.join("\n"));
  if (!text) {
    throw new Error("office_text_empty");
  }
  return {
    text,
    metadata: {
      file_kind: "presentation",
      slide_count: slideFiles.length || null,
    },
  };
}

async function extractOfficeFileFromBuffer(buffer, {
  fileKind = "",
} = {}) {
  if (fileKind === "document") {
    return extractDocxTextFromBuffer(buffer);
  }
  if (fileKind === "spreadsheet") {
    return extractWorkbookTextFromBuffer(buffer);
  }
  if (fileKind === "presentation") {
    return extractPresentationTextFromBuffer(buffer);
  }
  throw new Error("unsupported_office_type");
}

function buildSnippets(text = "", limit = OFFICE_SNIPPET_LIMIT) {
  const normalized = cleanText(text);
  if (!normalized) {
    return [];
  }
  const lines = normalized
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  if (lines.length > 1) {
    return lines.slice(0, Math.max(1, limit));
  }
  return normalized
    .split(/(?<=[。！？.!?])\s+/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .slice(0, Math.max(1, limit));
}

function buildAnswerHighlights(files = [], { maxHighlights = 3 } = {}) {
  const highlights = [];
  for (const file of Array.isArray(files) ? files : []) {
    const snippets = Array.isArray(file?.snippets) ? file.snippets : [];
    for (const snippet of snippets) {
      const normalized = normalizeText(snippet);
      if (!normalized) {
        continue;
      }
      if (!highlights.includes(normalized)) {
        highlights.push(normalized);
      }
      if (highlights.length >= maxHighlights) {
        return highlights;
      }
    }
  }
  return highlights;
}

function buildOfficeSourceObjects(files = [], { maxSources = 3 } = {}) {
  const result = [];
  for (const item of Array.isArray(files) ? files : []) {
    const snippet = normalizeText((Array.isArray(item?.snippets) ? item.snippets[0] : "") || item?.text || "");
    if (!snippet) {
      continue;
    }
    const sourceType = cleanText(item?.source?.source_type || item?.input?.ext || "office");
    const sourceId = cleanText(item?.source?.source_id || item?.input?.value || "");
    const title = cleanText(item?.source?.source_label || item?.input?.name || sourceId || "附件");
    const contentType = cleanText(item?.source?.content_type || "");
    const id = cleanText(`${sourceType}:${sourceId || title}`);
    if (!id) {
      continue;
    }
    result.push({
      id,
      snippet,
      metadata: {
        document_id: sourceId || title,
        title,
        url: "",
        source_type: sourceType,
        updated_at: "",
        ...(contentType ? { content_type: contentType } : {}),
      },
    });
    if (result.length >= maxSources) {
      break;
    }
  }
  return result;
}

function extractJsonObject(text = "") {
  const normalized = String(text || "").trim();
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("office_model_missing_json_object");
  }
  return JSON.parse(normalized.slice(start, end + 1));
}

function normalizeStringList(values = [], { maxItems = OFFICE_MODEL_LIMITATION_MAX_ITEMS, maxItemChars = 140 } = {}) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = cleanText(String(value || "")).slice(0, maxItemChars);
    if (!normalized || result.includes(normalized)) {
      continue;
    }
    result.push(normalized);
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

function shouldAttemptModelBackedOfficeInterpretation({ question = "", files = [], allowModelInterpretation = false } = {}) {
  return Boolean(allowModelInterpretation)
    && Boolean(cleanText(question))
    && Array.isArray(files)
    && files.length > 0;
}

function looksLikeOfficeContentValidationQuestion(question = "") {
  const normalized = cleanText(question);
  if (!normalized) {
    return false;
  }
  return /(這個|這份|這頁|這張|內容|上面|剛剛|前面|這裡|這段).{0,12}(對嗎|正確嗎|有沒有問題|有沒有看錯|是不是這樣|是不是對的|是對的嗎)/.test(normalized)
    || /(幫我看一下|幫我確認一下|幫我核對一下).{0,12}(對嗎|正確嗎|有沒有問題|是不是對的|是對的嗎)/.test(normalized)
    || /(我有沒有看錯|是不是我理解錯了|是不是我看錯了)/.test(normalized);
}

function buildOfficeInterpretationPrompt({ files = [], question = "" } = {}) {
  const normalizedQuestion = cleanText(question);
  const documentSections = [];
  let remainingChars = OFFICE_MODEL_CONTEXT_MAX_CHARS;

  for (const [index, file] of (Array.isArray(files) ? files : []).entries()) {
    if (remainingChars <= 0) {
      break;
    }
    const title = cleanText(file?.source?.source_label || file?.input?.name || `附件 ${index + 1}`);
    const fileKind = cleanText(file?.metadata?.file_kind || file?.input?.fileKind || "");
    const text = cleanText(file?.text || "").slice(0, Math.min(OFFICE_MODEL_DOC_MAX_CHARS, remainingChars));
    if (!text) {
      continue;
    }
    const block = [
      `附件 ${index + 1}：${title}`,
      fileKind ? `類型：${OFFICE_KIND_LABELS[fileKind] || fileKind}` : null,
      "已抽取文本：",
      text,
    ].filter(Boolean).join("\n");
    documentSections.push(block);
    remainingChars -= block.length;
  }

  return [
    "任務：根據已抽取的辦公檔文本，直接回答使用者問題。",
    "硬性規則：",
    "- 只能使用下面提供的已抽取文本，不可假設未抽取頁面、圖表、備註或附件內容。",
    "- 若證據不足，answer 必須明說「依目前已抽取片段」且避免過度結論。",
    "- 不要虛構工作表、投影片頁碼、章節名稱、權限、網址或聯絡資訊。",
    looksLikeOfficeContentValidationQuestion(normalizedQuestion)
      ? "- 若問題像是「這個內容對嗎／我有沒有看錯」，優先判斷『目前整理出的重點是否與已抽取文本一致』，不要把它誤答成外部市場真偽查核。"
      : null,
    "- 只輸出單一合法 JSON object，不要 Markdown、不要 code fence、不要前後文。",
    '輸出格式：{"answer":"...","limitations":["..."]}',
    "",
    `使用者問題：${normalizedQuestion}`,
    "",
    "可用文本：",
    documentSections.join("\n\n"),
  ].join("\n");
}

async function buildModelBackedOfficeInterpretation({
  files = [],
  question = "",
  generateTextFn = generateText,
} = {}) {
  const systemPrompt = [
    "你是嚴格的辦公檔閱讀助手。",
    "先直接回答問題，再補一句到三句必要解讀。",
    "不能把未抽取內容說成已完整讀過。",
  ].join(" ");
  const prompt = buildOfficeInterpretationPrompt({ files, question });
  const rawText = await generateTextFn({
    systemPrompt,
    prompt,
    sessionIdSuffix: "office-deep-read",
    temperature: 0.1,
    topP: 0.75,
  });
  const payload = extractJsonObject(rawText);
  const answer = cleanText(payload?.answer || "");
  if (!answer) {
    throw new Error("office_model_answer_missing");
  }
  return {
    answer,
    limitations: normalizeStringList(payload?.limitations),
  };
}

export async function readOfficeInputs({
  officeInputs = [],
  accessToken = "",
  messageId = "",
  maxFiles = 2,
  maxBytes = DEFAULT_MAX_BYTES,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  resolveOfficeBufferFromInputFn = resolveOfficeBufferFromInput,
  extractOfficeFileFromBufferFn = extractOfficeFileFromBuffer,
} = {}) {
  const normalizedMaxBytes = normalizePositiveInteger(
    maxBytes,
    DEFAULT_MAX_BYTES,
    { min: 1_000_000, max: 50 * 1024 * 1024 },
  );
  const normalizedInputs = (Array.isArray(officeInputs) ? officeInputs : [])
    .map((item) => normalizeOfficeInput(item))
    .filter(Boolean);
  const supportedInputs = normalizedInputs
    .filter((item) => isSupportedOfficeInputKind(item.kind))
    .filter((item) => Boolean(item.fileKind))
    .filter((item, index, bucket) => (
      bucket.findIndex((other) => (
        cleanText(other.kind).toLowerCase() === cleanText(item.kind).toLowerCase()
        && cleanText(other.value) === cleanText(item.value)
      )) === index
    ));
  const selectedInputs = prioritizeOfficeInputs(supportedInputs)
    .slice(0, Math.max(1, normalizePositiveInteger(maxFiles, 2, { min: 1, max: 5 })));

  if (!selectedInputs.length) {
    return {
      ok: false,
      error: "office_input_missing",
      files: [],
      limitations: ["沒有可讀取的 Word / Excel / PowerPoint 參考。"],
    };
  }

  const files = [];
  const limitations = [];

  for (const input of selectedInputs) {
    try {
      const resolved = await resolveOfficeBufferFromInputFn(input, {
        accessToken,
        messageId,
        maxBytes: normalizedMaxBytes,
        timeoutMs: normalizePositiveInteger(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, { min: 1_000, max: 60_000 }),
      });
      const parsed = await extractOfficeFileFromBufferFn(resolved.buffer, {
        fileKind: input.fileKind,
        ext: input.ext,
      });
      const text = toTextPreview(parsed.text, normalizePositiveInteger(maxTextChars, DEFAULT_MAX_TEXT_CHARS, { min: 512, max: 100_000 }));
      files.push({
        input,
        source: resolved.source,
        text,
        snippets: buildSnippets(text),
        metadata: parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : { file_kind: input.fileKind },
      });
    } catch (error) {
      limitations.push(buildOfficeReadLimitation(input, error, { maxBytes: normalizedMaxBytes }));
    }
  }

  if (!files.length) {
    return {
      ok: false,
      error: "office_read_failed",
      files: [],
      limitations: limitations.length
        ? limitations
        : ["辦公檔讀取失敗，請確認檔案權限或格式。"],
    };
  }

  return {
    ok: true,
    files,
    limitations,
  };
}

export function buildOfficeResponseFromReadResult({
  readResult = null,
  question = "",
  modelInterpretation = null,
} = {}) {
  const normalizedQuestion = cleanText(question);
  if (!readResult || readResult.ok !== true) {
    const limitations = Array.isArray(readResult?.limitations) && readResult.limitations.length
      ? readResult.limitations
      : ["目前沒有成功讀到可用的辦公檔內容。"];
    return {
      answer: "我有接到辦公檔閱讀任務，但這輪還沒拿到可驗證內容，所以先不假裝完成。",
      sources: [],
      limitations,
    };
  }

  const files = Array.isArray(readResult.files) ? readResult.files : [];
  const highlights = buildAnswerHighlights(files, { maxHighlights: 3 });
  const kindLabels = [...new Set(files
    .map((file) => cleanText(OFFICE_KIND_LABELS[file?.metadata?.file_kind] || file?.metadata?.file_kind || "附件"))
    .filter(Boolean))];
  const typeSummary = kindLabels.length ? kindLabels.join(" / ") : "附件";
  const answerHeader = normalizedQuestion
    ? `我已先讀取 ${files.length} 份 ${typeSummary}，並依你的問題整理可驗證重點。`
    : `我已先讀取 ${files.length} 份 ${typeSummary}，以下是目前可驗證的內容重點。`;
  const answer = cleanText(modelInterpretation?.answer || "")
    || (
      highlights.length
        ? [
            answerHeader,
            "",
            ...highlights.slice(0, 3).map((line, index) => `${index + 1}. ${line}`),
          ].join("\n")
        : answerHeader
    );

  const sourceObjects = buildOfficeSourceObjects(files, { maxSources: 3 });
  const modelLimitations = normalizeStringList(modelInterpretation?.limitations);
  const limitations = Array.isArray(readResult.limitations) && readResult.limitations.length
    ? normalizeStringList([
        ...readResult.limitations,
        ...modelLimitations,
        "如果你要更完整答案，我可以再針對指定工作表、段落或投影片做二次抽取。",
      ], { maxItems: 5 })
    : normalizeStringList(
      (modelInterpretation?.answer || modelLimitations.length)
        ? [
            ...modelLimitations,
            "本次解讀仍只基於目前已抽取的文本片段，還不是完整逐頁或逐工作表審閱。",
          ]
        : ["目前只先抽取前段文本，尚未做完整深讀。"],
      { maxItems: 5 },
    );

  return {
    answer,
    sources: sourceObjects,
    limitations,
  };
}

export async function readOfficeTaskAndBuildReply({
  officeInputs = [],
  accessToken = "",
  messageId = "",
  question = "",
  allowModelInterpretation = Boolean(llmApiKey),
  generateTextFn = generateText,
  resolveOfficeBufferFromInputFn = resolveOfficeBufferFromInput,
  extractOfficeFileFromBufferFn = extractOfficeFileFromBuffer,
} = {}) {
  const readResult = await readOfficeInputs({
    officeInputs,
    accessToken,
    messageId,
    resolveOfficeBufferFromInputFn,
    extractOfficeFileFromBufferFn,
  });
  let modelInterpretation = null;
  let modelStatus = "not_attempted";
  if (readResult?.ok === true && shouldAttemptModelBackedOfficeInterpretation({
    question,
    files: readResult.files,
    allowModelInterpretation,
  })) {
    try {
      modelInterpretation = await buildModelBackedOfficeInterpretation({
        files: readResult.files,
        question,
        generateTextFn,
      });
      modelStatus = "used_model";
    } catch (error) {
      modelStatus = "model_failed";
      modelInterpretation = {
        answer: "",
        limitations: ["這輪主模型解讀未完成，先退回可驗證的抽取內容。"],
        error: cleanText(error instanceof Error ? error.message : String(error)),
      };
    }
  } else if (cleanText(question)) {
    modelStatus = allowModelInterpretation ? "question_without_readable_text" : "model_unavailable";
  }
  return {
    ...buildOfficeResponseFromReadResult({
      readResult,
      question,
      modelInterpretation,
    }),
    read_result: readResult,
    model_interpretation: {
      status: modelStatus,
      error: cleanText(modelInterpretation?.error || ""),
    },
  };
}
