import { queryKnowledge } from "../knowledge/knowledge-service.mjs";

export function plannerQueryKnowledge(input) {
  if (!input || typeof input !== "object" || !input.keyword) {
    return { error: "invalid_input" };
  }

  const result = queryKnowledge(input.keyword);
  return {
    count: result.length,
    top: result.slice(0, 3).map((item) => item.id),
  };
}
