import pdfParse from "pdf-parse";
import { readFile } from "node:fs/promises";

import { pdfReadMaxBytes } from "./config.mjs";
import { downloadDriveFileBuffer, downloadMessageFileResourceBuffer } from "./lark-connectors.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { normalizeText } from "./text-utils.mjs";

const DEFAULT_MAX_BYTES = Number.isFinite(Number(pdfReadMaxBytes)) && Number(pdfReadMaxBytes) > 0
  ? Number(pdfReadMaxBytes)
  : 15 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 24_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
const SUPPORTED_PDF_INPUT_KINDS = new Set([
  "url",
  "local_path",
  "lark_file_token",
  "file_token",
  "lark_file_key",
  "file_key",
]);

const PDF_INPUT_KIND_PRIORITY = new Map([
  ["lark_file_key", 1],
  ["file_key", 1],
  ["lark_file_token", 2],
  ["file_token", 2],
  ["url", 3],
  ["local_path", 4],
]);

function formatBytesMb(bytes = 0) {
  const normalized = Number(bytes);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "未知";
  }
  return `${(normalized / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizePdfReadFailureMessage(rawMessage = "", { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const normalized = cleanText(rawMessage);
  if (!normalized) {
    return "PDF 讀取失敗，請確認檔案權限或格式。";
  }

  if (
    /missing_access_token_for_lark_pdf_download|missing_user_access_token|oauth_reauth_required/i.test(normalized)
  ) {
    return "缺少可用的使用者授權，暫時無法讀取這份 PDF 附件。請先重新完成 Lark OAuth 後再試。";
  }

  if (/im:message\.p2p_msg:get_as_user|im:message\.group_msg:get_as_user|code=234009/i.test(normalized)) {
    return "目前缺少訊息附件讀取權限（im:message.*:get_as_user），請補齊 scope 並重新完成 Lark OAuth。";
  }

  if (/download_stream_too_large|pdf_file_too_large/i.test(normalized)) {
    return `檔案超過目前 PDF 讀取上限（${formatBytesMb(maxBytes)}），請縮小檔案或分檔後再試。`;
  }

  if (/missing_message_id_for_message_file_key/i.test(normalized)) {
    return "附件缺少可用的 message_id，無法走訊息附件下載流程。";
  }

  if (/message_file_resource_fetch_failed/i.test(normalized) && /status=502/i.test(normalized)) {
    return "Lark 訊息附件服務目前回傳 502（upstream 連線中斷），這份附件暫時無法直接下載；請重傳一次附件，或改貼可直接存取的檔案連結後重試。";
  }

  if (/message_file_resource_fetch_failed/i.test(normalized) && /drive_fallback_failed/i.test(normalized)) {
    return "訊息附件下載與 Drive 備援都失敗，請確認附件仍可被授權帳號存取。";
  }

  if (/message_file_resource_fetch_failed/i.test(normalized)) {
    return "無法透過訊息附件通道下載 PDF，請確認訊息附件權限後重試。";
  }

  if (/drive_fallback_failed/i.test(normalized)) {
    return "Drive 備援下載失敗，請確認附件是否為可存取的 Drive 檔案。";
  }

  return normalized.slice(0, 180);
}

function buildPdfReadLimitation(input = {}, error = null, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const label = cleanText(input?.name || input?.value || "PDF");
  const rawMessage = error instanceof Error ? error.message : String(error || "");
  return `${label}：${normalizePdfReadFailureMessage(rawMessage, { maxBytes })}`;
}

function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizePdfInput(input = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const kind = cleanText(input.kind).toLowerCase();
  const value = cleanText(input.value);
  if (!kind || !value) {
    return null;
  }
  return {
    kind,
    value,
    name: cleanText(input.name),
    mime: cleanText(input.mime).toLowerCase(),
    ext: cleanText(input.ext).toLowerCase(),
  };
}

function isSupportedPdfInputKind(kind = "") {
  return SUPPORTED_PDF_INPUT_KINDS.has(cleanText(kind).toLowerCase());
}

function prioritizePdfInputs(inputs = []) {
  return [...inputs].sort((a, b) => {
    const aPriority = PDF_INPUT_KIND_PRIORITY.get(cleanText(a?.kind).toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const bPriority = PDF_INPUT_KIND_PRIORITY.get(cleanText(b?.kind).toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
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

async function fetchPdfBufferFromUrl(url, {
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
      throw new Error(`pdf_url_fetch_failed:${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    if (bytes.length > maxBytes) {
      throw new Error("pdf_file_too_large");
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolvePdfBufferFromInput(input, {
  accessToken = "",
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  messageId = "",
} = {}) {
  if (input.kind === "url") {
    return {
      buffer: await fetchPdfBufferFromUrl(input.value, { maxBytes, timeoutMs }),
      source: {
        source_type: "url",
        source_id: input.value,
        source_label: input.name || input.value,
      },
    };
  }

  if (input.kind === "local_path") {
    const bytes = await readFile(input.value);
    if (bytes.length > maxBytes) {
      throw new Error("pdf_file_too_large");
    }
    return {
      buffer: bytes,
      source: {
        source_type: "local_path",
        source_id: input.value,
        source_label: input.name || input.value,
      },
    };
  }

  if (["lark_file_token", "file_token", "lark_file_key", "file_key"].includes(input.kind)) {
    if (!cleanText(accessToken)) {
      throw new Error("missing_access_token_for_lark_pdf_download");
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

  throw new Error(`unsupported_pdf_input_kind:${input.kind}`);
}

async function extractPdfTextFromBuffer(buffer) {
  const result = await pdfParse(buffer);
  const text = toTextPreview(result?.text || "");
  if (!text) {
    throw new Error("pdf_text_empty");
  }
  return {
    text,
    page_count: Number(result?.numpages || 0) || null,
    metadata: result?.info && typeof result.info === "object" ? result.info : null,
  };
}

function buildSnippets(text = "", limit = 3) {
  const normalized = cleanText(text);
  if (!normalized) {
    return [];
  }
  const sentences = normalized
    .split(/(?<=[。！？.!?])\s+/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  return sentences.slice(0, Math.max(1, limit));
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

function buildPdfSourceObjects(files = [], { maxSources = 3 } = {}) {
  const result = [];
  for (const item of Array.isArray(files) ? files : []) {
    const snippet = normalizeText((Array.isArray(item?.snippets) ? item.snippets[0] : "") || item?.text || "");
    if (!snippet) {
      continue;
    }
    const sourceType = cleanText(item?.source?.source_type || "pdf");
    const sourceId = cleanText(item?.source?.source_id || item?.input?.value || "");
    const title = cleanText(item?.source?.source_label || item?.input?.name || sourceId || "PDF");
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

export async function readPdfInputs({
  pdfInputs = [],
  accessToken = "",
  messageId = "",
  maxFiles = 2,
  maxBytes = DEFAULT_MAX_BYTES,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  resolvePdfBufferFromInputFn = resolvePdfBufferFromInput,
  extractPdfTextFromBufferFn = extractPdfTextFromBuffer,
} = {}) {
  const normalizedMaxBytes = normalizePositiveInteger(
    maxBytes,
    DEFAULT_MAX_BYTES,
    { min: 1_000_000, max: 50 * 1024 * 1024 },
  );
  const normalizedInputs = (Array.isArray(pdfInputs) ? pdfInputs : [])
    .map((item) => normalizePdfInput(item))
    .filter(Boolean);
  const supportedInputs = normalizedInputs
    .filter((item) => isSupportedPdfInputKind(item.kind))
    .filter((item, index, bucket) => (
      bucket.findIndex((other) => (
        cleanText(other.kind).toLowerCase() === cleanText(item.kind).toLowerCase()
        && cleanText(other.value) === cleanText(item.value)
      )) === index
    ));
  const selectedInputs = prioritizePdfInputs(supportedInputs)
    .slice(0, Math.max(1, normalizePositiveInteger(maxFiles, 2, { min: 1, max: 5 })));

  if (!selectedInputs.length) {
    return {
      ok: false,
      error: "pdf_input_missing",
      files: [],
      limitations: ["沒有可讀取的 PDF 參考。"],
    };
  }

  const files = [];
  const limitations = [];

  for (const input of selectedInputs) {
    try {
      const resolved = await resolvePdfBufferFromInputFn(input, {
        accessToken,
        messageId,
        maxBytes: normalizedMaxBytes,
        timeoutMs: normalizePositiveInteger(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, { min: 1_000, max: 60_000 }),
      });
      const parsed = await extractPdfTextFromBufferFn(resolved.buffer);
      const text = toTextPreview(parsed.text, normalizePositiveInteger(maxTextChars, DEFAULT_MAX_TEXT_CHARS, { min: 512, max: 100_000 }));
      files.push({
        input,
        source: resolved.source,
        text,
        snippets: buildSnippets(text),
        page_count: parsed.page_count,
      });
    } catch (error) {
      limitations.push(buildPdfReadLimitation(input, error, { maxBytes: normalizedMaxBytes }));
    }
  }

  if (!files.length) {
    return {
      ok: false,
      error: "pdf_read_failed",
      files: [],
      limitations: limitations.length
        ? limitations
        : ["PDF 讀取失敗，請確認檔案權限或格式。"],
    };
  }

  return {
    ok: true,
    files,
    limitations,
  };
}

export function buildPdfResponseFromReadResult({
  readResult = null,
  question = "",
} = {}) {
  const normalizedQuestion = cleanText(question);
  if (!readResult || readResult.ok !== true) {
    const limitations = Array.isArray(readResult?.limitations) && readResult.limitations.length
      ? readResult.limitations
      : ["目前沒有成功讀到可用的 PDF 內容。"];
    return {
      answer: "我有接到 PDF 任務，但這輪還沒拿到可驗證內容，所以先不假裝完成。",
      sources: [],
      limitations,
    };
  }

  const files = Array.isArray(readResult.files) ? readResult.files : [];
  const highlights = buildAnswerHighlights(files, { maxHighlights: 3 });
  const answerHeader = normalizedQuestion
    ? `我已先讀取 ${files.length} 份 PDF，並依你的問題整理可驗證重點。`
    : `我已先讀取 ${files.length} 份 PDF，以下是目前可驗證的內容重點。`;
  const answer = highlights.length
    ? [
        answerHeader,
        "",
        ...highlights.slice(0, 3).map((line, index) => `${index + 1}. ${line}`),
      ].join("\n")
    : answerHeader;

  const sourceObjects = buildPdfSourceObjects(files, { maxSources: 3 });

  const limitations = Array.isArray(readResult.limitations) && readResult.limitations.length
    ? [
        ...readResult.limitations,
        "如果你要更完整答案，我可以再針對指定章節做二次抽取。",
      ]
    : ["目前只先抽取前段文本，尚未做逐頁深讀。"];

  return {
    answer,
    sources: sourceObjects,
    limitations,
  };
}

export async function readPdfTaskAndBuildReply({
  pdfInputs = [],
  accessToken = "",
  messageId = "",
  question = "",
} = {}) {
  const readResult = await readPdfInputs({
    pdfInputs,
    accessToken,
    messageId,
  });
  return {
    ...buildPdfResponseFromReadResult({
      readResult,
      question,
    }),
    read_result: readResult,
  };
}
