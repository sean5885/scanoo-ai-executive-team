import { chunkText } from "./chunking.mjs";
import { cleanText } from "./message-intent-utils.mjs";

function normalizePdfPages(extracted = {}) {
  const explicitPages = Array.isArray(extracted?.pages) ? extracted.pages : [];
  const normalized = explicitPages
    .map((item, index) => ({
      page: Number.isInteger(item?.page) && item.page > 0 ? item.page : index + 1,
      text: cleanText(item?.text || ""),
    }))
    .filter((item) => item.text);
  if (normalized.length > 0) {
    return normalized;
  }
  const text = cleanText(extracted?.text || "");
  if (!text) {
    return [];
  }
  return [{
    page: 1,
    text,
  }];
}

export function buildPdfChunks({
  extracted = {},
  documentId = "",
  title = "",
  sourceUrl = "",
  sourceType = "pdf_chunk",
  chunkOptions = {},
} = {}) {
  const pages = normalizePdfPages(extracted);
  const normalizedDocumentId = cleanText(documentId || "") || "pdf_document";
  const normalizedTitle = cleanText(title || "") || normalizedDocumentId;
  const normalizedUrl = cleanText(sourceUrl || "");
  const chunks = [];

  for (const page of pages) {
    const pageChunks = chunkText(page.text, chunkOptions);
    for (const item of pageChunks) {
      const chunkId = `${normalizedDocumentId}:p${page.page}:c${item.chunk_index}`;
      const pageUrl = normalizedUrl ? `${normalizedUrl}#page=${page.page}` : "";
      chunks.push({
        id: chunkId,
        snippet: cleanText(item.content || ""),
        metadata: {
          document_id: normalizedDocumentId,
          title: normalizedTitle,
          url: normalizedUrl,
          pdf_chunk_url: pageUrl,
          source_type: sourceType,
          chunk_index: item.chunk_index,
          pdf_page: page.page,
          page_start: page.page,
          page_end: page.page,
        },
      });
    }
  }

  return chunks.filter((item) => item.id && item.snippet);
}
