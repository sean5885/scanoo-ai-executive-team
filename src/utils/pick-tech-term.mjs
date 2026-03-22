import { TECH_TERMS } from "../config/tech-terms.mjs";

export function pickTechTerm(question) {
  const normalizedQuestion = String(question || "").toLowerCase();

  for (const term of [...TECH_TERMS].sort((left, right) => right.length - left.length)) {
    if (normalizedQuestion.includes(term)) {
      return term;
    }
  }

  return null;
}
