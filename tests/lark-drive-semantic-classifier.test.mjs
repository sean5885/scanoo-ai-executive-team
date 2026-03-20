import test from "node:test";
import assert from "node:assert/strict";

import { classifyPendingItemsWithRetries } from "../src/lark-drive-semantic-classifier.mjs";

test("semantic classifier retries malformed and incomplete JSON before succeeding", async () => {
  const prompts = [];
  const items = [
    {
      id: "doc-1",
      title: "產品需求規格",
      type: "docx",
      parent_path: "/Scanoo/產品",
      text: "這份文件描述產品需求、驗收條件與流程。",
    },
    {
      id: "doc-2",
      title: "招募流程",
      type: "docx",
      parent_path: "/Scanoo/行政",
      text: "這份文件描述面試安排、錄用流程與人事行政事項。",
    },
  ];

  const rows = await classifyPendingItemsWithRetries(items, {
    classifier: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return "```json\n{\"results\":[{\"id\":\"doc-1\",\"category\":\"產品需求\"}\n```";
      }
      if (prompts.length === 2) {
        return JSON.stringify({
          results: [{ id: "doc-1", category: "產品需求", confidence: 0.91, reason: "正文描述需求" }],
        });
      }
      return JSON.stringify({
        results: [
          { id: "doc-1", category: "產品需求", confidence: 0.91, reason: "正文描述需求" },
          { id: "doc-2", category: "人事行政", confidence: 0.88, reason: "正文描述招募與行政" },
        ],
      });
    },
  });

  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /<lobster_prompt/);
  assert.match(prompts[1], /<section name="repair_goal"/);
  assert.match(prompts[1], /semantic_classifier_invalid_json|repair_goal/);
  assert.match(prompts[2], /<section name="repair_goal"/);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((item) => item.id),
    ["doc-1", "doc-2"],
  );
});
