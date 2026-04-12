import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const [{ buildPlannerTaskTraceDiagnostics }, {
  runPlannerToolFlow,
  resetPlannerRuntimeContext,
}, {
  applyPlannerWorkingMemoryPatch,
  resetPlannerConversationMemory,
}, { runPlannerUserInputEdge }] = await Promise.all([
  import("../src/planner-working-memory-trace.mjs"),
  import("../src/executive-planner.mjs"),
  import("../src/planner-conversation-memory.mjs"),
  import("../src/planner-user-input-edge.mjs"),
]);

test.after(() => {
  testDb.close();
});

test("task trace snapshot text is human-readable for multi-step task state", () => {
  const trace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "runPlannerToolFlow_router_decision",
    memorySnapshot: {
      task_id: "task-trace-001",
      task_type: "document_lookup",
      task_phase: "executing",
      task_status: "running",
      current_owner_agent: "doc_agent",
      previous_owner_agent: "doc_agent",
      handoff_reason: null,
      retry_count: 0,
      retry_policy: {
        max_retries: 2,
        strategy: "same_agent_then_reroute",
      },
      next_best_action: "search_company_brain_docs",
      slot_state: [
        {
          slot_key: "candidate_selection_required",
          status: "missing",
        },
      ],
      abandoned_task_ids: [],
    },
  });

  assert.match(trace.text, /\[task-trace\] runPlannerToolFlow_router_decision/);
  assert.match(trace.text, /task_id=task-trace-001/);
  assert.match(trace.text, /phase=executing/);
  assert.match(trace.text, /slot_state: missing=\[candidate_selection_required\]/);
});

test("task trace shows slot diff from missing to filled", () => {
  const trace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "answer_boundary_write_back",
    previousMemorySnapshot: {
      task_id: "task-slot-001",
      slot_state: [
        {
          slot_key: "email",
          status: "missing",
        },
      ],
    },
    memorySnapshot: {
      task_id: "task-slot-001",
      slot_state: [
        {
          slot_key: "email",
          status: "filled",
        },
      ],
    },
  });

  assert.equal(trace.diff.includes("slot.email: missing -> filled"), true);
});

test("task trace shows retry diff when retry count increments", () => {
  const trace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "runPlannerToolFlow_router_decision",
    previousMemorySnapshot: {
      task_id: "task-retry-001",
      retry_count: 1,
      retry_policy: {
        max_retries: 2,
        strategy: "same_agent_then_reroute",
      },
    },
    memorySnapshot: {
      task_id: "task-retry-001",
      retry_count: 2,
      retry_policy: {
        max_retries: 2,
        strategy: "same_agent_then_reroute",
      },
    },
    observability: {
      retry_attempt: {
        from: 1,
        to: 2,
      },
    },
  });

  assert.equal(trace.diff.includes("retry_count: 1 -> 2"), true);
});

test("task trace exposes agent handoff changes", () => {
  const trace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "runPlannerToolFlow_router_decision",
    previousMemorySnapshot: {
      task_id: "task-handoff-001",
      current_owner_agent: "doc_agent",
      handoff_reason: null,
    },
    memorySnapshot: {
      task_id: "task-handoff-001",
      current_owner_agent: "runtime_agent",
      handoff_reason: "retry",
    },
    observability: {
      agent_handoff: {
        from: "doc_agent",
        to: "runtime_agent",
        reason: "retry",
      },
    },
  });

  assert.equal(trace.diff.includes("current_owner_agent: doc_agent -> runtime_agent"), true);
  assert.equal(trace.diff.includes("handoff_reason: none -> retry"), true);
});

test("task trace shows topic-switch as new task plus abandoned task", () => {
  const trace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "answer_boundary_write_back",
    previousMemorySnapshot: {
      task_id: "task-old-topic",
      abandoned_task_ids: [],
    },
    memorySnapshot: {
      task_id: "task-new-topic",
      abandoned_task_ids: ["task-old-topic"],
    },
    observability: {
      task_abandoned: {
        task_id: "task-old-topic",
        reason: "topic_switch",
      },
    },
  });

  assert.equal(trace.diff.includes("task_id: task-old-topic -> task-new-topic"), true);
  assert.equal(trace.diff.includes("abandoned_task_ids: [] -> [task-old-topic]"), true);
});

test("task trace includes execution plan transitions and resume markers", () => {
  const trace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "answer_boundary_write_back",
    previousMemorySnapshot: {
      task_id: "task-plan-trace",
      execution_plan: {
        plan_id: "plan-1",
        plan_status: "paused",
        current_step_id: "step-1",
        steps: [
          {
            step_id: "step-1",
            status: "blocked",
          },
        ],
      },
    },
    memorySnapshot: {
      task_id: "task-plan-trace",
      execution_plan: {
        plan_id: "plan-1",
        plan_status: "active",
        current_step_id: "step-2",
        steps: [
          {
            step_id: "step-1",
            status: "completed",
          },
          {
            step_id: "step-2",
            status: "running",
          },
        ],
      },
    },
    observability: {
      step_transition: {
        from_current_step_id: "step-1",
        to_current_step_id: "step-2",
        steps: [
          {
            step_id: "step-1",
            from: "blocked",
            to: "completed",
          },
        ],
      },
      resumed_from_waiting_user: true,
    },
  });

  assert.equal(trace.diff.includes("plan_status: paused -> active"), true);
  assert.equal(trace.diff.includes("current_step: step-1 -> step-2"), true);
  assert.equal(trace.diff.includes("plan.step.step-1: blocked -> completed"), true);
  assert.equal(trace.diff.includes("resume: waiting_user"), true);
});

test("task trace exposes recovery policy diagnostics fields", () => {
  const trace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "answer_boundary_write_back",
    previousMemorySnapshot: {
      task_id: "task-recovery-trace",
      execution_plan: {
        plan_id: "plan-recovery-trace",
        plan_status: "active",
        current_step_id: "step-2",
        steps: [
          {
            step_id: "step-2",
            status: "failed",
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
      },
    },
    memorySnapshot: {
      task_id: "task-recovery-trace",
      execution_plan: {
        plan_id: "plan-recovery-trace",
        plan_status: "active",
        current_step_id: "step-3",
        steps: [
          {
            step_id: "step-2",
            status: "skipped",
            failure_class: "tool_error",
            recovery_policy: "skip_step",
            recovery_state: {
              last_failure_class: "tool_error",
              recovery_attempt_count: 2,
              last_recovery_action: "skip_step",
              rollback_target_step_id: null,
            },
          },
          {
            step_id: "step-3",
            status: "running",
          },
        ],
      },
    },
    observability: {
      failure_class: "tool_error",
      recovery_policy: "skip_step",
      recovery_action: "skip_step",
      recovery_attempt_count: 2,
      rollback_target_step_id: null,
      skipped_step_ids: ["step-2"],
    },
  });

  assert.equal(trace.diff.includes("failure_class: tool_error"), true);
  assert.equal(trace.diff.includes("recovery_policy: skip_step"), true);
  assert.equal(trace.diff.includes("recovery_action: skip_step"), true);
  assert.equal(trace.diff.includes("recovery_attempt_count: 2"), true);
  assert.equal(trace.diff.includes("skipped_step_ids: [step-2]"), true);
  assert.equal(trace.summary.includes("recovery="), true);
});

test("task trace shows artifact invalidation impact and dependency diagnostics", () => {
  const trace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "answer_boundary_write_back",
    previousMemorySnapshot: {
      task_id: "task-artifact-trace",
      execution_plan: {
        plan_id: "plan-artifact-trace",
        plan_status: "active",
        current_step_id: "step-2",
        steps: [
          {
            step_id: "step-1",
            status: "completed",
          },
          {
            step_id: "step-2",
            status: "running",
          },
        ],
        artifacts: [
          {
            artifact_id: "step-1_artifact_1",
            artifact_type: "search_result",
            produced_by_step_id: "step-1",
            validity_status: "valid",
            consumed_by_step_ids: ["step-2"],
          },
        ],
        dependency_edges: [
          {
            from_step_id: "step-1",
            to_step_id: "step-2",
            via_artifact_id: "step-1_artifact_1",
            dependency_type: "hard",
          },
        ],
      },
    },
    memorySnapshot: {
      task_id: "task-artifact-trace",
      execution_plan: {
        plan_id: "plan-artifact-trace",
        plan_status: "active",
        current_step_id: "step-1",
        steps: [
          {
            step_id: "step-1",
            status: "running",
          },
          {
            step_id: "step-2",
            status: "pending",
          },
        ],
        artifacts: [
          {
            artifact_id: "step-1_artifact_1",
            artifact_type: "search_result",
            produced_by_step_id: "step-1",
            validity_status: "invalid",
            consumed_by_step_ids: ["step-2"],
          },
        ],
        dependency_edges: [
          {
            from_step_id: "step-1",
            to_step_id: "step-2",
            via_artifact_id: "step-1_artifact_1",
            dependency_type: "hard",
          },
        ],
      },
    },
    observability: {
      failure_class: "invalid_artifact",
      recovery_policy: "rollback_to_step",
      recovery_action: "rollback_to_step",
      rollback_target_step_id: "step-1",
      artifact_id: "step-1_artifact_1",
      artifact_type: "search_result",
      validity_status: "invalid",
      produced_by_step_id: "step-1",
      affected_downstream_steps: ["step-2"],
      dependency_type: "hard",
      dependency_blocked_step: "step-2",
    },
  });

  assert.equal(trace.diff.includes("validity_status: valid -> invalid"), true);
  assert.equal(trace.diff.includes("artifact_id: step-1_artifact_1"), true);
  assert.equal(trace.diff.includes("affected_downstream_steps: [step-2]"), true);
  assert.equal(trace.diff.includes("dependency_type: hard"), true);
  assert.equal(trace.diff.includes("dependency_blocked_step: step-2"), true);
  assert.match(trace.text, /artifact: id=step-1_artifact_1/);
});

test("task trace includes readiness gate diagnostics in diff and summary text", () => {
  const trace = buildPlannerTaskTraceDiagnostics({
    memoryStage: "runPlannerToolFlow_router_decision",
    memorySnapshot: {
      task_id: "task-readiness-trace",
      task_type: "document_lookup",
      task_phase: "executing",
      task_status: "running",
      current_owner_agent: "doc_agent",
      execution_plan: {
        plan_id: "plan-readiness-trace",
        plan_status: "active",
        current_step_id: "step-2",
        steps: [
          {
            step_id: "step-1",
            status: "completed",
          },
          {
            step_id: "step-2",
            status: "running",
          },
        ],
      },
    },
    observability: {
      readiness: {
        is_ready: false,
        blocking_reason_codes: ["missing_slot", "owner_mismatch"],
        missing_slots: ["candidate_selection_required"],
        invalid_artifacts: [],
        blocked_dependencies: [],
        owner_ready: false,
        recovery_ready: true,
        recommended_action: "ask_user",
      },
      blocking_reason_codes: ["missing_slot", "owner_mismatch"],
      missing_slots: ["candidate_selection_required"],
      owner_ready: false,
      recovery_ready: true,
      recommended_action: "ask_user",
    },
  });

  assert.equal(trace.diff.includes("readiness.is_ready: false"), true);
  assert.equal(trace.diff.includes("blocking_reason_codes: [missing_slot, owner_mismatch]"), true);
  assert.equal(trace.diff.includes("missing_slots: [candidate_selection_required]"), true);
  assert.equal(trace.diff.includes("owner_ready: false"), true);
  assert.equal(trace.diff.includes("recommended_action: ask_user"), true);
  assert.match(trace.text, /readiness: is_ready=false/);
  assert.equal(trace.event_alignment.readiness_is_ready, true);
  assert.equal(trace.event_alignment.blocking_reason_codes, true);
  assert.equal(trace.event_alignment.recommended_action, true);
});

test("planner logs task trace at memory pre-read and router decision", async () => {
  const sessionKey = "wm-trace-hook-router";
  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
  applyPlannerWorkingMemoryPatch({
    sessionKey,
    source: "trace_test_seed",
    patch: {
      task_id: "task-trace-hook-router",
      task_type: "document_lookup",
      task_phase: "executing",
      task_status: "running",
      current_owner_agent: "doc_agent",
      retry_count: 0,
      retry_policy: {
        max_retries: 2,
        strategy: "same_agent_then_reroute",
      },
    },
  });

  const memoryLogs = [];
  await runPlannerToolFlow({
    userIntent: "下一步",
    payload: {},
    sessionKey,
    disableAutoRouting: true,
    logger: {
      info(event, payload) {
        if (event === "planner_working_memory") {
          memoryLogs.push(payload);
        }
      },
      debug(event, payload) {
        if (event === "planner_working_memory") {
          memoryLogs.push(payload);
        }
      },
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
      return {
        ok: false,
        error: "business_error",
      };
    },
  });

  const preReadLog = memoryLogs.find((item) => item?.memory_stage === "runPlannerToolFlow_pre_read");
  const routerDecisionLog = memoryLogs.find((item) => item?.memory_stage === "runPlannerToolFlow_router_decision");
  assert.ok(preReadLog);
  assert.ok(routerDecisionLog);
  assert.match(preReadLog.task_trace_text || "", /\[task-trace\]/);
  assert.match(routerDecisionLog.task_trace_text || "", /\[task-trace\]/);

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});

test("answer boundary write-back log carries slot diff trace", async () => {
  const sessionKey = "wm-trace-hook-boundary";
  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
  applyPlannerWorkingMemoryPatch({
    sessionKey,
    source: "trace_test_seed",
    patch: {
      task_id: "task-slot-boundary",
      task_type: "document_lookup",
      task_phase: "waiting_user",
      task_status: "blocked",
      current_owner_agent: "doc_agent",
      slot_state: [
        {
          slot_key: "email",
          required_by: "search_company_brain_docs",
          status: "missing",
          source: "inferred",
          ttl: "2030-01-01T00:00:00.000Z",
        },
      ],
      unresolved_slots: ["email"],
    },
  });

  const memoryLogs = [];
  await runPlannerUserInputEdge({
    text: "email 是 owner@lobster.ai",
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
        action: "search_company_brain_docs",
        synthetic_agent_hint: {
          agent: "doc_agent",
        },
        execution_result: {
          ok: true,
          data: {
            answer: "已補齊 email 並繼續。",
            sources: ["runtime"],
            limitations: [],
          },
        },
      };
    },
    workingMemoryWriter() {
      return {
        ok: true,
        observability: {
          memory_snapshot: {
            task_id: "task-slot-boundary",
            task_type: "document_lookup",
            task_phase: "executing",
            task_status: "running",
            current_owner_agent: "doc_agent",
            previous_owner_agent: "doc_agent",
            handoff_reason: null,
            retry_count: 0,
            retry_policy: {
              max_retries: 2,
              strategy: "same_agent_then_reroute",
            },
            next_best_action: "search_company_brain_docs",
            slot_state: [
              {
                slot_key: "email",
                required_by: "search_company_brain_docs",
                status: "filled",
                source: "user",
                ttl: "2030-01-01T00:00:00.000Z",
              },
            ],
            abandoned_task_ids: [],
          },
          task_id: "task-slot-boundary",
          task_phase_transition: "waiting_user->executing",
          task_status_transition: "blocked->running",
          slot_update: {
            pending_slots: [],
            slot_state_count: 1,
          },
        },
      };
    },
  });

  const boundaryLog = memoryLogs.find((item) => item?.memory_stage === "answer_boundary_write_back");
  assert.ok(boundaryLog);
  assert.equal(Array.isArray(boundaryLog.task_trace_diff), true);
  assert.equal(boundaryLog.task_trace_diff.includes("slot.email: missing -> filled"), true);

  resetPlannerRuntimeContext({ sessionKey });
  resetPlannerConversationMemory({ sessionKey });
});
