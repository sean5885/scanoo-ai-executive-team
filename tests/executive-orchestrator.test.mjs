import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExecutiveBrief,
  buildSupportingContext,
  buildVisibleSupportingOutputs,
  buildVisibleWorkPlan,
  normalizeWorkPlan,
} from "../src/executive-orchestrator.mjs";

test("normalizeWorkPlan prefers decision work items and deduplicates agents", () => {
  const plan = normalizeWorkPlan(
    null,
    {
      work_items: [
        { agent_id: "consult", task: "拆解問題" },
        { agent_id: "consult", task: "重複項目" },
        { agent_id: "product", task: "整理產品角度" },
      ],
    },
    "原始任務",
  );

  assert.equal(plan.length, 2);
  assert.equal(plan[0].agent_id, "consult");
  assert.equal(plan[1].agent_id, "product");
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
    primaryReplyText: "結論\n先把模糊文檔拆成待確認與待改派兩類。",
  });

  assert.match(text, /^結論/);
  assert.match(text, /這輪分工/);
  assert.match(text, /我另外參考了/);
  assert.match(text, /待確認與待改派/);
});
