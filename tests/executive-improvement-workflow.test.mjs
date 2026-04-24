import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  executiveApprovedMemoryStorePath,
  executiveImprovementStorePath,
  executiveReflectionStorePath,
} from "../src/config.mjs";
import { buildLifecycleTransition } from "../src/executive-lifecycle.mjs";
import {
  applyImprovementWorkflowProposal,
  archiveExecutiveReflection,
  listImprovementWorkflowProposals,
  rollbackImprovementWorkflowProposal,
  registerImprovementWorkflowProposals,
  resolveImprovementWorkflowProposal,
} from "../src/executive-improvement-workflow.mjs";
import {
  appendExecutiveTaskImprovementProposal,
  getExecutiveTask,
  startExecutiveTask,
  updateExecutiveTask,
} from "../src/executive-task-state.mjs";
import { setupExecutiveTaskStateTestHarness } from "./helpers/executive-task-state-harness.mjs";

setupExecutiveTaskStateTestHarness();

async function snapshotFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function restoreFile(filePath, content) {
  if (content == null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.writeFile(filePath, content, "utf8");
}

test("improvement workflow archives reflections and supports approve/apply loop", async (t) => {
  const files = [
    executiveReflectionStorePath,
    executiveImprovementStorePath,
    executiveApprovedMemoryStorePath,
  ];
  const snapshots = await Promise.all(files.map((filePath) => snapshotFile(filePath)));
  t.after(async () => {
    await Promise.all(files.map((filePath, index) => restoreFile(filePath, snapshots[index])));
  });

  await fs.writeFile(
    executiveImprovementStorePath,
    `${JSON.stringify({
      items: [{
        id: "proposal-1",
        task_id: "stale-task",
        account_id: "acct-1",
        session_key: "sess-stale",
        reflection_id: "reflection-stale",
        category: "meeting_agent_improvement",
        mode: "proposal_only",
        title: "Require owner checklist",
        description: "stale proposal",
        target: "meeting-agent",
        source_error_type: "missing_owner",
        status: "pending_approval",
        decision_actor: "",
        decision_at: null,
        applied_by: "",
        applied_at: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }],
    }, null, 2)}\n`,
    "utf8",
  );

  const task = await startExecutiveTask({
    accountId: "acct-1",
    sessionKey: "sess-1",
    objective: "補強會議 owner 規則",
    primaryAgentId: "meeting",
    currentAgentId: "meeting",
  });
  const transition = buildLifecycleTransition({
    from: task.lifecycle_state,
    to: "clarified",
    reason: "test",
  });
  await updateExecutiveTask(task.id, transition.patch);
  const transition2 = buildLifecycleTransition({
    from: "clarified",
    to: "planned",
    reason: "test",
  });
  await updateExecutiveTask(task.id, transition2.patch);
  const transition3 = buildLifecycleTransition({
    from: "planned",
    to: "executing",
    reason: "test",
  });
  await updateExecutiveTask(task.id, transition3.patch);
  const transition4 = buildLifecycleTransition({
    from: "executing",
    to: "awaiting_result",
    reason: "test",
  });
  await updateExecutiveTask(task.id, transition4.patch);
  const transition5 = buildLifecycleTransition({
    from: "awaiting_result",
    to: "verifying",
    reason: "test",
  });
  await updateExecutiveTask(task.id, transition5.patch);
  const transition6 = buildLifecycleTransition({
    from: "verifying",
    to: "blocked",
    reason: "test",
  });
  await updateExecutiveTask(task.id, transition6.patch);
  const transition7 = buildLifecycleTransition({
    from: "blocked",
    to: "reflected",
    reason: "test",
  });
  await updateExecutiveTask(task.id, transition7.patch);

  const reflection = await archiveExecutiveReflection({
    accountId: "acct-1",
    sessionKey: "sess-1",
    taskId: task.id,
    reflection: {
      task_type: "meeting_processing",
      task_input: "這次會議缺 owner",
      action_taken: "輸出會議摘要",
      evidence_collected: [{ type: "summary_generated", summary: "meeting_summary" }],
      verification_result: { pass: false, issues: ["missing_owner"] },
      what_went_wrong: ["missing_owner"],
      missing_elements: ["owner"],
      routing_quality: { correct: true },
      response_quality: { robotic_response: false },
      error_type: "missing_owner",
    },
  });

  const proposals = await registerImprovementWorkflowProposals({
    accountId: "acct-1",
    sessionKey: "sess-1",
    taskId: task.id,
    reflectionId: reflection.id,
    reflection,
    proposals: [
      {
        id: "proposal-1",
        category: "meeting_agent_improvement",
        mode: "proposal_only",
        title: "Require owner checklist",
        description: "會議 action item 缺 owner 時，強制補待確認 owner。",
        target: "meeting-agent",
      },
      {
        id: "proposal-2",
        category: "verification_improvement",
        mode: "auto_apply",
        title: "Tighten verifier",
        description: "owner 缺失時不可 pass。",
        target: "executive-verifier",
      },
    ],
  });

  for (const proposal of proposals) {
    await appendExecutiveTaskImprovementProposal(task.id, proposal);
  }
  const improvementTransition = buildLifecycleTransition({
    from: "reflected",
    to: "improvement_proposed",
    reason: "test",
  });
  await updateExecutiveTask(task.id, improvementTransition.patch);

  const listed = await listImprovementWorkflowProposals({ accountId: "acct-1" });
  assert.equal(listed.length >= 2, true);
  assert.equal(listed.some((item) => item.id === "proposal-2" && item.status === "applied"), true);

  const approved = await resolveImprovementWorkflowProposal({
    proposalId: "proposal-1",
    approved: true,
    actor: "sean",
  });
  assert.equal(approved.status, "approved");

  const applied = await applyImprovementWorkflowProposal({
    proposalId: "proposal-1",
    actor: "sean",
  });
  assert.equal(applied.status, "applied");
  assert.ok(applied.effect_evidence);
  assert.equal(typeof applied.strategy_version, "number");
  assert.equal(applied.strategy_version >= 2, true);

  const finalTask = await getExecutiveTask(task.id);
  assert.equal(finalTask.improvement_proposals.some((item) => item.id === "proposal-1" && item.status === "applied"), true);
  assert.equal(finalTask.lifecycle_state, "improved");
});

test("learning auto-apply proposal rolls back on regressed replay delta with strategy version history", async (t) => {
  const files = [
    executiveImprovementStorePath,
  ];
  const snapshots = await Promise.all(files.map((filePath) => snapshotFile(filePath)));
  t.after(async () => {
    await Promise.all(files.map((filePath, index) => restoreFile(filePath, snapshots[index])));
  });

  const proposals = await registerImprovementWorkflowProposals({
    accountId: "acct-learning-regress",
    sessionKey: "sess-learning-regress",
    reflection: {
      error_type: "learning_loop",
    },
    proposals: [
      {
        id: "learning-tool-regress-1",
        category: "tool_weight_adjustment",
        mode: "human_approval",
        title: "Decrease tool weight",
        description: "regression case",
        target: "executive-planner",
        context: {
          source: "learning_loop",
          learning_kind: "tool_weight",
          ab_replay: {
            method: "ab_replay_time_split_v1",
            metric: "success_rate",
            better_direction: "higher",
            control: { sample_count: 2, success_rate: 1 },
            candidate: { sample_count: 2, success_rate: 0 },
            improvement_delta: {
              before: 1,
              after: 0,
              delta: -1,
              status: "regressed",
              measurable: true,
            },
          },
        },
      },
    ],
  });

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].mode, "auto_apply");
  assert.equal(proposals[0].status, "rolled_back");
  assert.equal(proposals[0].rollback?.rolled_back, true);
  assert.equal(proposals[0].verification_status, "failed");
  assert.equal(proposals[0].strategy_version >= 3, true);
  assert.equal(Array.isArray(proposals[0].strategy_history), true);
  assert.equal(proposals[0].strategy_history.some((item) => item.event === "rolled_back"), true);

  const rolledBack = await rollbackImprovementWorkflowProposal({
    proposalId: "learning-tool-regress-1",
    actor: "sean",
    reason: "manual_followup",
  });
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(rolledBack.rollback?.reason, "manual_followup");
});
