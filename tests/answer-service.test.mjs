import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { buildKnowledgeAnswerPrompt } = await import("../src/answer-service.mjs");

test.after(() => {
  testDb.close();
});

test("buildKnowledgeAnswerPrompt uses checkpoint and trimmed retrieval snippets", () => {
  const items = [
    {
      title: "產品藍圖",
      url: "https://example.com/doc-1",
      content: "這是一大段產品藍圖內容。".repeat(120),
    },
    {
      title: "營運流程",
      url: "https://example.com/doc-2",
      content: "這是一大段營運流程內容。".repeat(120),
    },
  ];

  const result = buildKnowledgeAnswerPrompt({
    question: "請整理 AI 系統的回答速度優化方式",
    items,
    checkpoint: {
      goal: "持續回答同一個知識主題",
      completed: ["前一輪已整理架構背景"],
      pending: ["這輪要回答速度優化"],
      constraints: ["只能依據來源內容回答"],
      facts: ["已知重點是上下文大小影響延遲"],
      risks: ["不要重複解釋專案背景"],
    },
  });

  assert.match(result.prompt, /<lobster_prompt/);
  assert.match(result.prompt, /<section name="task_checkpoint"/);
  assert.match(result.prompt, /前一輪已整理架構背景/);
  assert.match(result.prompt, /<section name="retrieved_context"/);
  assert.match(result.prompt, /verify the draft satisfies the latest user intent/i);
  assert.ok(result.governance.finalTokens > 0);
  assert.ok(result.prompt.length < 4000);
});
