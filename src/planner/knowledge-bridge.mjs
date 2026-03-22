import { queryKnowledgeWithContext } from "../knowledge/knowledge-service.mjs";
import { cleanSnippet } from "../knowledge/snippet-cleaner.mjs";
import { buildAnswer } from "./answer-builder.mjs";
import { parseIntent } from "./intent-parser.mjs";
import { rewriteQuery } from "./query-rewrite.mjs";
import { summarizeWithMinimax } from "./llm-summary.mjs";

function dedupeKnowledgeResults(results = []) {
  return Array.from(
    new Map(
      (Array.isArray(results) ? results : [])
        .filter((item) => item && typeof item === "object")
        .map((item) => [item.id, item]),
    ).values(),
  );
}

export async function plannerAnswer(
  input,
  {
    summarize = summarizeWithMinimax,
    parse = parseIntent,
    rewrite = rewriteQuery,
  } = {},
) {
  const keyword = typeof input?.keyword === "string" ? input.keyword.trim() : "";
  const question = typeof input?.question === "string" ? input.question.trim() : "";
  let finalKeyword = keyword;

  if (!finalKeyword && question) {
    try {
      finalKeyword = await parse(question) || "";
    } catch {
      finalKeyword = "";
    }
  }

  if (!finalKeyword) {
    return {
      answer: "請提供查詢關鍵字",
      count: 0,
      sources: [],
    };
  }

  let keys = [];
  try {
    const rewrittenKeys = rewrite(finalKeyword, question);
    keys = Array.isArray(rewrittenKeys) ? rewrittenKeys : [];
  } catch {
    keys = [];
  }
  if (keys.length === 0) {
    keys = [finalKeyword];
  }

  const results = dedupeKnowledgeResults(
    keys.flatMap((key) => queryKnowledgeWithContext(key)),
  );
  let answer = buildAnswer(finalKeyword, results);

  try {
    answer = await summarize({
      keyword: finalKeyword,
      results,
    });
  } catch {
    answer = buildAnswer(finalKeyword, results);
  }

  return {
    answer,
    count: results.length,
    sources: results.map((item, index) => ({
      id: item.id,
      index: index + 1,
      snippet: cleanSnippet(item.snippet, finalKeyword),
    })),
  };
}
