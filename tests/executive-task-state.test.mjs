import test from "node:test";
import assert from "node:assert/strict";

import {
  appendExecutiveAgentOutput,
  appendExecutiveTaskHandoff,
  appendExecutiveTaskTurn,
  clearActiveExecutiveTask,
  getActiveExecutiveTask,
  resetExecutiveTaskStateStoreForTests,
  startExecutiveTask,
} from "../src/executive-task-state.mjs";
import { setupExecutiveTaskStateTestHarness } from "./helpers/executive-task-state-harness.mjs";

setupExecutiveTaskStateTestHarness();

test("executive task state persists active task, turns, and handoffs", async () => {
  const accountId = "test-account";
  const sessionKey = `test-session-${Date.now()}`;
  const task = await startExecutiveTask({
    accountId,
    sessionKey,
    objective: "整理多 agent 任務",
    primaryAgentId: "ceo",
    supportingAgentIds: ["product"],
    workPlan: [
      { agent_id: "ceo", task: "做高層收斂" },
      { agent_id: "product", task: "做產品拆解" },
    ],
  });

  assert.equal(task?.primary_agent_id, "ceo");

  await appendExecutiveTaskTurn(task.id, {
    role: "user",
    text: "先由 CEO 看",
    agent_id: "ceo",
  });
  await appendExecutiveTaskHandoff(task.id, {
    from_agent_id: "ceo",
    to_agent_id: "product",
    reason: "轉交產品拆解",
  });
  await appendExecutiveAgentOutput(task.id, {
    agent_id: "product",
    task: "做產品拆解",
    summary: "產品角度已完成第一輪拆解",
  });

  const active = await getActiveExecutiveTask(accountId, sessionKey);
  assert.equal(active?.id, task.id);
  assert.equal(active?.work_plan?.length, 2);
  assert.equal(active?.turns?.length, 1);
  assert.equal(active?.handoffs?.length, 1);
  assert.equal(active?.agent_outputs?.length, 1);

  await clearActiveExecutiveTask(accountId, sessionKey);
  const cleared = await getActiveExecutiveTask(accountId, sessionKey);
  assert.equal(cleared, null);
});

test("executive task state preserves work-plan reflection metadata", async () => {
  const task = await startExecutiveTask({
    accountId: "metadata-account",
    sessionKey: "metadata-session",
    objective: "整理多步任務",
    primaryAgentId: "ceo",
    successCriteria: ["先回答問題", "有依據"],
    workPlan: [
      {
        agent_id: "ceo",
        task: "收斂答案",
        intent: "answer_user",
        success_criteria: ["先回答問題"],
      },
    ],
  });

  const active = await getActiveExecutiveTask("metadata-account", "metadata-session");
  assert.equal(active?.id, task?.id);
  assert.deepEqual(active?.work_plan, [
    {
      agent_id: "ceo",
      task: "收斂答案",
      intent: "answer_user",
      success_criteria: ["先回答問題"],
      selected_action: "",
      role: "",
      status: "pending",
      tool_required: false,
    },
  ]);
});

test("executive task state test reset clears prior active task", async () => {
  const accountId = "reset-account";
  const sessionKey = "reset-session";

  await startExecutiveTask({
    accountId,
    sessionKey,
    objective: "test reset",
    primaryAgentId: "ceo",
  });
  assert.ok(await getActiveExecutiveTask(accountId, sessionKey));

  await resetExecutiveTaskStateStoreForTests();

  assert.equal(await getActiveExecutiveTask(accountId, sessionKey), null);
});

test("stale active-task clear does not remove a newer session owner", async () => {
  const accountId = "stale-clear-account";
  const sessionKey = "stale-clear-session";

  const first = await startExecutiveTask({
    accountId,
    sessionKey,
    objective: "first task",
    primaryAgentId: "ceo",
  });
  const second = await startExecutiveTask({
    accountId,
    sessionKey,
    objective: "second task",
    primaryAgentId: "product",
  });

  const cleared = await clearActiveExecutiveTask(accountId, sessionKey, {
    expectedTaskId: first.id,
  });
  const active = await getActiveExecutiveTask(accountId, sessionKey);

  assert.equal(cleared, false);
  assert.equal(active?.id, second.id);

  await clearActiveExecutiveTask(accountId, sessionKey, {
    expectedTaskId: second.id,
  });
});
