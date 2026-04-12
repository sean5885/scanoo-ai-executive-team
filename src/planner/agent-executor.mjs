import { cleanText } from "../message-intent-utils.mjs";

const ACTION_EXECUTION_OWNER_MAP = Object.freeze({
  get_runtime_info: Object.freeze({
    agent: "runtime_agent",
    action: "runtime_check",
  }),
  list_company_brain_docs: Object.freeze({
    agent: "company_brain_agent",
    action: "company_brain_read",
  }),
  search_company_brain_docs: Object.freeze({
    agent: "company_brain_agent",
    action: "company_brain_read",
  }),
  get_company_brain_doc_detail: Object.freeze({
    agent: "company_brain_agent",
    action: "company_brain_read",
  }),
  search_and_detail_doc: Object.freeze({
    agent: "company_brain_agent",
    action: "company_brain_read",
  }),
  create_doc: Object.freeze({
    agent: "planner_agent",
    action: "planner_route",
  }),
  create_and_list_doc: Object.freeze({
    agent: "planner_agent",
    action: "planner_route",
  }),
  runtime_and_list_docs: Object.freeze({
    agent: "planner_agent",
    action: "planner_route",
  }),
  create_search_detail_list_doc: Object.freeze({
    agent: "planner_agent",
    action: "planner_route",
  }),
  search_and_summarize: Object.freeze({
    agent: "company_brain_agent",
    action: "company_brain_read",
  }),
  document_summarize: Object.freeze({
    agent: "company_brain_agent",
    action: "company_brain_read",
  }),
  ingest_learning_doc: Object.freeze({
    agent: "company_brain_agent",
    action: "company_brain_read",
  }),
  update_learning_state: Object.freeze({
    agent: "company_brain_agent",
    action: "company_brain_read",
  }),
  read_task_lifecycle_v1: Object.freeze({
    agent: "planner_agent",
    action: "planner_route",
  }),
  update_task_lifecycle_v1: Object.freeze({
    agent: "planner_agent",
    action: "planner_route",
  }),
  mark_resolved: Object.freeze({
    agent: "planner_agent",
    action: "planner_route",
  }),
});

const TASK_TYPE_EXECUTION_OWNER_MAP = Object.freeze({
  runtime_info: ACTION_EXECUTION_OWNER_MAP.get_runtime_info,
  doc_read: ACTION_EXECUTION_OWNER_MAP.search_company_brain_docs,
  document_lookup: ACTION_EXECUTION_OWNER_MAP.search_company_brain_docs,
  knowledge_read_skill: ACTION_EXECUTION_OWNER_MAP.search_and_summarize,
  skill_read: ACTION_EXECUTION_OWNER_MAP.search_and_summarize,
  document_summary_skill: ACTION_EXECUTION_OWNER_MAP.document_summarize,
});

const DEFAULT_EXECUTION = Object.freeze({
  agent: "planner_agent",
  action: "planner_route",
});

function resolveActionOwner(task = {}) {
  const actionCandidates = [
    cleanText(task?.selected_action || ""),
    cleanText(task?.action || ""),
    cleanText(task?.selectedAction || ""),
    cleanText(task?.intended_action || ""),
  ];

  for (const action of actionCandidates) {
    if (!action) {
      continue;
    }
    const mapped = ACTION_EXECUTION_OWNER_MAP[action];
    if (mapped) {
      return mapped;
    }
  }
  return null;
}

function resolveTaskTypeOwner(task = {}) {
  const taskTypeCandidates = [
    cleanText(task?.task_type || ""),
    cleanText(task?.taskType || ""),
  ];
  for (const taskType of taskTypeCandidates) {
    if (!taskType) {
      continue;
    }
    const mapped = TASK_TYPE_EXECUTION_OWNER_MAP[taskType];
    if (mapped) {
      return mapped;
    }
  }
  return null;
}

export function executeAgent(task = {}) {
  const actionOwner = resolveActionOwner(task);
  if (actionOwner) {
    return {
      agent: actionOwner.agent,
      action: actionOwner.action,
      status: "ok",
      source: "selected_action",
    };
  }

  const taskTypeOwner = resolveTaskTypeOwner(task);
  if (taskTypeOwner) {
    return {
      agent: taskTypeOwner.agent,
      action: taskTypeOwner.action,
      status: "ok",
      source: "task_type",
    };
  }

  return {
    agent: DEFAULT_EXECUTION.agent,
    action: DEFAULT_EXECUTION.action,
    status: "ok",
    source: "default",
  };
}

