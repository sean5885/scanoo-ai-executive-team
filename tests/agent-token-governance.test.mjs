import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCheckpointSummary,
  compactToolPayload,
  governPromptSections,
} from "../src/agent-token-governance.mjs";

test("governPromptSections uses summary text when prompt enters rolling stage", () => {
  const governed = governPromptSections({
    systemPrompt: "system",
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
  assert.match(governed.prompt, /精簡摘要/);
  assert.doesNotMatch(governed.prompt, /A{200}/);
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
