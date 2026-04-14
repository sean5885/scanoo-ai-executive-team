import { documentSummarizeSkill } from "./skills/document-summarize-skill.mjs";
import { imageGenerateSkill } from "./skills/image-generate-skill.mjs";
import { searchAndSummarizeSkill } from "./skills/search-and-summarize-skill.mjs";
import { createSkillRegistry } from "./skill-runtime.mjs";
import { cleanText } from "./message-intent-utils.mjs";

const SKILL_METADATA_INDEX = Object.freeze({
  search_and_summarize: Object.freeze({
    capability: "knowledge_search_summary",
    required_args: Object.freeze(["account_id", "query"]),
    arg_aliases: Object.freeze({
      account_id: Object.freeze(["accountId"]),
      query: Object.freeze(["q"]),
      q: Object.freeze(["query"]),
    }),
    auth_requirements: Object.freeze({
      account_id: Object.freeze({
        required: true,
        planner_visible: true,
      }),
    }),
    health: Object.freeze({
      status: "healthy",
      check: "checked_in_runtime",
    }),
    fallback: Object.freeze({
      mode: "fail_closed",
      on_missing_account_id: "non_execution",
    }),
    read_only: true,
  }),
  document_summarize: Object.freeze({
    capability: "document_summary",
    required_args: Object.freeze(["account_id", "doc_id"]),
    arg_aliases: Object.freeze({
      account_id: Object.freeze(["accountId"]),
      doc_id: Object.freeze(["document_id", "id"]),
    }),
    auth_requirements: Object.freeze({
      account_id: Object.freeze({
        required: true,
        planner_visible: true,
      }),
    }),
    health: Object.freeze({
      status: "healthy",
      check: "checked_in_runtime",
    }),
    fallback: Object.freeze({
      mode: "fail_closed",
      on_missing_account_id: "non_execution",
    }),
    read_only: true,
  }),
  image_generate: Object.freeze({
    capability: "image_generate_internal",
    required_args: Object.freeze(["prompt"]),
    arg_aliases: Object.freeze({
      prompt: Object.freeze(["input", "query"]),
    }),
    auth_requirements: Object.freeze({
      account_id: Object.freeze({
        required: false,
        planner_visible: false,
      }),
    }),
    health: Object.freeze({
      status: "healthy",
      check: "checked_in_runtime",
    }),
    fallback: Object.freeze({
      mode: "fail_closed",
    }),
    read_only: true,
  }),
});

function normalizeSkillMetadata(entry = {}) {
  const metadata = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const aliases = metadata.arg_aliases && typeof metadata.arg_aliases === "object" && !Array.isArray(metadata.arg_aliases)
    ? metadata.arg_aliases
    : {};
  return Object.freeze({
    capability: cleanText(metadata.capability) || "unknown",
    required_args: Object.freeze(
      (Array.isArray(metadata.required_args) ? metadata.required_args : [])
        .map((item) => cleanText(item))
        .filter(Boolean),
    ),
    arg_aliases: Object.freeze(
      Object.fromEntries(
        Object.entries(aliases)
          .map(([key, aliasList]) => [
            cleanText(key),
            Object.freeze(
              (Array.isArray(aliasList) ? aliasList : [])
                .map((item) => cleanText(item))
                .filter(Boolean),
            ),
          ])
          .filter(([key]) => Boolean(key)),
      ),
    ),
    auth_requirements: Object.freeze(
      metadata.auth_requirements && typeof metadata.auth_requirements === "object" && !Array.isArray(metadata.auth_requirements)
        ? metadata.auth_requirements
        : {},
    ),
    health: Object.freeze(
      metadata.health && typeof metadata.health === "object" && !Array.isArray(metadata.health)
        ? metadata.health
        : {},
    ),
    fallback: Object.freeze(
      metadata.fallback && typeof metadata.fallback === "object" && !Array.isArray(metadata.fallback)
        ? metadata.fallback
        : {},
    ),
    read_only: metadata.read_only === true,
  });
}

function withSkillMetadata(definition = {}) {
  const skillName = cleanText(definition?.name);
  const metadata = normalizeSkillMetadata(SKILL_METADATA_INDEX[skillName] || {});
  return Object.freeze({
    ...definition,
    ...metadata,
  });
}

function normalizeArgsObject(args = {}) {
  return args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {};
}

function normalizeArgAliasMap(metadata = null) {
  const aliases = metadata?.arg_aliases && typeof metadata.arg_aliases === "object" && !Array.isArray(metadata.arg_aliases)
    ? metadata.arg_aliases
    : {};
  return Object.entries(aliases)
    .map(([canonicalArg, aliasList]) => ({
      canonicalArg: cleanText(canonicalArg),
      aliasList: Array.isArray(aliasList)
        ? aliasList.map((alias) => cleanText(alias)).filter(Boolean)
        : [],
    }))
    .filter((entry) => entry.canonicalArg);
}

function pickAliasValue(source = {}, keys = []) {
  for (const key of keys) {
    if (!(key in source)) {
      continue;
    }
    const value = source[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    return value;
  }
  return undefined;
}

export const defaultSkillRegistry = createSkillRegistry([
  withSkillMetadata(searchAndSummarizeSkill),
  withSkillMetadata(documentSummarizeSkill),
  withSkillMetadata(imageGenerateSkill),
]);

export function getSkillRegistryEntry(name = "") {
  const normalizedName = cleanText(name);
  if (!normalizedName) {
    return null;
  }
  return defaultSkillRegistry.get(normalizedName) || null;
}

export function getSkillMetadata(name = "") {
  const entry = getSkillRegistryEntry(name);
  if (!entry) {
    return null;
  }
  return {
    capability: cleanText(entry.capability) || "unknown",
    required_args: Array.isArray(entry.required_args) ? [...entry.required_args] : [],
    arg_aliases: entry.arg_aliases && typeof entry.arg_aliases === "object" && !Array.isArray(entry.arg_aliases)
      ? Object.fromEntries(
          Object.entries(entry.arg_aliases).map(([key, value]) => [key, Array.isArray(value) ? [...value] : []]),
        )
      : {},
    auth_requirements: entry.auth_requirements && typeof entry.auth_requirements === "object" && !Array.isArray(entry.auth_requirements)
      ? { ...entry.auth_requirements }
      : {},
    health: entry.health && typeof entry.health === "object" && !Array.isArray(entry.health)
      ? { ...entry.health }
      : {},
    fallback: entry.fallback && typeof entry.fallback === "object" && !Array.isArray(entry.fallback)
      ? { ...entry.fallback }
      : {},
    read_only: entry.read_only === true,
  };
}

export function normalizeSkillArgs(name = "", args = {}) {
  const metadata = getSkillMetadata(name);
  const normalizedArgs = normalizeArgsObject(args);
  if (!metadata) {
    return normalizedArgs;
  }

  for (const { canonicalArg, aliasList } of normalizeArgAliasMap(metadata)) {
    if (!(canonicalArg in normalizedArgs) || normalizedArgs[canonicalArg] == null || normalizedArgs[canonicalArg] === "") {
      const resolved = pickAliasValue(normalizedArgs, aliasList);
      if (resolved !== undefined) {
        normalizedArgs[canonicalArg] = resolved;
      }
    }
  }

  return normalizedArgs;
}
