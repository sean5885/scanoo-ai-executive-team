import { cleanSnippet } from "./knowledge/snippet-cleaner.mjs";
import { cleanText } from "./message-intent-utils.mjs";

function normalizeSourceMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  return {
    document_id: cleanText(metadata.document_id || metadata.documentId || ""),
    title: cleanText(metadata.title || ""),
    url: cleanText(metadata.url || ""),
    source_type: cleanText(metadata.source_type || metadata.sourceType || ""),
    chunk_index: Number.isInteger(metadata.chunk_index) ? metadata.chunk_index : null,
    updated_at: cleanText(metadata.updated_at || metadata.updatedAt || ""),
    extractor_version: cleanText(metadata.extractor_version || metadata.extractorVersion || ""),
    page_count: Number.isInteger(metadata.page_count) ? metadata.page_count : null,
  };
}

function buildFallbackSourceId(metadata = {}) {
  const documentId = cleanText(metadata.document_id || "");
  if (!documentId) {
    return "";
  }
  if (Number.isInteger(metadata.chunk_index)) {
    return `${documentId}:${metadata.chunk_index}`;
  }
  return documentId;
}

export function buildReadSourceItem(item = {}, { query = "" } = {}) {
  const metadata = normalizeSourceMetadata({
    document_id: item?.document_id,
    title: item?.title,
    url: item?.url,
    source_type: item?.source_type,
    chunk_index: item?.chunk_index,
    updated_at: item?.updated_at,
    ...(item?.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata) ? item.metadata : {}),
  });
  const id = cleanText(item?.id || "") || buildFallbackSourceId(metadata);
  const snippet = cleanSnippet(item?.snippet || item?.content || "", cleanText(query || ""));

  if (!id || !snippet) {
    return null;
  }

  return {
    id,
    snippet,
    metadata,
  };
}

export function buildReadSourceItems(items = [], { query = "" } = {}) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const seen = new Set();
  const results = [];

  for (const item of normalizedItems) {
    const normalized = buildReadSourceItem(item, { query });
    if (!normalized || seen.has(normalized.id)) {
      continue;
    }
    seen.add(normalized.id);
    results.push(normalized);
  }

  return results;
}

export function getReadSourceTitle(item = {}) {
  return cleanText(item?.metadata?.title || "");
}

export function getReadSourceUrl(item = {}) {
  return cleanText(item?.metadata?.url || "");
}

export function getReadSourceSnippet(item = {}) {
  return cleanText(item?.snippet || "");
}
