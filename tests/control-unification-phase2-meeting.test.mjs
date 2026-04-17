import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
import { setupExecutiveTaskStateTestHarness } from "./helpers/executive-task-state-harness.mjs";

const testDb = await createTestDbHarness();
const [
  {
    finalizeMeetingWorkflowTask,
    ensureMeetingWorkflowTask,
    markMeetingWorkflowWritingBack,
  },
  { getActiveExecutiveTask, clearActiveExecutiveTask },
  { buildMeetingStructuredResult },
] = await Promise.all([
  import("../src/executive-orchestrator.mjs"),
  import("../src/executive-task-state.mjs"),
  import("../src/meeting-agent.mjs"),
]);

setupExecutiveTaskStateTestHarness();
test.after(() => {
  testDb.close();
});

function createMeetingScope(seed) {
  return {
    accountId: `acct-${seed}`,
    scope: {
      session_key: `session-${seed}`,
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

function buildValidMeetingStructuredResult() {
  return buildMeetingStructuredResult({
    summary: {
      time: "20260318",
      participants: ["Sean", "Amy"],
      main_points: ["同步交付節奏"],
      conclusions: ["確認先走 beta"],
      todos: [
        {
          owner: "Sean",
          title: "整理 PRD",
          deadline: "20260320",
        },
      ],
    },
    classification: { meeting_type: "general" },
    transcriptText: "結論：確認先走 beta\nTODO：Sean 整理 PRD",
    projectName: "Alpha",
  });
}

test("meeting workflow start enters capturing state", async () => {
  const { accountId, scope, event } = createMeetingScope(`start-${Date.now()}`);
  const task = await ensureMeetingWorkflowTask({
    accountId,
    scope,
    event,
    workflowState: "capturing",
    routingHint: "meeting_capture",
    objective: "Alpha weekly sync",
  });

  assert.equal(task?.workflow, "meeting");
  assert.equal(task?.workflow_state, "capturing");
  assert.equal(task?.trace_id, scope.trace_id);
  assert.equal(task?.lifecycle_state, "executing");

  await clearActiveExecutiveTask(accountId, scope.session_key);
});

test("meeting summary waits for confirmation and does not complete before confirm", async () => {
  const { accountId, scope, event } = createMeetingScope(`await-${Date.now()}`);
  await ensureMeetingWorkflowTask({
    accountId,
    scope,
    event,
    workflowState: "capturing",
    routingHint: "meeting_capture",
    objective: "Alpha weekly sync",
  });
  const task = await ensureMeetingWorkflowTask({
    accountId,
    scope,
    event,
    workflowState: "awaiting_confirmation",
    routingHint: "meeting_confirmation_pending",
    objective: "Alpha weekly sync",
  });

  assert.equal(task?.workflow_state, "awaiting_confirmation");
  assert.equal(task?.lifecycle_state, "awaiting_result");
  assert.equal(task?.status, "active");
  assert.notEqual(task?.lifecycle_state, "completed");
  assert.notEqual(task?.status, "completed");

  await clearActiveExecutiveTask(accountId, scope.session_key);
});

test("meeting confirm path writes back then verifies and completes", async () => {
  const { accountId, scope, event } = createMeetingScope(`complete-${Date.now()}`);
  await ensureMeetingWorkflowTask({
    accountId,
    scope,
    event,
    workflowState: "capturing",
    routingHint: "meeting_capture",
    objective: "Alpha weekly sync",
  });
  await ensureMeetingWorkflowTask({
    accountId,
    scope,
    event,
    workflowState: "awaiting_confirmation",
    routingHint: "meeting_confirmation_pending",
    objective: "Alpha weekly sync",
  });
  const writingBack = await markMeetingWorkflowWritingBack({
    accountId,
    scope,
    event,
    meta: { confirmation_id: "confirm-1" },
  });
  const finalized = await finalizeMeetingWorkflowTask({
    accountId,
    scope,
    summaryContent: "【會議紀要】確認先走 beta",
    structuredResult: buildValidMeetingStructuredResult(),
    extraEvidence: [
      { type: "file_updated", summary: "document:doc-1" },
      { type: "DB_write_confirmed", summary: "meeting_document_mapping_saved" },
      { type: "knowledge_proposal_created", summary: "knowledge_proposals:1" },
    ],
  });

  assert.equal(writingBack?.workflow_state, "writing_back");
  assert.equal(finalized?.task?.workflow_state, "completed");
  assert.equal(finalized?.task?.lifecycle_state, "completed");
  assert.equal(finalized?.verification?.pass, true);
  assert.equal(await getActiveExecutiveTask(accountId, scope.session_key), null);
});

test("meeting verifier failure enters retrying recovery path and never completes", async () => {
  const { accountId, scope, event } = createMeetingScope(`fail-${Date.now()}`);
  await ensureMeetingWorkflowTask({
    accountId,
    scope,
    event,
    workflowState: "capturing",
    routingHint: "meeting_capture",
    objective: "Alpha weekly sync",
  });
  await ensureMeetingWorkflowTask({
    accountId,
    scope,
    event,
    workflowState: "awaiting_confirmation",
    routingHint: "meeting_confirmation_pending",
    objective: "Alpha weekly sync",
  });
  await markMeetingWorkflowWritingBack({
    accountId,
    scope,
    event,
    meta: { confirmation_id: "confirm-2" },
  });
  const finalized = await finalizeMeetingWorkflowTask({
    accountId,
    scope,
    summaryContent: "【會議紀要】內容不完整",
    structuredResult: {
      summary: "【會議紀要】內容不完整",
      decisions: [],
      action_items: [],
    },
    extraEvidence: [
      { type: "file_updated", summary: "document:doc-2" },
    ],
  });

  assert.equal(finalized?.verification?.pass, false);
  assert.notEqual(finalized?.task?.lifecycle_state, "completed");
  assert.notEqual(finalized?.task?.status, "completed");
  assert.equal(finalized?.task?.lifecycle_state, "executing");
  assert.equal(finalized?.task?.workflow_state, "retrying");
  assert.equal(finalized?.task?.routing_hint, "meeting_resume_same_task");
  assert.equal(finalized?.task?.status, "active");

  await clearActiveExecutiveTask(accountId, scope.session_key);
});
