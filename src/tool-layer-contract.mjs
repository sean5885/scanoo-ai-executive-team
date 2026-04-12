export const TOOL_LAYER_REGISTRY = {
  search_company_brain_docs: {
    capability: "knowledge_retrieval",
    required_args: ["q"],
    on_success_next: "continue_planner",
    on_failure_next: "retry_or_fallback",
  },
  official_read_document: {
    capability: "document_read",
    required_args: ["document_ref"],
    on_success_next: "continue_planner",
    on_failure_next: "ask_or_fallback",
  },
  answer_user_directly: {
    capability: "direct_answer",
    required_args: ["answer"],
    on_success_next: "complete_task",
    on_failure_next: "fallback",
  },
};

export function resolveToolContract(action) {
  return TOOL_LAYER_REGISTRY[action] || null;
}

function hasRequiredArg(action, args = {}, arg = "") {
  if (action === "search_company_brain_docs" && arg === "q") {
    const q = args?.q;
    const query = args?.query;
    return (
      (q != null && q !== "")
      || (query != null && query !== "")
    );
  }
  return args?.[arg] != null && args?.[arg] !== "";
}

export function validateToolInvocation(action, args = {}) {
  const contract = resolveToolContract(action);
  if (!contract) {
    return { ok: false, reason: "unknown_tool_action" };
  }
  const missing = contract.required_args.filter((k) => !hasRequiredArg(action, args, k));
  if (missing.length > 0) {
    return { ok: false, reason: "missing_required_args", missing };
  }
  return { ok: true, contract };
}
