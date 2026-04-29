import { cleanText } from "./message-intent-utils.mjs";
import { buildCanonicalAnswerSources, mapCanonicalAnswerSourcesToLines } from "./answer-source-mapper.mjs";

function buildPageCitation(metadata = {}) {
  const page = Number.isInteger(metadata?.pdf_page) ? metadata.pdf_page : null;
  if (!page) {
    return "";
  }
  return `第${page}頁`;
}

export function buildPdfAnswer({
  question = "",
  chunks = [],
  maxSources = 3,
} = {}) {
  const canonicalSources = buildCanonicalAnswerSources(chunks, {
    query: cleanText(question || ""),
  });
  const sourceLines = mapCanonicalAnswerSourcesToLines(canonicalSources, {
    maxSources,
  });
  const firstSnippet = cleanText(canonicalSources?.[0]?.snippet || "");
  const firstPage = buildPageCitation(canonicalSources?.[0]?.metadata || {});

  return {
    answer: firstSnippet
      ? `${firstSnippet}${firstPage ? `（${firstPage}）` : ""}`
      : "目前沒有可用的 PDF chunk 證據可回答。",
    sources: sourceLines,
    limitations: firstSnippet
      ? []
      : ["待確認：PDF chunk evidence 缺失，無法完成回答。"],
  };
}
