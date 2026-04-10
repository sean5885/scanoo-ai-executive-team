import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const [
  {
    executePlannedUserInput,
    resetPlannerRuntimeContext,
    runPlannerToolFlow,
  },
  {
    applyPlannerWorkingMemoryPatch,
    getPlannerWorkingMemory,
    reloadPlannerConversationMemory,
    resetPlannerConversationMemory,
  },
  { runPlannerUserInputEdge },
] = await Promise.all([
  import("../src/executive-planner.mjs"),
  import("../src/planner-conversation-memory.mjs"),
  import("../src/planner-user-input-edge.mjs"),
]);

function seedWorkingMemory(sessionKey, patch = {}) {
  applyPlannerWorkingMemoryPatch({
    sessionKey,
    source: "test_seed_v2",
    patch: {
      current_goal: "seed goal",
      inferred_task_type: "document_lookup",
      last_selected_agent: "doc_agent",
      last_selected_skill: null,
      last_tool_result_summary: "seed summary",
      unresolved_slots: [],
      next_best_action: "search_company_brain_docs",
      confidence: 0.9,
      task_id: "task-seed-v2",
      task_type: "document_lookup",
      task_phase: "executing",
      task_status: "running",
      current_owner_agent: "doc_agent",
      previous_owner_agent: null,
      handoff_reason: null,
      retry_count: 0,
      retry_policy: {
        max_retries: 2,
        strategy: "same_agent_then_reroute",
      },
      slot_state: [],
      abandoned_task_ids: [],
      ...patch,
    },
  });
}

function buildSeedExecutionPlan({
  planId = "plan-seed-v2",
  planStatus = "active",
  currentStepId = "step-1",
  steps = [
    {
      step_id: "step-1",
      step_type: "planner_action",
      owner_agent: "doc_agent",
      intended_action: "search_company_brain_docs",
      status: "running",
      depends_on: [],
      retryable: true,
      artifact_refs: [],
      slot_requirements: [],
      failure_class: null,
      recovery_policy: null,
      recovery_state: {
        last_failure_class: null,
        recovery_attempt_count: 0,
        last_recovery_action: null,
        rollback_target_step_id: null,
      },
    },
  ],
} = {}) {
  return {
    plan_id: planId,
    plan_status: planStatus,
    current_step_id: currentStepId,
    steps,
  };
}

test.after(() => {
  testDb.close();
});

test("v2 keeps running task owner stable across multi-step follow-ups", async () => {
  const sessionKey = "wm-v2-running-owner";
  resetPlannerRuntimeContext({ sessionKey });
  seedWorkingMemory(sessionKey, {
    task_id: "task-v2-stable-1",
  });

  let plannerRequested = false;
  let forcedAction = null;
  const result = await executePlannedUserInput({
    text: "下一步",
    sessionKey,
    async requester() {
      plannerRequested = true;
      return JSON.stringify({
        action: "get_runtime_info",
        params: {},
      });
    },
    async toolFlowRunner(args) {
      forcedAction = args?.forcedSelection?.selected_action || null;
      return {
        selected_action: forcedAction,
        execution_result: {
          ok: true,
          action: forcedAction,
          data: {
            answer: "延續原任務 owner 繼續執行。",
            sources: ["running_owner_memory"],
            limitations: [],
          },
        },
        trace_id: "trace-wm-v2-running-owner",
      };
    },
  });

  assert.equal(plannerRequested, false);
  assert.equal(forcedAction, "search_company_brain_docs");
  assert.equal(result.action, "search_company_brain_docs");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 execution plan patch merges step updates without overwriting untouched steps", () => {
  const sessionKey = "wm-v2-plan-patch-merge";
  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
  seedWorkingMemory(sessionKey, {
    task_id: "task-v2-plan-merge",
    execution_plan: buildSeedExecutionPlan({
      planId: "plan-v2-merge-1",
      currentStepId: "step-2",
      steps: [
        {
          step_id: "step-1",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "search_company_brain_docs",
          status: "running",
          depends_on: [],
          retryable: true,
          artifact_refs: [],
          slot_requirements: [],
        },
        {
          step_id: "step-2",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "get_company_brain_doc_detail",
          status: "pending",
          depends_on: ["step-1"],
          retryable: true,
          artifact_refs: [],
          slot_requirements: [],
          failure_class: "tool_error",
          recovery_policy: "retry_same_step",
          recovery_state: {
            last_failure_class: "tool_error",
            recovery_attempt_count: 1,
            last_recovery_action: "retry_same_step",
            rollback_target_step_id: null,
          },
        },
      ],
    }),
  });

  const mergeResult = applyPlannerWorkingMemoryPatch({
    sessionKey,
    source: "test_plan_patch_merge",
    patch: {
      execution_plan: {
        plan_status: "active",
        current_step_id: "step-2",
        steps: [
          {
            step_id: "step-1",
            status: "completed",
            artifact_refs: ["trace:step1"],
          },
        ],
      },
    },
  });

  assert.equal(mergeResult.ok, true);
  const memory = getPlannerWorkingMemory({ sessionKey });
  assert.equal(memory.execution_plan.plan_id, "plan-v2-merge-1");
  assert.equal(memory.execution_plan.steps.length, 2);
  assert.equal(memory.execution_plan.steps[0].status, "completed");
  assert.equal(memory.execution_plan.steps[1].step_id, "step-2");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 active execution plan continues current step before selector fallback", async () => {
  const sessionKey = "wm-v2-active-plan-continue";
  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
  seedWorkingMemory(sessionKey, {
    task_id: "task-v2-active-plan-1",
    task_phase: "executing",
    task_status: "running",
    next_best_action: "search_company_brain_docs",
    execution_plan: buildSeedExecutionPlan({
      planId: "plan-v2-active-1",
      planStatus: "active",
      currentStepId: "step-2",
      steps: [
        {
          step_id: "step-1",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "search_company_brain_docs",
          status: "completed",
          depends_on: [],
          retryable: true,
          artifact_refs: ["doc_candidates"],
          slot_requirements: [],
        },
        {
          step_id: "step-2",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "get_company_brain_doc_detail",
          status: "running",
          depends_on: ["step-1"],
          retryable: true,
          artifact_refs: [],
          slot_requirements: [],
          failure_class: "tool_error",
          recovery_policy: "retry_same_step",
          recovery_state: {
            last_failure_class: "tool_error",
            recovery_attempt_count: 1,
            last_recovery_action: "retry_same_step",
            rollback_target_step_id: null,
          },
        },
      ],
    }),
  });

  let dispatchAction = null;
  const plannerEvents = [];
  const result = await runPlannerToolFlow({
    userIntent: "下一步",
    payload: {},
    sessionKey,
    logger: {
      info(event, payload) {
        if (event === "planner_end_to_end") {
          plannerEvents.push(payload);
        }
      },
      debug() {},
      warn() {},
      error() {},
    },
    selector() {
      return {
        selected_action: null,
        reason: "routing_no_match",
        routing_reason: "routing_no_match",
      };
    },
    async dispatcher({ action }) {
      dispatchAction = action;
      return {
        ok: true,
        action: "company_brain_doc_detail",
        item: { doc_id: "doc_1" },
        trace_id: "trace-wm-v2-active-plan",
      };
    },
  });

  const latestEvent = plannerEvents.at(-1) || {};
  assert.equal(dispatchAction, "get_company_brain_doc_detail");
  assert.equal(result.selected_action, "get_company_brain_doc_detail");
  assert.equal(latestEvent.plan_id, "plan-v2-active-1");
  assert.equal(latestEvent.current_step, "step-2");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 handles slot missing -> user fill -> continue execution within same task", async () => {
  const sessionKey = "wm-v2-slot-fill";
  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });

  await runPlannerUserInputEdge({
    text: "幫我找 onboarding 內容",
    sessionKey,
    async plannerExecutor() {
      return {
        ok: true,
        action: "search_and_detail_doc",
        synthetic_agent_hint: {
          agent: "doc_agent",
        },
        formatted_output: {
          kind: "search_and_detail_candidates",
        },
        execution_result: {
          ok: true,
          data: {
            answer: "我找到多份候選，請選一份。",
            sources: ["candidate_docs"],
            limitations: ["需要先選文件"],
          },
        },
      };
    },
  });

  const waitingMemory = getPlannerWorkingMemory({ sessionKey });
  assert.equal(waitingMemory.task_phase, "waiting_user");
  assert.equal(waitingMemory.task_status, "blocked");
  assert.equal(waitingMemory.unresolved_slots.includes("candidate_selection_required"), true);
  const waitingTaskId = waitingMemory.task_id;
  const waitingPlanId = waitingMemory.execution_plan?.plan_id;
  assert.equal(waitingMemory.execution_plan?.plan_status, "paused");
  const waitingStep = waitingMemory.execution_plan?.steps?.find((step) => step.step_id === waitingMemory.execution_plan.current_step_id);
  assert.equal(waitingStep?.failure_class, "missing_slot");
  assert.equal(waitingStep?.recovery_policy, "ask_user");
  assert.equal(waitingStep?.recovery_state?.last_recovery_action, "ask_user");

  await runPlannerUserInputEdge({
    text: "我選第一份",
    sessionKey,
    async plannerExecutor() {
      return {
        ok: true,
        action: "get_company_brain_doc_detail",
        synthetic_agent_hint: {
          agent: "doc_agent",
        },
        formatted_output: {
          kind: "detail",
          content_summary: "第一份文件重點已可讀取。",
        },
        execution_result: {
          ok: true,
          data: {
            answer: "已讀取第一份文件內容。",
            sources: ["doc_1"],
            limitations: [],
          },
        },
      };
    },
  });

  const continuedMemory = getPlannerWorkingMemory({ sessionKey });
  assert.equal(continuedMemory.task_id, waitingTaskId);
  assert.equal(continuedMemory.task_phase, "executing");
  assert.equal(continuedMemory.task_status, "running");
  assert.equal(Array.isArray(continuedMemory.unresolved_slots), true);
  assert.equal(continuedMemory.unresolved_slots.length, 0);
  assert.equal(continuedMemory.execution_plan.plan_id, waitingPlanId);
  assert.equal(continuedMemory.execution_plan.plan_status, "completed");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 execution plan persists multi-step progress and advances current step until done", async () => {
  const sessionKey = "wm-v2-plan-progress";
  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });

  await runPlannerUserInputEdge({
    text: "先搜尋再讀文件",
    sessionKey,
    async plannerExecutor() {
      return {
        ok: true,
        steps: [
          { action: "search_company_brain_docs", params: { q: "onboarding" } },
          { action: "get_company_brain_doc_detail", params: { doc_id: "doc_1" } },
        ],
        synthetic_agent_hint: {
          agent: "doc_agent",
        },
        execution_result: {
          ok: true,
          steps: [
            { action: "search_company_brain_docs" },
            { action: "get_company_brain_doc_detail" },
          ],
          results: [
            {
              ok: true,
              action: "company_brain_docs_search",
              items: [{ doc_id: "doc_1", title: "Onboarding SOP" }],
            },
          ],
          current_step_index: 1,
          trace_id: "trace-plan-progress-step1",
          data: {
            answer: "已完成第一步搜尋，準備讀取文件。",
            sources: ["doc_1"],
            limitations: [],
          },
        },
      };
    },
  });

  const memoryAfterStep1 = getPlannerWorkingMemory({ sessionKey });
  assert.equal(memoryAfterStep1.execution_plan.plan_status, "active");
  assert.equal(memoryAfterStep1.execution_plan.steps.length, 2);
  assert.equal(memoryAfterStep1.execution_plan.steps[0].status, "completed");
  assert.equal(memoryAfterStep1.execution_plan.steps[1].status, "running");
  assert.equal(memoryAfterStep1.execution_plan.current_step_id, memoryAfterStep1.execution_plan.steps[1].step_id);
  const persistedPlanId = memoryAfterStep1.execution_plan.plan_id;

  await runPlannerUserInputEdge({
    text: "繼續下一步",
    sessionKey,
    async plannerExecutor() {
      return {
        ok: true,
        action: "get_company_brain_doc_detail",
        synthetic_agent_hint: {
          agent: "doc_agent",
        },
        execution_result: {
          ok: true,
          data: {
            answer: "第二步完成，文件已讀取。",
            sources: ["doc_1_detail"],
            limitations: [],
          },
          trace_id: "trace-plan-progress-step2",
        },
      };
    },
  });

  const memoryAfterDone = getPlannerWorkingMemory({ sessionKey });
  assert.equal(memoryAfterDone.execution_plan.plan_id, persistedPlanId);
  assert.equal(memoryAfterDone.execution_plan.plan_status, "completed");
  assert.equal(memoryAfterDone.execution_plan.current_step_id, null);
  assert.equal(memoryAfterDone.execution_plan.steps[1].status, "completed");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 waiting_user continuation resumes current plan step instead of rebuilding route", async () => {
  const sessionKey = "wm-v2-plan-waiting-resume";
  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
  seedWorkingMemory(sessionKey, {
    task_id: "task-v2-plan-waiting-1",
    task_phase: "waiting_user",
    task_status: "blocked",
    unresolved_slots: ["candidate_selection_required"],
    slot_state: [
      {
        slot_key: "candidate_selection_required",
        required_by: "get_company_brain_doc_detail",
        status: "missing",
        source: "inferred",
        ttl: "2030-01-01T00:00:00.000Z",
      },
    ],
    execution_plan: buildSeedExecutionPlan({
      planId: "plan-v2-waiting-1",
      planStatus: "active",
      currentStepId: "step-2",
      steps: [
        {
          step_id: "step-1",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "search_company_brain_docs",
          status: "completed",
          depends_on: [],
          retryable: true,
          artifact_refs: ["doc_candidates"],
          slot_requirements: [],
        },
        {
          step_id: "step-2",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "get_company_brain_doc_detail",
          status: "blocked",
          depends_on: ["step-1"],
          retryable: true,
          artifact_refs: [],
          slot_requirements: ["candidate_selection_required"],
        },
      ],
    }),
  });

  let dispatchAction = null;
  const plannerEvents = [];
  await runPlannerToolFlow({
    userIntent: "我選第一份",
    payload: {},
    sessionKey,
    logger: {
      info(event, payload) {
        if (event === "planner_end_to_end") {
          plannerEvents.push(payload);
        }
      },
      debug() {},
      warn() {},
      error() {},
    },
    selector() {
      return {
        selected_action: null,
        reason: "routing_no_match",
        routing_reason: "routing_no_match",
      };
    },
    async dispatcher({ action }) {
      dispatchAction = action;
      return {
        ok: true,
        action: "company_brain_doc_detail",
        item: { doc_id: "doc_1" },
        trace_id: "trace-wm-v2-plan-waiting",
      };
    },
  });

  const latestEvent = plannerEvents.at(-1) || {};
  assert.equal(dispatchAction, "get_company_brain_doc_detail");
  assert.equal(latestEvent.resumed_from_waiting_user, true);
  assert.equal(latestEvent.plan_id, "plan-v2-waiting-1");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 retries with same agent before reroute when failure budget remains", async () => {
  const sessionKey = "wm-v2-retry-same";
  resetPlannerRuntimeContext({ sessionKey });
  seedWorkingMemory(sessionKey, {
    task_id: "task-v2-retry-1",
    task_phase: "failed",
    task_status: "failed",
    retry_count: 0,
    retry_policy: {
      max_retries: 2,
      strategy: "same_agent_then_reroute",
    },
    execution_plan: buildSeedExecutionPlan({
      planId: "plan-v2-retry-1",
      planStatus: "active",
      currentStepId: "step-retry-1",
      steps: [
        {
          step_id: "step-retry-1",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "search_company_brain_docs",
          status: "failed",
          depends_on: [],
          retryable: true,
          artifact_refs: [],
          slot_requirements: [],
          failure_class: "tool_error",
          recovery_policy: "retry_same_step",
          recovery_state: {
            last_failure_class: "tool_error",
            recovery_attempt_count: 1,
            last_recovery_action: "retry_same_step",
            rollback_target_step_id: null,
          },
        },
      ],
    }),
  });

  let dispatchAction = null;
  const plannerEvents = [];
  const result = await runPlannerToolFlow({
    userIntent: "再試一次",
    payload: {},
    sessionKey,
    logger: {
      info(event, payload) {
        if (event === "planner_end_to_end") {
          plannerEvents.push(payload);
        }
      },
      debug() {},
      warn() {},
      error() {},
    },
    selector() {
      return {
        selected_action: null,
        reason: "routing_no_match",
        routing_reason: "routing_no_match",
      };
    },
    async dispatcher({ action }) {
      dispatchAction = action;
      return {
        ok: true,
        action: "company_brain_docs_search",
        items: [],
        trace_id: "trace-wm-v2-retry-same",
      };
    },
  });

  const latestEvent = plannerEvents.at(-1) || {};
  assert.equal(dispatchAction, "search_company_brain_docs");
  assert.equal(result.selected_action, "search_company_brain_docs");
  assert.equal(latestEvent.retry_attempt?.mode, "same_step");
  assert.equal(latestEvent.resumed_from_retry, true);
  assert.equal(latestEvent.current_step, "step-retry-1");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 reroutes owner after retry threshold is crossed", async () => {
  const sessionKey = "wm-v2-reroute-after-retry";
  resetPlannerRuntimeContext({ sessionKey });
  seedWorkingMemory(sessionKey, {
    task_id: "task-v2-reroute-1",
    task_type: "runtime_info",
    inferred_task_type: "runtime_info",
    task_phase: "failed",
    task_status: "failed",
    retry_count: 1,
    current_owner_agent: "doc_agent",
    last_selected_agent: "doc_agent",
    retry_policy: {
      max_retries: 2,
      strategy: "same_agent_then_reroute",
    },
    execution_plan: buildSeedExecutionPlan({
      planId: "plan-v2-reroute-1",
      planStatus: "active",
      currentStepId: "step-reroute-1",
      steps: [
        {
          step_id: "step-reroute-1",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "search_company_brain_docs",
          status: "failed",
          depends_on: [],
          retryable: false,
          artifact_refs: [],
          slot_requirements: [],
          failure_class: "capability_gap",
          recovery_policy: "reroute_owner",
          recovery_state: {
            last_failure_class: "capability_gap",
            recovery_attempt_count: 2,
            last_recovery_action: "reroute_owner",
            rollback_target_step_id: null,
          },
        },
      ],
    }),
  });

  let dispatchAction = null;
  const plannerEvents = [];
  const result = await runPlannerToolFlow({
    userIntent: "再試一次",
    payload: {},
    sessionKey,
    logger: {
      info(event, payload) {
        if (event === "planner_end_to_end") {
          plannerEvents.push(payload);
        }
      },
      debug() {},
      warn() {},
      error() {},
    },
    selector() {
      return {
        selected_action: null,
        reason: "routing_no_match",
        routing_reason: "routing_no_match",
      };
    },
    async dispatcher({ action }) {
      dispatchAction = action;
      return {
        ok: true,
        action: "runtime_info",
        db_path: "/tmp/runtime-v2.db",
        node_pid: 777,
        cwd: "/tmp",
        trace_id: "trace-wm-v2-reroute",
      };
    },
  });

  const latestEvent = plannerEvents.at(-1) || {};
  assert.equal(dispatchAction, "get_runtime_info");
  assert.equal(result.selected_action, "get_runtime_info");
  assert.equal(latestEvent.retry_attempt?.mode, "reroute");
  assert.equal(latestEvent.agent_handoff?.reason, "capability_gap");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 marks retryable tool_error as retry_same_step recovery", async () => {
  const sessionKey = "wm-v2-recovery-tool-error";
  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
  seedWorkingMemory(sessionKey, {
    task_id: "task-v2-recovery-tool-error",
    task_phase: "executing",
    task_status: "running",
    current_owner_agent: "doc_agent",
    retry_count: 0,
    execution_plan: buildSeedExecutionPlan({
      planId: "plan-v2-recovery-tool-error",
      planStatus: "active",
      currentStepId: "step-tool-1",
      steps: [
        {
          step_id: "step-tool-1",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "search_company_brain_docs",
          status: "running",
          depends_on: [],
          retryable: true,
          artifact_refs: [],
          slot_requirements: [],
        },
      ],
    }),
  });

  await runPlannerUserInputEdge({
    text: "繼續",
    sessionKey,
    async plannerExecutor() {
      return {
        ok: false,
        action: "search_company_brain_docs",
        synthetic_agent_hint: {
          agent: "doc_agent",
        },
        execution_result: {
          ok: false,
          error: "tool_error",
          data: {
            answer: "工具失敗",
            sources: [],
            limitations: ["tool_error"],
          },
        },
      };
    },
  });

  const memory = getPlannerWorkingMemory({ sessionKey });
  const currentStep = memory.execution_plan.steps.find((step) => step.step_id === memory.execution_plan.current_step_id);
  assert.equal(memory.task_phase, "retrying");
  assert.equal(memory.task_status, "failed");
  assert.equal(currentStep?.status, "failed");
  assert.equal(currentStep?.failure_class, "tool_error");
  assert.equal(currentStep?.recovery_policy, "retry_same_step");
  assert.equal(currentStep?.recovery_state?.last_recovery_action, "retry_same_step");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 marks capability_gap as reroute_owner and updates owner", async () => {
  const sessionKey = "wm-v2-recovery-capability-gap";
  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
  seedWorkingMemory(sessionKey, {
    task_id: "task-v2-recovery-capability-gap",
    task_phase: "executing",
    task_status: "running",
    current_owner_agent: "doc_agent",
    previous_owner_agent: null,
    execution_plan: buildSeedExecutionPlan({
      planId: "plan-v2-recovery-capability-gap",
      planStatus: "active",
      currentStepId: "step-gap-1",
      steps: [
        {
          step_id: "step-gap-1",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "search_company_brain_docs",
          status: "running",
          depends_on: [],
          retryable: false,
          artifact_refs: [],
          slot_requirements: [],
        },
      ],
    }),
  });

  await runPlannerUserInputEdge({
    text: "繼續",
    sessionKey,
    async plannerExecutor() {
      return {
        ok: false,
        action: "get_runtime_info",
        synthetic_agent_hint: {
          agent: "runtime_agent",
        },
        execution_result: {
          ok: false,
          data: {
            answer: "目前 owner 需要改派",
            sources: [],
            limitations: ["capability_gap"],
          },
        },
      };
    },
  });

  const memory = getPlannerWorkingMemory({ sessionKey });
  const currentStep = memory.execution_plan.steps.find((step) => step.step_id === memory.execution_plan.current_step_id);
  assert.equal(memory.task_phase, "retrying");
  assert.equal(memory.task_status, "failed");
  assert.equal(memory.current_owner_agent, "runtime_agent");
  assert.equal(memory.previous_owner_agent, "doc_agent");
  assert.equal(memory.handoff_reason, "capability_gap");
  assert.equal(currentStep?.failure_class, "capability_gap");
  assert.equal(currentStep?.recovery_policy, "reroute_owner");
  assert.equal(currentStep?.owner_agent, "runtime_agent");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 invalid_artifact rolls back to dependency step", async () => {
  const sessionKey = "wm-v2-recovery-rollback";
  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
  seedWorkingMemory(sessionKey, {
    task_id: "task-v2-recovery-rollback",
    task_phase: "executing",
    task_status: "running",
    current_owner_agent: "doc_agent",
    execution_plan: buildSeedExecutionPlan({
      planId: "plan-v2-recovery-rollback",
      planStatus: "active",
      currentStepId: "step-2",
      steps: [
        {
          step_id: "step-1",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "search_company_brain_docs",
          status: "completed",
          depends_on: [],
          retryable: true,
          artifact_refs: ["doc_1"],
          slot_requirements: [],
        },
        {
          step_id: "step-2",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "get_company_brain_doc_detail",
          status: "running",
          depends_on: ["step-1"],
          retryable: true,
          artifact_refs: ["step:step-1"],
          slot_requirements: [],
        },
      ],
    }),
  });

  await runPlannerUserInputEdge({
    text: "繼續讀文件",
    sessionKey,
    async plannerExecutor() {
      return {
        ok: false,
        action: "get_company_brain_doc_detail",
        synthetic_agent_hint: {
          agent: "doc_agent",
        },
        execution_result: {
          ok: false,
          error: "invalid_artifact",
          data: {
            answer: "artifact 已失效",
            sources: [],
            limitations: ["invalid_artifact"],
          },
        },
      };
    },
  });

  const memory = getPlannerWorkingMemory({ sessionKey });
  const step1 = memory.execution_plan.steps.find((step) => step.step_id === "step-1");
  const step2 = memory.execution_plan.steps.find((step) => step.step_id === "step-2");
  assert.equal(memory.execution_plan.current_step_id, "step-1");
  assert.equal(step1?.status, "running");
  assert.equal(step2?.status, "pending");
  assert.equal(step2?.failure_class, "invalid_artifact");
  assert.equal(step2?.recovery_policy, "rollback_to_step");
  assert.equal(step2?.recovery_state?.last_recovery_action, "rollback_to_step");
  assert.equal(step2?.recovery_state?.rollback_target_step_id, "step-1");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 skips non-critical step when retry is not allowed", async () => {
  const sessionKey = "wm-v2-recovery-skip";
  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
  seedWorkingMemory(sessionKey, {
    task_id: "task-v2-recovery-skip",
    task_phase: "executing",
    task_status: "running",
    current_owner_agent: "doc_agent",
    retry_count: 2,
    retry_policy: {
      max_retries: 2,
      strategy: "same_agent_then_reroute",
    },
    execution_plan: buildSeedExecutionPlan({
      planId: "plan-v2-recovery-skip",
      planStatus: "active",
      currentStepId: "step-2",
      steps: [
        {
          step_id: "step-1",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "search_company_brain_docs",
          status: "completed",
          depends_on: [],
          retryable: true,
          artifact_refs: ["doc_1"],
          slot_requirements: [],
        },
        {
          step_id: "step-2",
          step_type: "non_critical",
          owner_agent: "doc_agent",
          intended_action: "search_and_summarize",
          status: "running",
          depends_on: ["step-1"],
          retryable: false,
          artifact_refs: [],
          slot_requirements: [],
        },
        {
          step_id: "step-3",
          step_type: "planner_action",
          owner_agent: "runtime_agent",
          intended_action: "get_runtime_info",
          status: "pending",
          depends_on: ["step-2"],
          retryable: true,
          artifact_refs: [],
          slot_requirements: [],
        },
      ],
    }),
  });

  await runPlannerUserInputEdge({
    text: "繼續",
    sessionKey,
    async plannerExecutor() {
      return {
        ok: false,
        action: "search_and_summarize",
        synthetic_agent_hint: {
          agent: "doc_agent",
        },
        execution_result: {
          ok: false,
          error: "tool_error",
          data: {
            answer: "非關鍵步驟失敗",
            sources: [],
            limitations: ["tool_error"],
          },
        },
      };
    },
  });

  const memory = getPlannerWorkingMemory({ sessionKey });
  const step2 = memory.execution_plan.steps.find((step) => step.step_id === "step-2");
  const step3 = memory.execution_plan.steps.find((step) => step.step_id === "step-3");
  assert.equal(memory.task_phase, "executing");
  assert.equal(memory.task_status, "running");
  assert.equal(step2?.status, "skipped");
  assert.equal(step2?.recovery_policy, "skip_step");
  assert.equal(step2?.recovery_state?.last_recovery_action, "skip_step");
  assert.equal(memory.execution_plan.current_step_id, "step-3");
  assert.equal(step3?.status, "running");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 unknown failure stays fail-closed without blind retry", async () => {
  const sessionKey = "wm-v2-recovery-unknown";
  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
  seedWorkingMemory(sessionKey, {
    task_id: "task-v2-recovery-unknown",
    task_phase: "executing",
    task_status: "running",
    retry_count: 1,
    current_owner_agent: "doc_agent",
    execution_plan: buildSeedExecutionPlan({
      planId: "plan-v2-recovery-unknown",
      planStatus: "active",
      currentStepId: "step-unknown-1",
      steps: [
        {
          step_id: "step-unknown-1",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "search_company_brain_docs",
          status: "running",
          depends_on: [],
          retryable: true,
          artifact_refs: [],
          slot_requirements: [],
        },
      ],
    }),
  });

  await runPlannerUserInputEdge({
    text: "繼續",
    sessionKey,
    async plannerExecutor() {
      return {
        ok: false,
        action: "search_company_brain_docs",
        synthetic_agent_hint: {
          agent: "doc_agent",
        },
        execution_result: {
          ok: false,
          data: {
            answer: "無法歸類的失敗",
            sources: [],
            limitations: ["unknown"],
          },
        },
      };
    },
  });

  const memory = getPlannerWorkingMemory({ sessionKey });
  const currentStep = memory.execution_plan.steps.find((step) => step.step_id === memory.execution_plan.current_step_id);
  assert.equal(memory.retry_count, 1);
  assert.equal(memory.task_phase, "waiting_user");
  assert.equal(memory.task_status, "blocked");
  assert.equal(currentStep?.status, "blocked");
  assert.equal(currentStep?.failure_class, "unknown");
  assert.equal(currentStep?.recovery_policy, "ask_user");
  assert.equal(currentStep?.recovery_state?.last_recovery_action, "ask_user");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 creates a new task and abandons old task on clear topic switch", async () => {
  const sessionKey = "wm-v2-topic-switch";
  resetPlannerRuntimeContext({ sessionKey });
  seedWorkingMemory(sessionKey, {
    task_id: "task-v2-old-topic",
    task_type: "document_lookup",
    inferred_task_type: "document_lookup",
    task_phase: "executing",
    task_status: "running",
    execution_plan: buildSeedExecutionPlan({
      planId: "plan-v2-old-topic",
      planStatus: "active",
      currentStepId: "step-topic-1",
      steps: [
        {
          step_id: "step-topic-1",
          step_type: "planner_action",
          owner_agent: "doc_agent",
          intended_action: "search_company_brain_docs",
          status: "running",
          depends_on: [],
          retryable: true,
          artifact_refs: [],
          slot_requirements: [],
        },
      ],
    }),
  });
  const memoryLogs = [];

  await runPlannerUserInputEdge({
    text: "改問 runtime pid 是多少",
    sessionKey,
    logger: {
      info(event, payload) {
        if (event === "planner_working_memory") {
          memoryLogs.push(payload);
        }
      },
      debug() {},
      warn() {},
      error() {},
    },
    async plannerExecutor() {
      return {
        ok: true,
        action: "get_runtime_info",
        synthetic_agent_hint: {
          agent: "runtime_agent",
        },
        execution_result: {
          ok: true,
          data: {
            answer: "目前 pid 可讀。",
            sources: ["runtime_info"],
            limitations: [],
          },
        },
      };
    },
  });

  const switchedMemory = getPlannerWorkingMemory({ sessionKey });
  assert.notEqual(switchedMemory.task_id, "task-v2-old-topic");
  assert.equal(switchedMemory.task_type, "runtime_info");
  assert.equal(switchedMemory.abandoned_task_ids.includes("task-v2-old-topic"), true);
  assert.notEqual(switchedMemory.execution_plan.plan_id, "plan-v2-old-topic");
  const boundaryLog = memoryLogs.find((item) => item?.memory_stage === "answer_boundary_write_back");
  assert.equal(boundaryLog?.plan_invalidated?.plan_id, "plan-v2-old-topic");

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 ignores expired slot TTL so stale slots do not affect later routing", async () => {
  const sessionKey = "wm-v2-slot-ttl-expired";
  resetPlannerRuntimeContext({ sessionKey });
  seedWorkingMemory(sessionKey, {
    task_id: "task-v2-expired-slot",
    task_phase: "waiting_user",
    task_status: "blocked",
    last_selected_agent: null,
    current_owner_agent: null,
    next_best_action: null,
    unresolved_slots: ["candidate_selection_required"],
    slot_state: [
      {
        slot_key: "candidate_selection_required",
        required_by: "search_and_detail_doc",
        status: "missing",
        source: "inferred",
        ttl: "2020-01-01T00:00:00.000Z",
      },
    ],
  });

  let dispatcherCalled = false;
  const result = await runPlannerToolFlow({
    userIntent: "繼續",
    payload: {},
    sessionKey,
    logger: {
      info() {},
      debug() {},
      warn() {},
      error() {},
    },
    selector() {
      return {
        selected_action: null,
        reason: "routing_no_match",
        routing_reason: "routing_no_match",
      };
    },
    async dispatcher() {
      dispatcherCalled = true;
      return {
        ok: true,
      };
    },
  });

  assert.equal(dispatcherCalled, false);
  assert.equal(result.selected_action, null);

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("v2 malformed execution plan fails closed without crashing runtime routing", async () => {
  const originalPath = process.env.PLANNER_CONVERSATION_MEMORY_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "planner-memory-v2-plan-"));
  const tempStorePath = join(tempDir, "planner-conversation-memory.json");
  try {
    process.env.PLANNER_CONVERSATION_MEMORY_PATH = tempStorePath;
    writeFileSync(tempStorePath, JSON.stringify({
      latest_session_key: "wm-v2-invalid-plan",
      sessions: {
        "wm-v2-invalid-plan": {
          recent_messages: [],
          latest_summary: null,
          turns_since_summary: 0,
          chars_since_summary: 0,
          total_turns: 0,
          last_compacted_at: null,
          working_memory: {
            current_goal: "seed",
            inferred_task_type: "document_lookup",
            last_selected_agent: "doc_agent",
            last_selected_skill: null,
            last_tool_result_summary: "seed",
            unresolved_slots: [],
            next_best_action: "search_company_brain_docs",
            confidence: 0.8,
            task_id: "task-invalid-plan",
            task_type: "document_lookup",
            task_phase: "executing",
            task_status: "running",
            current_owner_agent: "doc_agent",
            previous_owner_agent: null,
            handoff_reason: null,
            retry_count: 0,
            retry_policy: {
              max_retries: 2,
              strategy: "same_agent_then_reroute",
            },
            slot_state: [],
            abandoned_task_ids: [],
            execution_plan: {
              plan_id: "plan-invalid",
              plan_status: "active",
              current_step_id: "step-1",
              steps: "invalid-shape",
            },
            updated_at: "2026-04-09T00:00:00.000Z",
          },
        },
      },
    }, null, 2));

    reloadPlannerConversationMemory();
    let dispatcherCalled = false;
    const result = await runPlannerToolFlow({
      userIntent: "繼續",
      payload: {},
      sessionKey: "wm-v2-invalid-plan",
      logger: {
        info() {},
        debug() {},
        warn() {},
        error() {},
      },
      selector() {
        return {
          selected_action: null,
          reason: "routing_no_match",
          routing_reason: "routing_no_match",
        };
      },
      async dispatcher() {
        dispatcherCalled = true;
        return {
          ok: true,
        };
      },
    });

    assert.equal(dispatcherCalled, false);
    assert.equal(result.selected_action, null);
    assert.equal(result.execution_result?.ok, false);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PLANNER_CONVERSATION_MEMORY_PATH;
    } else {
      process.env.PLANNER_CONVERSATION_MEMORY_PATH = originalPath;
    }
    reloadPlannerConversationMemory();
    rmSync(tempDir, { recursive: true, force: true });
    resetPlannerConversationMemory({ sessionKey: "wm-v2-invalid-plan" });
  }
});
