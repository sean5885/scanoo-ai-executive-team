import test from "node:test";
import assert from "node:assert/strict";

import {
  appendApprovedMemory,
  appendSessionMemory,
  createPendingKnowledgeProposal,
  listPendingKnowledgeProposals,
  listSessionMemory,
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
  assert.ok(proposals.some((item) => item.title === "待審批會議結論"));
});
