import { loadDocsFromDir } from "./doc-loader.mjs";
import { searchDocsByKeyword } from "./doc-index.mjs";

let cachedIndex = null;

function safeSlice(content, start, end) {
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(content.length, end);
  return content.slice(safeStart, safeEnd);
}

function extractSnippet(content, keyword) {
  if (typeof content !== "string" || !content) {
    return "";
  }

  if (typeof keyword !== "string" || !keyword.trim()) {
    return content.slice(0, 120);
  }

  const normalizedContent = content.toLowerCase();
  const normalizedKeyword = keyword.toLowerCase();
  const index = normalizedContent.indexOf(normalizedKeyword);

  if (index === -1) {
    return content.slice(0, 120);
  }

  let start = Math.max(0, index - 80);
  let end = Math.min(content.length, index + keyword.length + 140);

  const previousBreak = Math.max(
    content.lastIndexOf("\n", start),
    content.lastIndexOf(". ", start),
    content.lastIndexOf("。", start),
    content.lastIndexOf(": ", start),
    content.lastIndexOf("：", start),
    content.lastIndexOf("- ", start),
  );

  const nextCandidates = [
    content.indexOf("\n", end),
    content.indexOf(". ", end),
    content.indexOf("。", end),
    content.indexOf(": ", end),
    content.indexOf("：", end),
  ].filter((candidate) => candidate !== -1);

  if (previousBreak !== -1) {
    start = previousBreak + 1;
  }
  if (nextCandidates.length > 0) {
    end = Math.min(...nextCandidates) + 1;
  }

  return safeSlice(content, start, end).trim();
}

export function getIndex() {
  if (!cachedIndex) {
    cachedIndex = loadDocsFromDir("./docs/system");
  }
  return cachedIndex;
}

export function queryKnowledge(keyword) {
  return searchDocsByKeyword(getIndex(), keyword);
}

export function queryKnowledgeWithSnippet(keyword) {
  return queryKnowledge(keyword).slice(0, 3).map((doc) => ({
    id: doc.id,
    snippet: extractSnippet(doc.content, keyword),
  }));
}

export function queryKnowledgeWithContext(keyword) {
  return queryKnowledgeWithSnippet(keyword);
}
