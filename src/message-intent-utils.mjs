import { extractLarkBitableReferenceFromText } from "./lark-url-utils.mjs";

const STRUCTURED_SIGNAL_KEYS = new Set([
  "text",
  "title",
  "file_name",
  "name",
  "doc_token",
  "document_id",
  "obj_token",
  "token",
  "file_key",
  "file_token",
  "url",
  "link",
  "href",
  "message_type",
  "msg_type",
]);

const EXPLICIT_DOCUMENT_KEYS = new Set([
  "doc_token",
  "document_id",
  "obj_token",
  "file_key",
  "file_token",
]);

const CONTEXTUAL_DOCUMENT_KEYS = new Set(["token"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function cleanText(value) {
  const text = String(value || "").trim();
  return text || "";
}

export function safeParseJson(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function collectStructuredSignals(value, bucket = []) {
  if (!value) {
    return bucket;
  }

  if (typeof value === "string") {
    const text = value.trim();
    if (text) {
      bucket.push(text);
    }
    return bucket;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredSignals(item, bucket);
    }
    return bucket;
  }

  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (STRUCTURED_SIGNAL_KEYS.has(key)) {
        collectStructuredSignals(nested, bucket);
        continue;
      }
      if (nested && typeof nested === "object") {
        collectStructuredSignals(nested, bucket);
      }
    }
  }

  return bucket;
}

function pushUnique(bucket, value) {
  const text = cleanText(value);
  if (!text || bucket.includes(text)) {
    return;
  }
  bucket.push(text);
}

function looksLikeDocumentUrl(text) {
  return /\/(?:docx|wiki)\//i.test(text);
}

function looksLikePrefixedDocumentToken(text) {
  return /\b(?:doccn|docx|doxc)[A-Za-z0-9]+\b/i.test(text);
}

function isSimpleToken(text) {
  return /^[A-Za-z0-9_-]{8,}$/.test(text);
}

function objectLooksDocLike(value) {
  if (!isPlainObject(value)) {
    return false;
  }

  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (EXPLICIT_DOCUMENT_KEYS.has(normalizedKey)) {
      return true;
    }

    const nestedText = typeof nested === "string" ? nested : "";
    if (["url", "href", "link"].includes(normalizedKey) && looksLikeDocumentUrl(nestedText)) {
      return true;
    }
    if (
      ["message_type", "msg_type", "type"].includes(normalizedKey) &&
      /doc|wiki|file/i.test(nestedText)
    ) {
      return true;
    }
    if (looksLikePrefixedDocumentToken(nestedText)) {
      return true;
    }
  }

  return false;
}

function extractDocumentIdsFromText(text, bucket = []) {
  const raw = cleanText(text);
  if (!raw) {
    return bucket;
  }

  const urlPatterns = [
    /\/docx\/([A-Za-z0-9_-]+)/gi,
    /\/wiki\/([A-Za-z0-9_-]+)/gi,
  ];
  for (const pattern of urlPatterns) {
    for (const match of raw.matchAll(pattern)) {
      pushUnique(bucket, match[1] || match[0]);
    }
  }

  for (const match of raw.matchAll(/\b(?:doccn|docx|doxc)[A-Za-z0-9]+\b/gi)) {
    pushUnique(bucket, match[0]);
  }

  const explicitFieldPatterns = [
    /(?:document_id|doc_token|obj_token|file_key|file_token)\s*["':=, ]+\s*([A-Za-z0-9_-]+)/gi,
  ];
  for (const pattern of explicitFieldPatterns) {
    for (const match of raw.matchAll(pattern)) {
      pushUnique(bucket, match[1] || match[0]);
    }
  }

  return bucket;
}

function collectDocumentCandidates(value, bucket = [], parentKey = "", docLikeContext = false) {
  if (!value) {
    return bucket;
  }

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return bucket;
    }

    const normalizedKey = parentKey.toLowerCase();
    if (EXPLICIT_DOCUMENT_KEYS.has(normalizedKey) && isSimpleToken(text)) {
      pushUnique(bucket, text);
    } else if (CONTEXTUAL_DOCUMENT_KEYS.has(normalizedKey) && docLikeContext && isSimpleToken(text)) {
      pushUnique(bucket, text);
    }

    extractDocumentIdsFromText(text, bucket);
    return bucket;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectDocumentCandidates(item, bucket, parentKey, docLikeContext);
    }
    return bucket;
  }

  if (isPlainObject(value)) {
    const nextDocLikeContext = docLikeContext || objectLooksDocLike(value);
    for (const [key, nested] of Object.entries(value)) {
      collectDocumentCandidates(nested, bucket, key, nextDocLikeContext);
    }
  }

  return bucket;
}

function collectRawContent(input = {}) {
  return (
    cleanText(input.content) ||
    cleanText(input.message?.content) ||
    cleanText(input.event?.message?.content) ||
    ""
  );
}

export function buildMessageText(input = {}) {
  const rawContent = collectRawContent(input);
  const parsedContent = safeParseJson(rawContent);
  const parts = [
    cleanText(input.message_text),
    cleanText(input.text),
    cleanText(input.msg_type),
    cleanText(input.message_type),
    cleanText(input.message?.text),
    cleanText(input.message?.message_type),
    cleanText(input.message?.msg_type),
    cleanText(input.event?.message_text),
    rawContent,
    ...collectStructuredSignals(parsedContent),
  ].filter(Boolean);
  return parts.join(" ").trim();
}

export function buildVisibleMessageText(input = {}) {
  const rawContent = collectRawContent(input);
  const parsedContent = safeParseJson(rawContent);
  const parts = [
    cleanText(input.message_text),
    cleanText(input.text),
    cleanText(input.message?.text),
    cleanText(input.event?.message_text),
    ...collectStructuredSignals(parsedContent),
  ]
    .filter(Boolean)
    .filter((part, index, bucket) => bucket.indexOf(part) === index);
  return parts.join(" ").trim();
}

export function normalizeMessageText(input = {}) {
  return buildMessageText(input).toLowerCase();
}

export function extractDocumentId(input = {}) {
  const candidates = [];
  collectDocumentCandidates(input, candidates);
  return candidates[0] || "";
}

export function extractBitableReference(input = {}) {
  const rawContent = collectRawContent(input);
  const parsedContent = safeParseJson(rawContent);
  const parts = [
    cleanText(input.message_text),
    cleanText(input.text),
    cleanText(input.message?.text),
    cleanText(input.event?.message_text),
    rawContent,
    ...collectStructuredSignals(parsedContent),
  ].filter(Boolean);

  for (const part of parts) {
    const ref = extractLarkBitableReferenceFromText(part);
    if (ref?.app_token) {
      return ref;
    }
  }

  return null;
}

export function collectRelatedMessageIds(input = {}) {
  const message = input?.message || {};
  const direct = [
    cleanText(input.parent_id),
    cleanText(input.upper_message_id),
    cleanText(input.root_id),
  ];
  const nested = [
    cleanText(message.parent_id),
    cleanText(message.upper_message_id),
    cleanText(message.root_id),
  ];
  return [...new Set([...direct, ...nested].filter(Boolean))];
}
