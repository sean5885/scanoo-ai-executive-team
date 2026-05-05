import pdfParse from "pdf-parse";
import { readFile } from "node:fs/promises";

import { downloadDriveFileBuffer } from "./lark-connectors.mjs";
import { cleanText } from "./message-intent-utils.mjs";

const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 24_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;

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

function toTextPreview(rawText = "", maxChars = DEFAULT_MAX_TEXT_CHARS) {
  const normalized = cleanText(String(rawText || "").replace(/\s+/g, " "));
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
    const download = await downloadDriveFileBuffer(accessToken, input.value, {
      maxBytes,
    });
    return {
      buffer: download.buffer,
      source: {
        source_type: "lark_drive",
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

export async function readPdfInputs({
  pdfInputs = [],
  accessToken = "",
  maxFiles = 2,
  maxBytes = DEFAULT_MAX_BYTES,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const normalizedInputs = (Array.isArray(pdfInputs) ? pdfInputs : [])
    .map((item) => normalizePdfInput(item))
    .filter(Boolean)
    .slice(0, Math.max(1, normalizePositiveInteger(maxFiles, 2, { min: 1, max: 5 })));

  if (!normalizedInputs.length) {
    return {
      ok: false,
      error: "pdf_input_missing",
      files: [],
      limitations: ["沒有可讀取的 PDF 參考。"],
    };
  }

  const files = [];
  const limitations = [];

  for (const input of normalizedInputs) {
    try {
      const resolved = await resolvePdfBufferFromInput(input, {
        accessToken,
        maxBytes: normalizePositiveInteger(maxBytes, DEFAULT_MAX_BYTES, { min: 1_000_000, max: 50 * 1024 * 1024 }),
        timeoutMs: normalizePositiveInteger(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, { min: 1_000, max: 60_000 }),
      });
      const parsed = await extractPdfTextFromBuffer(resolved.buffer);
      const text = toTextPreview(parsed.text, normalizePositiveInteger(maxTextChars, DEFAULT_MAX_TEXT_CHARS, { min: 512, max: 100_000 }));
      files.push({
        input,
        source: resolved.source,
        text,
        snippets: buildSnippets(text),
        page_count: parsed.page_count,
      });
    } catch (error) {
      limitations.push(`${input.name || input.value}：${error instanceof Error ? error.message : String(error)}`);
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
      sources: ["PDF 讀取流程已啟動，但目前未成功取得文本內容。"],
      limitations,
    };
  }

  const files = Array.isArray(readResult.files) ? readResult.files : [];
  const sourceLines = files.map((item, index) => {
    const label = cleanText(item?.source?.source_label || item?.source?.source_id || `pdf_${index + 1}`);
    const snippet = cleanText((item?.snippets || [])[0] || "");
    return snippet ? `${label}：${snippet}` : label;
  });

  const answer = normalizedQuestion
    ? `我已先讀取 ${files.length} 份 PDF，並依你的問題整理可驗證重點。`
    : `我已先讀取 ${files.length} 份 PDF，以下是目前可驗證的內容重點。`;

  const limitations = Array.isArray(readResult.limitations) && readResult.limitations.length
    ? [
        ...readResult.limitations,
        "如果你要更完整答案，我可以再針對指定章節做二次抽取。",
      ]
    : ["目前只先抽取前段文本，尚未做逐頁深讀。"];

  return {
    answer,
    sources: sourceLines.length ? sourceLines : ["已讀取 PDF，但尚未形成可引用摘要。"],
    limitations,
  };
}

export async function readPdfTaskAndBuildReply({
  pdfInputs = [],
  accessToken = "",
  question = "",
} = {}) {
  const readResult = await readPdfInputs({
    pdfInputs,
    accessToken,
  });
  return {
    ...buildPdfResponseFromReadResult({
      readResult,
      question,
    }),
    read_result: readResult,
  };
}
