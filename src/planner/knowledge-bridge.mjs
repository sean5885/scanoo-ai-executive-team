import { queryKnowledgeWithContext } from "../knowledge/knowledge-service.mjs";
import { buildAnswer } from "./answer-builder.mjs";

export function plannerAnswer(input) {
  if (!input || !input.keyword) {
    return { error: "invalid_input" };
  }

  const results = queryKnowledgeWithContext(input.keyword);
  const answer = buildAnswer(input.keyword, results);
  return {
    answer,
    count: results.length,
  };
}
