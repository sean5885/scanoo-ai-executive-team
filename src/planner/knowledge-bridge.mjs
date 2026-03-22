import { queryKnowledgeWithContext } from "../knowledge/knowledge-service.mjs";
import { buildAnswer } from "./answer-builder.mjs";
import { summarizeWithMinimax } from "./llm-summary.mjs";

export async function plannerAnswer(input, { summarize = summarizeWithMinimax } = {}) {
  const keyword = typeof input?.keyword === "string" ? input.keyword.trim() : "";

  if (!keyword) {
    return {
      answer: "請提供查詢關鍵字",
      count: 0,
    };
  }

  const results = queryKnowledgeWithContext(keyword);
  let answer = buildAnswer(keyword, results);

  try {
    answer = await summarize({
      keyword,
      results,
    });
  } catch {
    answer = buildAnswer(keyword, results);
  }

  return {
    answer,
    count: results.length,
  };
}
