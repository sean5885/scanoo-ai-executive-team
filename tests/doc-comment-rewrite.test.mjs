import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const {
  applyRewrittenDocument,
  buildRewritePromptInput,
  rollbackRewrittenDocument,
} = await import("../src/doc-comment-rewrite.mjs");

test.after(() => {
  testDb.close();
});

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

test("doc rewrite cleanup restores document content and comment state after nested write failure", async () => {
  const documentState = {
    content: "# 背景\n\n舊內容",
    resolved: new Map(),
  };
  const rollbackState = {};
  const mutationAudit = {
    boundary: "document_comment_rewrite_apply",
    nested_mutations: [],
  };

  await assert.rejects(
    applyRewrittenDocument(
      "token",
      "doc-1",
      "# 背景\n\n新內容",
      {
        resolveCommentIds: ["comment-1", "comment-2"],
        rollbackState,
        mutationAudit,
        readDocument: async () => ({
          document_id: "doc-1",
          title: "產品規格",
          content: documentState.content,
        }),
        updateDocumentFn: async (_accessToken, documentId, content) => {
          documentState.content = content;
          return { document_id: documentId, mode: "replace" };
        },
        resolveCommentFn: async (_accessToken, _documentId, commentId, isSolved) => {
          if (commentId === "comment-2" && isSolved === true) {
            throw new Error("comment_resolve_failed");
          }
          documentState.resolved.set(commentId, isSolved);
          return { comment_id: commentId, is_solved: isSolved };
        },
      },
    ),
    /comment_resolve_failed/,
  );

  const cleanup = await rollbackRewrittenDocument("token", "doc-1", {
    rollbackState,
    mutationAudit,
    updateDocumentFn: async (_accessToken, documentId, content) => {
      documentState.content = content;
      return { document_id: documentId, mode: "replace" };
    },
    resolveCommentFn: async (_accessToken, _documentId, commentId, isSolved) => {
      documentState.resolved.set(commentId, isSolved);
      return { comment_id: commentId, is_solved: isSolved };
    },
  });

  assert.equal(documentState.content, "# 背景\n\n舊內容");
  assert.equal(documentState.resolved.get("comment-1"), false);
  assert.equal(cleanup.document_restored, true);
  assert.deepEqual(cleanup.unresolved_comment_ids, ["comment-1"]);
  assert.deepEqual(
    mutationAudit.nested_mutations.map((item) => [item.phase, item.action, item.target_id || null]),
    [
      ["execute", "update_document", "doc-1"],
      ["execute", "resolve_comment", "comment-1"],
      ["rollback", "restore_document", "doc-1"],
      ["rollback", "reopen_comment", "comment-1"],
    ],
  );
});
