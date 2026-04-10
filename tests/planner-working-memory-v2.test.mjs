import test from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(latestEvent.retry_attempt?.mode, "same_agent");

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
  assert.equal(latestEvent.agent_handoff?.reason, "retry");

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
  });

  await runPlannerUserInputEdge({
    text: "改問 runtime pid 是多少",
    sessionKey,
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
