import test from "node:test";
import assert from "node:assert/strict";

import {
  appendApprovedMemory,
  appendSessionMemory,
  createPendingKnowledgeProposal,
  listApprovedMemory,
  listPendingKnowledgeProposals,
  listSessionMemory,
  retrieveExecutiveDecisionMemory,
} from "../src/executive-memory.mjs";

test("executive memory stores working memory and proposals", async () => {
  const accountId = `acct-${Date.now()}`;
  const sessionKey = `session-${Date.now()}`;

  await appendSessionMemory({
    account_id: accountId,
    session_key: sessionKey,
    task_id: "task-1",
    type: "working_memory",
    title: "分類任務",
    content: "先做第一輪角色分類",
    evidence: [],
    tags: ["classification"],
  });
  await appendApprovedMemory({
    account_id: accountId,
    session_key: sessionKey,
    task_id: "task-1",
    type: "approved_memory",
    title: "確認的規則",
    content: "公司 OKR 週會屬於管理層/PMO",
    evidence: [],
    tags: ["knowledge"],
  });
  await createPendingKnowledgeProposal({
    account_id: accountId,
    session_key: sessionKey,
    task_id: "task-1",
    type: "knowledge_proposal",
    title: "待審批會議結論",
    content: "下週提交新版排程",
    evidence: [],
    tags: ["meeting"],
  });

  const memories = await listSessionMemory({ accountId, sessionKey });
  const proposals = await listPendingKnowledgeProposals({ accountId });

  assert.ok(memories.length >= 1);
  const approved = await listApprovedMemory({ accountId });
  assert.ok(approved.some((item) => item.title === "確認的規則"));
  assert.ok(proposals.some((item) => item.title === "待審批會議結論"));
});

test("executive decision memory retrieval combines session + approved context without overclaim", async () => {
  const accountId = `acct-retrieval-${Date.now()}`;
  const sessionKey = `session-retrieval-${Date.now()}`;
  await appendSessionMemory({
    account_id: accountId,
    session_key: sessionKey,
    task_id: "task-retrieval-1",
    type: "working_memory",
    title: "上次討論的 onboarding SOP",
    content: "入口要先確認 owner 與 deadline。",
    tags: ["onboarding", "sop"],
  });
  await appendApprovedMemory({
    account_id: accountId,
    session_key: sessionKey,
    task_id: "task-retrieval-1",
    type: "approved_memory",
    title: "批准規則：onboarding checklist",
    content: "缺 owner 的 action item 不可視為完成。",
    tags: ["checklist", "owner"],
  });

  const result = await retrieveExecutiveDecisionMemory({
    accountId,
    sessionKey,
    text: "延續上一題，onboarding checklist 要怎麼確認？",
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.decision_context?.needs_context, true);
  assert.equal(Array.isArray(result?.decision_context?.session_memory), true);
  assert.equal(Array.isArray(result?.decision_context?.approved_memory), true);
  assert.equal(result?.decision_context?.session_memory?.length > 0, true);
  assert.equal(result?.decision_context?.approved_memory?.length > 0, true);
  assert.equal(result?.observability?.memory_retrieval_attempted, true);
  assert.equal(result?.observability?.memory_retrieval_hit, true);
  assert.equal(result?.observability?.memory_retrieval_session_hit_count > 0, true);
  assert.equal(result?.observability?.memory_retrieval_approved_hit_count > 0, true);
});
