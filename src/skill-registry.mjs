import { searchAndSummarizeSkill } from "./skills/search-and-summarize-skill.mjs";
import { createSkillRegistry } from "./skill-runtime.mjs";

export const defaultSkillRegistry = createSkillRegistry([
  searchAndSummarizeSkill,
]);
