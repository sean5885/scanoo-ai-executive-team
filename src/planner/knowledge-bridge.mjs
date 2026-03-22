import { queryKnowledgeWithContext } from "../knowledge/knowledge-service.mjs";
import { buildAnswer } from "./answer-builder.mjs";
import { parseIntent } from "./intent-parser.mjs";
import { summarizeWithMinimax } from "./llm-summary.mjs";

export async function plannerAnswer(
  input,
  {
    summarize = summarizeWithMinimax,
    parse = parseIntent,
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
    };
  }

  const results = queryKnowledgeWithContext(finalKeyword);
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
  };
}
