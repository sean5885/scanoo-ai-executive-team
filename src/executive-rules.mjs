import { cleanText } from "./message-intent-utils.mjs";

export const GLOBAL_RULES = Object.freeze([
  "沒有 evidence 不可宣稱 completed。",
  "沒有 verification pass 不可進 completed。",
  "先回答使用者真正的問題，不先列 agent 名單。",
  "不確定時必須明確標記待確認或不確定。",
  "高風險任務先檢查 preconditions。",
  "重要輸出必須經 verifier 或 self-check。",
  "已開始、已委派、已回覆都不等於已完成。",
]);

export const KNOWLEDGE_RULES = Object.freeze({
  direct_write_conditions: [
    "內容穩定且非會議草稿",
    "有明確 evidence 支撐",
    "無 conflict 訊號",
    "通過 verifier",
  ],
  proposal_required_conditions: [
    "來自 meeting 決策或摘要",
    "屬於新規則、新流程、新 owner 判定",
    "會影響長期知識或跨角色協作",
  ],
  conflict_detection_conditions: [
    "與既有文件結論不一致",
    "owner / deadline / policy 相互衝突",
    "多份來源指向不同的確認版",
  ],
  unstable_write_policy: "unstable knowledge 只能進 pending proposal memory，不可直寫 approved long-term memory。",
});

export const TOOL_RULES = Object.freeze({
  must_use_tool_for: [
    "需要宣稱已寫入文檔",
    "需要宣稱已發群組訊息",
    "需要宣稱已建立任務或 proposal",
    "需要確認知識搜尋結果或文件存在",
  ],
  no_empty_claims: "如果工具沒有回傳成功 evidence，不可空口宣稱已完成。",
  failure_policy: "工具失敗時先回退到保守摘要或 pending 狀態，再決定 retry / escalate。",
});

export const MEETING_RULES = Object.freeze({
  required_fields: [
    "summary",
    "decisions",
    "action_items",
    "owner",
    "deadline",
    "risks",
    "open_questions",
    "knowledge_writeback",
  ],
  write_policy: "meeting 內容先進 summary / proposal / conflict / task pipeline，不直接無條件寫入長期知識。",
});

const TASK_RULE_TEMPLATES = Object.freeze({
  search: {
    goal: "找出與請求最相關的來源與結論。",
    success_criteria: ["有可讀結論", "有來源證據", "沒有把未驗證內容當事實"],
    failure_criteria: ["沒有來源", "只回流程狀態", "結論與 evidence 脫節"],
    evidence_requirements: ["tool_output", "summary_generated"],
    validation_method: "checklist:search",
    retry_policy: "缺來源時先縮小範圍或保守回答一次。",
    escalation_policy: "連續無來源時回報待同步或待提供更多上下文。",
    risk_level: "medium",
  },
  summarize: {
    goal: "把來源內容整理成可用摘要。",
    success_criteria: ["摘要完整", "重點可行動", "保留待確認點"],
    failure_criteria: ["流水帳", "遺漏關鍵欄位", "假裝已確認"],
    evidence_requirements: ["summary_generated"],
    validation_method: "checklist:summarize",
    retry_policy: "缺欄位時按模板補齊一次。",
    escalation_policy: "來源缺失時標示待確認。",
    risk_level: "medium",
  },
  decision_support: {
    goal: "整合資訊並提供決策建議。",
    success_criteria: ["先回答問題", "有依據", "有風險與下一步"],
    failure_criteria: ["只列流程", "只列 agent", "沒有可執行結論"],
    evidence_requirements: ["tool_output", "summary_generated"],
    validation_method: "checklist:decision_support",
    retry_policy: "結論不足時補一輪 supporting context 整合。",
    escalation_policy: "高風險或 evidence 不足時標示待確認。",
    risk_level: "high",
  },
  document_review: {
    goal: "根據使用者需求，對一組文件做可重用的 review/triage。",
    success_criteria: ["有可讀結論", "有 referenced documents", "有理由", "有下一步"],
    failure_criteria: ["沒有文件集合", "只有文件清單沒有判斷", "沒有 evidence 就宣稱完成"],
    evidence_requirements: ["tool_output", "summary_generated", "structured_output"],
    validation_method: "checklist:document_review",
    retry_policy: "命中不足時保留待確認並建議補更精準的文件範圍或關鍵詞。",
    escalation_policy: "缺文件集合或 evidence 不足時進 blocked/retry，不包裝成完成。",
    risk_level: "medium",
  },
  knowledge_write: {
    goal: "把穩定知識寫入正確 memory 層。",
    success_criteria: ["符合 write policy", "有 proposal 或 approved write evidence", "有 conflict 判斷"],
    failure_criteria: ["unstable 直接寫入", "沒有 evidence 就宣稱已更新知識"],
    evidence_requirements: ["knowledge_proposal_created", "DB_write_confirmed"],
    validation_method: "checklist:knowledge_write",
    retry_policy: "缺 evidence 時先改為 proposal-only。",
    escalation_policy: "有衝突時送 conflict queue。",
    risk_level: "high",
  },
  meeting_processing: {
    goal: "把會議內容轉成 decisions、action items、knowledge/task writeback。",
    success_criteria: ["summary 完整", "decision/action items 可用", "缺 owner/deadline 有標記", "產出 knowledge/task writeback"],
    failure_criteria: ["只有聊天稿", "action items 缺 owner 且未標記", "沒有 verification 就視為完成"],
    evidence_requirements: ["summary_generated", "structured_output"],
    validation_method: "checklist:meeting_processing",
    retry_policy: "缺欄位時先補 open_questions 與待確認 owner/deadline。",
    escalation_policy: "決策衝突時送 conflict / proposal。",
    risk_level: "high",
  },
  proposal_creation: {
    goal: "產出可審批的 proposal。",
    success_criteria: ["proposal 結構完整", "有 scope / rationale / impact"],
    failure_criteria: ["只有口號沒有 proposal body"],
    evidence_requirements: ["knowledge_proposal_created"],
    validation_method: "checklist:proposal_creation",
    retry_policy: "缺欄位時補 proposal body。",
    escalation_policy: "高風險變更保留 human approval required。",
    risk_level: "high",
  },
  prd_generation: {
    goal: "輸出工程可執行 PRD。",
    success_criteria: ["包含背景/目標/範圍/驗收/風險/待確認"],
    failure_criteria: ["空泛願景", "缺驗收", "缺風險"],
    evidence_requirements: ["summary_generated", "structured_output"],
    validation_method: "checklist:prd_generation",
    retry_policy: "缺欄位時按模板補齊一次。",
    escalation_policy: "關鍵需求未確認時標示待確認。",
    risk_level: "high",
  },
  task_assignment: {
    goal: "產出可分派 action items。",
    success_criteria: ["有 owner", "有 title", "高風險時有 deadline 或待確認標記"],
    failure_criteria: ["只有 todo 沒 owner", "假裝已指派"],
    evidence_requirements: ["action_items_created", "structured_output"],
    validation_method: "checklist:task_assignment",
    retry_policy: "owner 缺失時保留待確認。",
    escalation_policy: "持續缺 owner 時交給主責 agent 或 human confirm。",
    risk_level: "high",
  },
});

export const TASK_TYPES = Object.freeze(Object.keys(TASK_RULE_TEMPLATES));

export function inferTaskType({ agentId = "", requestText = "", workflow = "" } = {}) {
  const text = cleanText(String(requestText || "").toLowerCase());
  if (workflow === "meeting" || text.includes("會議") || text.includes("meeting")) {
    return "meeting_processing";
  }
  if (workflow === "document_review" || text.includes("triage") || (text.includes("review") && text.includes("文件"))) {
    return "document_review";
  }
  if (agentId === "prd" || text.includes("prd") || text.includes("驗收")) {
    return "prd_generation";
  }
  if (text.includes("proposal") || text.includes("提案")) {
    return "proposal_creation";
  }
  if (agentId.startsWith("knowledge-") || text.includes("knowledge") || text.includes("知識")) {
    if (text.includes("approve") || text.includes("reject") || text.includes("寫入") || text.includes("learn")) {
      return "knowledge_write";
    }
    return "search";
  }
  if (text.includes("指派") || text.includes("分配") || text.includes("owner")) {
    return "task_assignment";
  }
  if (agentId === "ceo" || agentId === "consult" || text.includes("決策") || text.includes("風險")) {
    return "decision_support";
  }
  if (text.includes("摘要") || text.includes("總結") || text.includes("整理")) {
    return "summarize";
  }
  return "search";
}

export function buildTaskRuleSet({ taskType = "search", objective = "", agentId = "" } = {}) {
  const template = TASK_RULE_TEMPLATES[taskType] || TASK_RULE_TEMPLATES.search;
  return {
    task_type: taskType,
    goal: cleanText(objective) || template.goal,
    success_criteria: [...template.success_criteria],
    failure_criteria: [...template.failure_criteria],
    evidence_requirements: [...template.evidence_requirements],
    validation_method: template.validation_method,
    retry_policy: template.retry_policy,
    escalation_policy: template.escalation_policy,
    risk_level: template.risk_level,
    owner_agent_id: cleanText(agentId) || "generalist",
  };
}
