import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExecutiveBrief,
  buildSupportingContext,
  buildVisibleSupportingOutputs,
  buildVisibleWorkPlan,
  executeWorkItemsSequentially,
  normalizeWorkPlan,
} from "../src/executive-orchestrator.mjs";

test("normalizeWorkPlan keeps at most three roles and reserves the merge agent slot", () => {
  const plan = normalizeWorkPlan(
    null,
    {
      primary_agent_id: "generalist",
      work_items: [
        { agent_id: "consult", task: "拆解問題" },
        { agent_id: "consult", task: "重複項目" },
        { agent_id: "product", task: "整理產品角度" },
        { agent_id: "tech", task: "整理技術風險" },
      ],
    },
    "原始任務",
  );

  assert.equal(plan.length, 3);
  assert.equal(plan[0].agent_id, "consult");
  assert.equal(plan[1].agent_id, "product");
  assert.equal(plan[2].agent_id, "generalist");
});

test("buildSupportingContext formats agent outputs for synthesis", () => {
  const text = buildSupportingContext([
    { agent_id: "consult", task: "拆解問題", summary: "問題邊界已整理" },
    { agent_id: "product", task: "整理產品角度", summary: "產品價值已整理" },
  ]);

  assert.match(text, /\/consult/);
  assert.match(text, /問題邊界已整理/);
  assert.match(text, /\/product/);
});

test("buildVisibleWorkPlan formats readable task list", () => {
  const text = buildVisibleWorkPlan(
    [
      { agent_id: "generalist", task: "主責收斂", role: "primary", status: "pending" },
      { agent_id: "consult", task: "做方案比較", role: "supporting", status: "completed" },
    ],
    { primaryAgentId: "generalist" },
  );

  assert.match(text, /這輪分工/);
  assert.match(text, /主責 \/generalist｜待處理/);
  assert.match(text, /支援 \/consult｜已完成/);
});

test("buildVisibleSupportingOutputs formats readable agent summaries", () => {
  const text = buildVisibleSupportingOutputs([
    { agent_id: "consult", task: "做方案比較", summary: "已整理方案差異與風險" },
  ]);

  assert.match(text, /我另外參考了/);
  assert.match(text, /\/consult/);
  assert.match(text, /已整理方案差異與風險/);
});

test("buildExecutiveBrief combines header, task list, support summaries, and synthesis", () => {
  const text = buildExecutiveBrief({
    header: "我先把這題交給 /generalist 主責收斂，並同步參考 /consult 的補充。",
    workPlan: [
      { agent_id: "generalist", task: "主責收斂", role: "primary", status: "pending" },
      { agent_id: "consult", task: "做方案比較", role: "supporting", status: "completed" },
    ],
    primaryAgentId: "generalist",
    supportingOutputs: [
      { agent_id: "consult", task: "做方案比較", summary: "已整理方案差異與風險" },
    ],
    primaryReplyText: [
      "結論：先把模糊文檔拆成待確認與待改派兩類。",
      "",
      "重點：",
      "- 待確認項目先補 owner",
      "- 待確認項目先補 owner",
      "",
      "下一步：先補 owner，再決定要不要改派。",
      "",
      "來源",
      "- 文件 A｜https://example.com/a",
      "- 文件 B｜https://example.com/b",
    ].join("\n"),
  });

  assert.match(text, /^結論：/);
  assert.match(text, /待確認與待改派/);
  assert.match(text, /重點：/);
  assert.match(text, /參考來源：文件 A、文件 B/);
  assert.equal((text.match(/待確認項目先補 owner/g) || []).length, 1);
  assert.match(text, /下一步：/);
  assert.doesNotMatch(text, /這輪分工/);
  assert.doesNotMatch(text, /我另外參考了/);
  assert.doesNotMatch(text, /\/consult/);
});

test("executeWorkItemsSequentially runs specialists in order and merges into one final response", async () => {
  const calls = [];
  const result = await executeWorkItemsSequentially({
    accountId: "acct-1",
    requestText: "請整理結論",
    workPlan: [
      { agent_id: "consult", task: "拆解問題", role: "supporting" },
      { agent_id: "product", task: "整理產品角度", role: "supporting" },
      { agent_id: "generalist", task: "統一收斂", role: "primary" },
    ],
    async executeAgentFn({ agent, requestText, supportingContext = "" }) {
      calls.push({ agentId: agent.id, requestText, supportingContext });
      return { text: `${agent.id}:${requestText}` };
    },
  });

  assert.deepEqual(calls.map((item) => item.agentId), ["consult", "product", "generalist"]);
  assert.equal(calls[2].requestText, "請整理結論");
  assert.equal(calls[2].supportingContext.includes("/consult"), true);
  assert.equal(calls[2].supportingContext.includes("/product"), true);
  assert.equal(result.reply?.text, "generalist:請整理結論");
  assert.equal(result.supportingOutputs.length, 2);
  assert.equal(result.finalWorkPlan[0].status, "completed");
  assert.equal(result.finalWorkPlan[2].agent_id, "generalist");
});

test("executeWorkItemsSequentially preserves generalist fallback when a specialist fails", async () => {
  const calls = [];
  const result = await executeWorkItemsSequentially({
    accountId: "acct-1",
    requestText: "請收斂結果",
    mergeAgentId: "ceo",
    workPlan: [
      { agent_id: "consult", task: "拆解問題", role: "supporting" },
      { agent_id: "ceo", task: "統一收斂", role: "primary" },
    ],
    async executeAgentFn({ agent, requestText }) {
      calls.push(agent.id);
      if (agent.id === "consult") {
        throw new Error("specialist_failed");
      }
      return { text: `${agent.id}:${requestText}` };
    },
  });

  assert.deepEqual(calls, ["consult", "generalist"]);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.reply?.text, "generalist:統一收斂");
  assert.equal(result.finalWorkPlan[0].status, "failed");
  assert.equal(result.finalWorkPlan[1].agent_id, "generalist");
});
