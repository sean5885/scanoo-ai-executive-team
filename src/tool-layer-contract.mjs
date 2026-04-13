export const TOOL_LAYER_REGISTRY = {
  search_company_brain_docs: {
    capability: "knowledge_retrieval",
    required_args: ["q"],
    arg_aliases: {
      q: ["query"],
    },
    on_success_next: "continue_planner",
    on_failure_next: "retry",
  },
  official_read_document: {
    capability: "document_read",
    required_args: ["document_ref"],
    arg_aliases: {},
    on_success_next: "continue_planner",
    on_failure_next: "ask_user",
  },
  answer_user_directly: {
    capability: "direct_answer",
    required_args: ["answer"],
    arg_aliases: {},
    on_success_next: "complete_task",
    on_failure_next: "fallback",
  },
};

export function resolveToolContract(action) {
  return TOOL_LAYER_REGISTRY[action] || null;
}

function normalizeToolArgsObject(args = {}) {
  return args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {};
}

function normalizeAliasEntries(aliasMap = {}) {
  if (!aliasMap || typeof aliasMap !== "object" || Array.isArray(aliasMap)) {
    return [];
  }
  return Object.entries(aliasMap)
    .map(([canonicalArg, aliases]) => ({
      canonicalArg,
      aliases: Array.isArray(aliases) ? aliases : [],
    }))
    .filter(({ canonicalArg }) => Boolean(canonicalArg));
}

function pickPresentValue(args = {}, keys = []) {
  for (const key of keys) {
    if (!(key in args)) {
      continue;
    }
    const value = args[key];
    if (value == null || value === "") {
      continue;
    }
    return value;
  }
  return undefined;
}

export function normalizeToolInvocationArgs(action, args = {}) {
  const contract = resolveToolContract(action);
  const normalized = normalizeToolArgsObject(args);
  if (!contract) {
    return normalized;
  }

  for (const { canonicalArg, aliases } of normalizeAliasEntries(contract.arg_aliases)) {
    if (normalized[canonicalArg] == null || normalized[canonicalArg] === "") {
      const value = pickPresentValue(normalized, aliases);
      if (value !== undefined) {
        normalized[canonicalArg] = value;
      }
    }
  }

  return normalized;
}

export function validateToolInvocation(action, args = {}) {
  const contract = resolveToolContract(action);
  if (!contract) {
    return { ok: false, reason: "unknown_tool_action" };
  }
  const normalizedArgs = normalizeToolInvocationArgs(action, args);
  const missing = contract.required_args.filter((key) => (
    normalizedArgs?.[key] == null || normalizedArgs[key] === ""
  ));
  if (missing.length > 0) {
    return { ok: false, reason: "missing_required_args", missing };
  }
  return { ok: true, contract, args: normalizedArgs };
}
