import { loadDocsFromDir } from "./doc-loader.mjs";
import { searchDocsByKeyword } from "./doc-index.mjs";

let cachedIndex = null;

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

  const start = Math.max(0, index - 40);
  const end = Math.min(content.length, index + keyword.length + 80);
  return content.slice(start, end);
}

export function getIndex() {
  if (!cachedIndex) {
    cachedIndex = loadDocsFromDir("./docs/system");
  }
  return cachedIndex;
}

export function queryKnowledge(keyword) {
  const index = getIndex();
  return searchDocsByKeyword(index, keyword);
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
