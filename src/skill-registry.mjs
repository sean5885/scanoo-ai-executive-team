import { documentSummarizeSkill } from "./skills/document-summarize-skill.mjs";
import { searchAndSummarizeSkill } from "./skills/search-and-summarize-skill.mjs";
import { createSkillRegistry } from "./skill-runtime.mjs";

// This registry is only for checked-in repo-local runtime skills.
// External skill mirrors under ~/.agents or ~/.codex are docs/governance
// surfaces and are not loaded here.
export const defaultSkillRegistry = createSkillRegistry([
  searchAndSummarizeSkill,
  documentSummarizeSkill,
]);
