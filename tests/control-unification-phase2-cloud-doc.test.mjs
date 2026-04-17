import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
import { setupExecutiveTaskStateTestHarness } from "./helpers/executive-task-state-harness.mjs";

const testDb = await createTestDbHarness();
const [
  {
    ensureCloudDocWorkflowTask,
    finalizeCloudDocWorkflowTask,
    markCloudDocApplying,
  },
  { clearActiveExecutiveTask, getActiveExecutiveTask },
  {
    buildCloudDocStructuredResult,
    buildCloudDocWorkflowScopeKey,
    matchesCloudDocWorkflowScope,
  },
] = await Promise.all([
  import("../src/executive-orchestrator.mjs"),
  import("../src/executive-task-state.mjs"),
  import("../src/cloud-doc-organization-workflow.mjs"),
]);

setupExecutiveTaskStateTestHarness();
test.after(() => {
  testDb.close();
});

function createCloudDocScope(seed) {
  const scopeKey = `drive:fld-${seed}`;
  return {
    accountId: `acct-${seed}`,
    scopeKey,
    scope: {
      session_key: scopeKey,
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

test("cloud doc preview reaches awaiting_review", { concurrency: false }, async () => {
  const { accountId, scopeKey, scope, event } = createCloudDocScope(`preview-${Date.now()}`);
  await ensureCloudDocWorkflowTask({
    accountId,
    scopeKey,
    scope,
    event,
    workflowState: "scoping",
    routingHint: "cloud_doc_scoping",
    objective: "drive-folder-preview",
  });
  await ensureCloudDocWorkflowTask({
    accountId,
    scopeKey,
    scope,
    event,
    workflowState: "previewing",
    routingHint: "cloud_doc_preview",
    objective: "drive-folder-preview",
  });
  const task = await ensureCloudDocWorkflowTask({
    accountId,
    scopeKey,
    scope,
    event,
    workflowState: "awaiting_review",
    routingHint: "cloud_doc_review_pending",
    objective: "drive-folder-preview",
  });

  assert.equal(task?.workflow, "cloud_doc");
  assert.equal(task?.workflow_state, "awaiting_review");
  assert.equal(task?.meta?.scope_key, scopeKey);
  assert.equal(task?.lifecycle_state, "awaiting_result");
  assert.notEqual(task?.status, "completed");

  await clearActiveExecutiveTask(accountId, scope.session_key);
});

test("cloud doc review required before applying", { concurrency: false }, async () => {
  const { accountId, scopeKey, scope, event } = createCloudDocScope(`gate-${Date.now()}`);
  await ensureCloudDocWorkflowTask({
    accountId,
    scopeKey,
    scope,
    event,
    workflowState: "previewing",
    routingHint: "cloud_doc_preview",
    objective: "drive-folder-preview",
  });
  const applying = await markCloudDocApplying({
    accountId,
    scopeKey,
    scope,
    event,
  });

  assert.equal(applying, null);

  await clearActiveExecutiveTask(accountId, scope.session_key);
});

test("same scope follow-up matches original cloud doc task", { concurrency: false }, async () => {
  const { accountId, scopeKey, scope, event } = createCloudDocScope(`same-${Date.now()}`);
  const task = await ensureCloudDocWorkflowTask({
    accountId,
    scopeKey,
    scope,
    event,
    workflowState: "awaiting_review",
    routingHint: "cloud_doc_review_pending",
    objective: "drive-folder-preview",
  });

  assert.equal(matchesCloudDocWorkflowScope(task, scopeKey), true);

  await clearActiveExecutiveTask(accountId, scope.session_key);
});

test("same session but different scope does not match original cloud doc task", { concurrency: false }, async () => {
  const { accountId, scopeKey, scope, event } = createCloudDocScope(`diff-${Date.now()}`);
  const task = await ensureCloudDocWorkflowTask({
    accountId,
    scopeKey,
    scope,
    event,
    workflowState: "awaiting_review",
    routingHint: "cloud_doc_review_pending",
    objective: "drive-folder-preview",
  });
  const differentScopeKey = buildCloudDocWorkflowScopeKey({ folderToken: "fld-other" });

  assert.equal(matchesCloudDocWorkflowScope(task, differentScopeKey), false);

  await clearActiveExecutiveTask(accountId, scope.session_key);
});

test("cloud doc apply verifies and completes", { concurrency: false }, async () => {
  const { accountId, scopeKey, scope, event } = createCloudDocScope(`apply-${Date.now()}`);
  await ensureCloudDocWorkflowTask({
    accountId,
    scopeKey,
    scope,
    event,
    workflowState: "awaiting_review",
    routingHint: "cloud_doc_review_pending",
    objective: "drive-folder-preview",
  });
  const applying = await markCloudDocApplying({
    accountId,
    scopeKey,
    scope,
    event,
  });
  const finalized = await finalizeCloudDocWorkflowTask({
    accountId,
    scopeKey,
    scope,
    structuredResult: buildCloudDocStructuredResult({
      scopeKey,
      scopeType: "drive_folder",
      preview: {
        target_folders: [{ name: "工程技術" }],
        moves: [{ file_token: "doc-1", target_folder_name: "工程技術" }],
      },
      apply: { moved: 3 },
      mode: "apply",
    }),
    extraEvidence: [
      { type: "file_updated", summary: "drive_scope:fld-1" },
      { type: "API_call_success", summary: "drive_organize_apply_succeeded" },
    ],
  });

  assert.equal(applying?.workflow_state, "applying");
  assert.equal(finalized?.verification?.pass, true);
  assert.equal(finalized?.task?.workflow_state, "completed");
  assert.equal(await getActiveExecutiveTask(accountId, scope.session_key), null);
});

test("cloud doc verifier fail enters retrying recovery path and does not complete", { concurrency: false }, async () => {
  const { accountId, scopeKey, scope, event } = createCloudDocScope(`fail-${Date.now()}`);
  await ensureCloudDocWorkflowTask({
    accountId,
    scopeKey,
    scope,
    event,
    workflowState: "awaiting_review",
    routingHint: "cloud_doc_review_pending",
    objective: "drive-folder-preview",
  });
  await markCloudDocApplying({
    accountId,
    scopeKey,
    scope,
    event,
  });
  const finalized = await finalizeCloudDocWorkflowTask({
    accountId,
    scopeKey,
    scope,
    structuredResult: {
      scope_key: scopeKey,
      preview_plan: null,
    },
    extraEvidence: [],
  });

  assert.equal(finalized?.verification?.pass, false);
  assert.equal(finalized?.task?.lifecycle_state, "executing");
  assert.equal(finalized?.task?.workflow_state, "retrying");
  assert.equal(finalized?.task?.routing_hint, "cloud_doc_resume_same_task");
  assert.equal(finalized?.task?.status, "active");
  assert.notEqual(finalized?.task?.status, "completed");

  await clearActiveExecutiveTask(accountId, scope.session_key);
});
