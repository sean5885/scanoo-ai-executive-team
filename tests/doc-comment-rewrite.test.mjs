import test from "node:test";
import assert from "node:assert/strict";

import { buildRewritePromptInput } from "../src/doc-comment-rewrite.mjs";

test("buildRewritePromptInput favors focused excerpts over full raw document", () => {
  const document = {
    document_id: "doccn123",
    title: "產品規格",
    content: [
      "# 背景",
      "這是背景段落。",
      "",
      "# 流程",
      "這裡描述目前流程與限制。",
      "",
      "這裡描述新的流程圖與評審要求。",
      "",
      "# 其他",
      "這是其他段落。".repeat(120),
    ].join("\n"),
  };
  const comments = [
    {
      comment_id: "c1",
      quote: "新的流程圖與評審要求",
      latest_reply_text: "請補上 AI 系統這段的能力與限制",
      replies: [],
    },
  ];

  const result = buildRewritePromptInput(document, comments, {
    goal: "持續修訂產品規格",
    completed: ["已處理第一輪評論"],
    pending: ["本輪補上 AI 系統能力與限制"],
    constraints: ["不要加入不存在的事實"],
    facts: ["文件標題：產品規格"],
    risks: ["replace 寫回仍有 API 限制"],
  });

  assert.match(result.prompt, /<lobster_prompt/);
  assert.match(result.prompt, /<section name="focused_document_excerpts"/);
  assert.match(result.prompt, /新的流程圖與評審要求/);
  assert.match(result.prompt, /<section name="task_checkpoint"/);
  assert.match(result.prompt, /Do not claim that ls or find was run unless their output is explicitly present/);
  assert.ok(result.prompt.length < 7000);
  assert.ok(result.governance.finalTokens > 0);
});
