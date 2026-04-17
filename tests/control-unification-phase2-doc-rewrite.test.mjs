import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
import { setupExecutiveTaskStateTestHarness } from "./helpers/executive-task-state-harness.mjs";

const testDb = await createTestDbHarness();
const [
  {
    ensureDocRewriteWorkflowTask,
    finalizeDocRewriteWorkflowTask,
    markDocRewriteApplying,
  },
  { clearActiveExecutiveTask, getActiveExecutiveTask },
  { buildDocRewriteStructuredResult },
  {
    loadDocumentCommentRewriteApplyState,
    prepareDocumentCommentRewritePreview,
  },
] = await Promise.all([
  import("../src/executive-orchestrator.mjs"),
  import("../src/executive-task-state.mjs"),
  import("../src/doc-comment-rewrite.mjs"),
  import("../src/comment-doc-workflow.mjs"),
]);

setupExecutiveTaskStateTestHarness();
test.after(() => {
  testDb.close();
});

function createRewriteScope(seed) {
  return {
    accountId: `acct-${seed}`,
    documentId: `doc-${seed}`,
    scope: {
      session_key: `doc-rewrite:doc-${seed}`,
      trace_id: `trace-${seed}`,
    },
    event: {
      trace_id: `trace-${seed}`,
      message: {
        chat_id: `chat-${seed}`,
        message_id: `msg-${seed}`,
      },
    },
  };
}

function buildValidStructuredResult(documentId = "doc-1") {
  return buildDocRewriteStructuredResult({
    documentId,
    title: "產品規格",
    originalContent: "# 背景\n\n舊內容\n\n# 範圍\n\n舊範圍",
    rewrittenContent: "# 背景\n\n新內容\n\n# 範圍\n\n舊範圍",
    patchPlan: [
      {
        patch_type: "replace",
        start_index: 0,
        end_index: 1,
        before: ["# 背景\n\n舊內容"],
        after: ["# 背景\n\n新內容"],
      },
    ],
    changeSummary: ["補上背景段落的新限制"],
    applied: true,
    updateResult: { revision_id: "rev-2" },
  });
}

test("doc rewrite preview reaches awaiting_review", async () => {
  const { accountId, documentId, scope, event } = createRewriteScope(`preview-${Date.now()}`);
  await ensureDocRewriteWorkflowTask({
    accountId,
    documentId,
    documentTitle: "產品規格",
    scope,
    event,
    workflowState: "loading_source",
    routingHint: "doc_rewrite_loading_source",
  });
  await ensureDocRewriteWorkflowTask({
    accountId,
    documentId,
    documentTitle: "產品規格",
    scope,
    event,
    workflowState: "drafting",
    routingHint: "doc_rewrite_drafting",
  });
  const task = await ensureDocRewriteWorkflowTask({
    accountId,
    documentId,
    documentTitle: "產品規格",
    scope,
    event,
    workflowState: "awaiting_review",
    routingHint: "doc_rewrite_review_pending",
  });

  assert.equal(task?.workflow, "doc_rewrite");
  assert.equal(task?.workflow_state, "awaiting_review");
  assert.equal(task?.lifecycle_state, "awaiting_result");
  assert.equal(task?.trace_id, scope.trace_id);

  await clearActiveExecutiveTask(accountId, scope.session_key);
});

test("shared doc rewrite preview helper keeps comment ingress on the same awaiting_review task", async () => {
  const { accountId, documentId, scope, event } = createRewriteScope(`helper-${Date.now()}`);
  const preview = await prepareDocumentCommentRewritePreview({
    accountId,
    accessToken: "token-1",
    documentId,
    scope,
    event,
    commentIds: ["comment-1"],
    route: "document_comment_suggestion_card",
    readDocumentFn: async () => ({
      document_id: documentId,
      title: "產品規格",
      content: "# 背景\n\n舊內容",
      revision_id: "rev-1",
    }),
    rewriteDocumentFn: async () => ({
      ok: true,
      document_id: documentId,
      title: "產品規格",
      comment_count: 1,
      comment_ids: ["comment-1"],
      comments: [{ comment_id: "comment-1", latest_reply_text: "請更新" }],
      change_summary: ["補上新限制"],
      patch_plan: [{ patch_type: "replace", start_index: 0, end_index: 1, before: ["舊內容"], after: ["新內容"] }],
      revised_content: "# 背景\n\n新內容",
    }),
    createConfirmationFn: async () => ({
      confirmation_id: "confirm-helper-1",
      confirmation_type: "comment_rewrite",
      expires_at: "2099-01-01T00:00:00.000Z",
      preview: { document_id: documentId },
      preview_card: { title: "改稿建議", content: "preview" },
    }),
  });

  const task = await getActiveExecutiveTask(accountId, scope.session_key);
  assert.equal(preview.confirmation?.confirmation_id, "confirm-helper-1");
  assert.equal(task?.workflow, "doc_rewrite");
  assert.equal(task?.workflow_state, "awaiting_review");
  assert.equal(task?.meta?.confirmation_id, "confirm-helper-1");
  assert.equal(task?.meta?.route, "document_comment_suggestion_card");

  await clearActiveExecutiveTask(accountId, scope.session_key);
});

test("doc rewrite before review does not apply or complete", async () => {
  const { accountId, documentId, scope, event } = createRewriteScope(`review-${Date.now()}`);
  await ensureDocRewriteWorkflowTask({
    accountId,
    documentId,
    documentTitle: "產品規格",
    scope,
    event,
    workflowState: "awaiting_review",
    routingHint: "doc_rewrite_review_pending",
  });
  const task = await getActiveExecutiveTask(accountId, scope.session_key);

  assert.equal(task?.workflow_state, "awaiting_review");
  assert.notEqual(task?.workflow_state, "applying");
  assert.notEqual(task?.lifecycle_state, "completed");
  assert.notEqual(task?.status, "completed");

  await clearActiveExecutiveTask(accountId, scope.session_key);
});

test("doc rewrite review then apply verifies and completes", async () => {
  const { accountId, documentId, scope, event } = createRewriteScope(`apply-${Date.now()}`);
  await ensureDocRewriteWorkflowTask({
    accountId,
    documentId,
    documentTitle: "產品規格",
    scope,
    event,
    workflowState: "awaiting_review",
    routingHint: "doc_rewrite_review_pending",
  });
  const applying = await markDocRewriteApplying({
    accountId,
    scope,
    event,
    meta: {
      confirmation_id: "confirm-1",
    },
  });
  const finalized = await finalizeDocRewriteWorkflowTask({
    accountId,
    scope,
    structuredResult: buildValidStructuredResult(documentId),
    extraEvidence: [
      { type: "file_updated", summary: `document:${documentId}` },
      { type: "API_call_success", summary: "document_rewrite_apply_succeeded" },
    ],
  });

  assert.equal(applying?.workflow_state, "applying");
  assert.equal(finalized?.verification?.pass, true);
  assert.equal(finalized?.task?.workflow_state, "completed");
  assert.equal(finalized?.task?.lifecycle_state, "completed");
  assert.equal(await getActiveExecutiveTask(accountId, scope.session_key), null);
});

test("doc rewrite apply readiness is fail-closed when confirmation drifts from awaiting_review task", async () => {
  const { accountId, documentId, scope, event } = createRewriteScope(`gate-${Date.now()}`);
  await ensureDocRewriteWorkflowTask({
    accountId,
    documentId,
    documentTitle: "產品規格",
    scope,
    event,
    workflowState: "awaiting_review",
    routingHint: "doc_rewrite_review_pending",
    meta: {
      confirmation_id: "confirm-current",
    },
  });

  const applyState = await loadDocumentCommentRewriteApplyState({
    accountId,
    documentId,
    confirmationId: "confirm-stale",
    scope,
    peekConfirmationFn: async () => ({
      confirmation_id: "confirm-stale",
      document_id: documentId,
    }),
  });

  assert.equal(applyState.reviewReady, false);
  assert.equal(applyState.activeTask?.workflow_state, "awaiting_review");

  const applying = await markDocRewriteApplying({
    accountId,
    scope,
    event,
    confirmationId: "confirm-stale",
    meta: {
      confirmation_id: "confirm-stale",
    },
  });

  assert.equal(applying, null);

  await clearActiveExecutiveTask(accountId, scope.session_key);
});

test("doc rewrite verifier fail enters retrying recovery path and does not complete", async () => {
  const { accountId, documentId, scope, event } = createRewriteScope(`fail-${Date.now()}`);
  await ensureDocRewriteWorkflowTask({
    accountId,
    documentId,
    documentTitle: "產品規格",
    scope,
    event,
    workflowState: "awaiting_review",
    routingHint: "doc_rewrite_review_pending",
  });
  await markDocRewriteApplying({
    accountId,
    scope,
    event,
    meta: {
      confirmation_id: "confirm-2",
    },
  });
  const finalized = await finalizeDocRewriteWorkflowTask({
    accountId,
    scope,
    structuredResult: {
      patch_plan: [],
      structure_preserved: false,
    },
    extraEvidence: [
      { type: "file_updated", summary: `document:${documentId}` },
    ],
  });

  assert.equal(finalized?.verification?.pass, false);
  assert.notEqual(finalized?.task?.status, "completed");
  assert.notEqual(finalized?.task?.lifecycle_state, "completed");
  assert.equal(finalized?.task?.lifecycle_state, "executing");
  assert.equal(finalized?.task?.workflow_state, "retrying");
  assert.equal(finalized?.task?.routing_hint, "doc_rewrite_resume_same_task");
  assert.equal(finalized?.task?.status, "active");

  await clearActiveExecutiveTask(accountId, scope.session_key);
});
