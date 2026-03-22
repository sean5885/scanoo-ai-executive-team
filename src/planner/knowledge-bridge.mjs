import { queryKnowledgeWithContext } from "../knowledge/knowledge-service.mjs";

export function plannerQueryKnowledge(input) {
  if (!input || typeof input !== "object" || !input.keyword) {
    return { error: "invalid_input" };
  }

  const results = queryKnowledgeWithContext(input.keyword);
  return {
    count: results.length,
    results,
  };
}
