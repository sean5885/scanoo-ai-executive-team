import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
import { setupExecutiveTaskStateTestHarness } from "./helpers/executive-task-state-harness.mjs";

const testDb = await createTestDbHarness();
const {
  generateDocumentCommentSuggestionCard,
} = await import("../src/comment-suggestion-workflow.mjs");

setupExecutiveTaskStateTestHarness();
test.after(() => {
  testDb.close();
});

test("comment suggestion notification failure does not mark comments seen", async () => {
  let seenCalled = false;

  await assert.rejects(
    generateDocumentCommentSuggestionCard({
      accessToken: "token-1",
      accountId: "acct-1",
      documentId: "doc-1",
      messageId: "msg-1",
      listCommentsFn: async () => ([
        {
          comment_id: "comment-1",
          latest_reply_text: "請更新文件",
        },
      ]),
      listUnseenDocumentCommentsFn: async ({ comments }) => comments,
      preparePreviewFn: async () => ({
        confirmation: {
          confirmation_id: "confirm-1",
          confirmation_type: "comment_rewrite",
          expires_at: "2099-01-01T00:00:00.000Z",
          preview: { document_id: "doc-1" },
          preview_card: {
            title: "改稿建議",
            content: "preview-content",
          },
        },
      }),
      executeMessageReplyFn: async () => ({
        ok: false,
        error: "reply_failed",
        data: {
          message: "reply_failed",
        },
      }),
      markDocumentCommentsSeenFn: async () => {
        seenCalled = true;
        return {
          seen_count: 1,
        };
      },
    }),
    /reply_failed/,
  );

  assert.equal(seenCalled, false);
});

test("comment suggestion marks comments seen only after notification succeeds", async () => {
  const calls = [];

  const result = await generateDocumentCommentSuggestionCard({
    accessToken: "token-1",
    accountId: "acct-1",
    documentId: "doc-2",
    messageId: "msg-2",
    listCommentsFn: async () => ([
      {
        comment_id: "comment-2",
        latest_reply_text: "請補上 closing",
      },
    ]),
    listUnseenDocumentCommentsFn: async ({ comments }) => comments,
    preparePreviewFn: async () => ({
      confirmation: {
        confirmation_id: "confirm-2",
        confirmation_type: "comment_rewrite",
        expires_at: "2099-01-01T00:00:00.000Z",
        preview: { document_id: "doc-2" },
        preview_card: {
          title: "改稿建議",
          content: "preview-content-2",
        },
      },
    }),
    executeMessageReplyFn: async () => {
      calls.push("notify");
      return {
        ok: true,
        result: {
          message_id: "msg-2",
        },
      };
    },
    markDocumentCommentsSeenFn: async () => {
      calls.push("mark_seen");
      return {
        seen_count: 1,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["notify", "mark_seen"]);
  assert.equal(result.seen_result?.seen_count, 1);
  assert.equal(result.notification?.message_id, "msg-2");
});
