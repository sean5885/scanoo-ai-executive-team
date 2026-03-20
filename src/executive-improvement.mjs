import crypto from "node:crypto";

import { cleanText } from "./message-intent-utils.mjs";

export function createImprovementProposals({ reflection = null, task = null } = {}) {
  const issues = Array.isArray(reflection?.what_went_wrong) ? reflection.what_went_wrong : [];
  const proposals = [];

  function push(category, mode, title, description, target = "") {
    proposals.push({
      id: crypto.randomUUID(),
      task_id: cleanText(task?.id),
      category,
      mode,
      title,
      description,
      target: cleanText(target),
      status: "proposed",
      created_at: new Date().toISOString(),
    });
  }

  if (issues.includes("fake_completion")) {
    push("verification_improvement", "auto_apply", "Strengthen completion gate", "對 completed 前的 evidence gate 加嚴，避免沒有證據仍宣稱完成。", "executive-verifier");
  }
  if (issues.includes("insufficient_evidence")) {
    push("rule_improvement", "auto_apply", "Require evidence before answer closure", "補強需要工具或來源的任務類型，使結案前必須看到工具或來源證據。", "executive-rules");
  }
  if (issues.includes("wrong_routing")) {
    push("routing_improvement", "proposal_only", "Update routing hints", "將這類 follow-up 加進同一 workflow 的延續判定，減少掉錯 lane。", "lane-executor");
  }
  if (issues.includes("robotic_response")) {
    push("prompt_improvement", "proposal_only", "Reduce robotic phrasing", "把模板前綴與制度化語氣再收斂，先回答問題本身。", "agent-dispatcher");
  }
  if (issues.includes("missing_owner") || issues.includes("action_item_missing_owner")) {
    push("meeting_agent_improvement", "auto_apply", "Require action item owner placeholders", "會議輸出若缺 owner，必須在 open_questions 與 checklist 補待確認 owner。", "meeting-agent");
  }
  if (issues.includes("missing_deadline") || issues.includes("deadline_missing")) {
    push("meeting_agent_improvement", "auto_apply", "Require deadline placeholder or open question", "會議輸出若缺 deadline，必須補待確認 deadline 或 open question。", "meeting-agent");
  }
  if (issues.includes("hallucination") || issues.includes("hallucinated_source")) {
    push("verification_improvement", "human_approval", "Strengthen hallucination guardrails", "補強無來源宣稱與幻覺檢查，避免未驗證內容被當成完成。", "executive-verifier");
  }
  if (issues.includes("knowledge_write_error")) {
    push("knowledge_policy_update", "human_approval", "Tighten knowledge write policy", "補強知識寫入前的 proposal / approval / conflict 規則，避免未驗證內容進長期記憶。", "executive-rules");
  }

  return proposals;
}
