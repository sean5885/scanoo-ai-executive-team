import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCompactSystemPrompt,
  buildCheckpointSummary,
  compactToolPayload,
  governPromptSections,
} from "../src/agent-token-governance.mjs";

test("governPromptSections uses summary text when prompt enters rolling stage", () => {
  const governed = governPromptSections({
    systemPrompt: "system",
    format: "xml",
    maxTokens: 120,
    sections: [
      {
        name: "goal",
        label: "task_goal",
        text: "短任務目標",
        required: true,
        maxTokens: 20,
      },
      {
        name: "retrieved",
        label: "retrieved_context",
        text: "A".repeat(1200),
        summaryText: "精簡摘要",
        required: true,
        maxTokens: 60,
      },
      {
        name: "user",
        label: "user_request",
        text: "請回答問題",
        required: true,
        maxTokens: 20,
      },
    ],
  });

  assert.ok(["rolling", "emergency"].includes(governed.stage));
  assert.match(governed.prompt, /<lobster_prompt/);
  assert.match(governed.prompt, /<thought_visibility>internal_only<\/thought_visibility>/);
  assert.match(governed.prompt, /精簡摘要/);
  assert.doesNotMatch(governed.prompt, /A{200}/);
  assert.match(governed.prompt, /Do not claim that ls or find was run unless their output is explicitly present/);
});

test("buildCheckpointSummary keeps structured fields and omits overflow", () => {
  const text = buildCheckpointSummary({
    goal: "完成長任務",
    completed: ["已完成第一步", "已完成第二步"],
    pending: ["還有第三步"],
    constraints: ["不能丟失關鍵事實"],
    facts: ["文件 id = doccn123"],
    risks: ["外部 API 不穩定"],
  });

  assert.match(text, /目標/);
  assert.match(text, /已完成/);
  assert.match(text, /外部 API 不穩定/);
});

test("compactToolPayload trims large arrays and long strings", () => {
  const compacted = compactToolPayload({
    answer: "X".repeat(800),
    items: Array.from({ length: 20 }, (_, index) => ({ index, text: `item-${index}` })),
  });

  assert.equal(Array.isArray(compacted.items), true);
  assert.ok(compacted.items.length <= 9);
  assert.equal(typeof compacted.items.at(-1), "object");
  assert.ok(compacted.answer.length < 800);
});

test("buildCompactSystemPrompt deduplicates shared rules into a short prompt", () => {
  const prompt = buildCompactSystemPrompt("你是摘要助手。", [
    "只依據提供內容與已觀察到的工具輸出。",
    "證據不足時明確標示待確認，不要猜測。",
    "輸出精簡、結構化、避免重複。",
    "保留關鍵決策。",
  ]);

  assert.match(prompt, /你是摘要助手/);
  assert.match(prompt, /保留關鍵決策/);
  assert.equal(prompt.match(/輸出精簡、結構化、避免重複/g)?.length, 1);
});
