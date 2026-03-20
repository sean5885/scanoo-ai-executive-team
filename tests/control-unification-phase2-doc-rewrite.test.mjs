import test from "node:test";
import assert from "node:assert/strict";

import {
  ensureDocRewriteWorkflowTask,
  finalizeDocRewriteWorkflowTask,
  markDocRewriteApplying,
} from "../src/executive-orchestrator.mjs";
import { clearActiveExecutiveTask, getActiveExecutiveTask } from "../src/executive-task-state.mjs";
import { buildDocRewriteStructuredResult } from "../src/doc-comment-rewrite.mjs";
import { setupExecutiveTaskStateTestHarness } from "./helpers/executive-task-state-harness.mjs";

setupExecutiveTaskStateTestHarness();

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

test("doc rewrite verifier fail does not complete", async () => {
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
  assert.equal(finalized?.task?.workflow_state, "blocked");
  assert.equal(finalized?.task?.status, "blocked");

  await clearActiveExecutiveTask(accountId, scope.session_key);
});
