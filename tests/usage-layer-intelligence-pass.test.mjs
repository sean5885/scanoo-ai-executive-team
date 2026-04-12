import test from "node:test";
import assert from "node:assert/strict";

const {
  applyUsageLayerContinuityCopy,
  evaluateUsageLayerIntelligencePass,
} = await import("../src/usage-layer-intelligence-pass.mjs");

test("usage pass treats short slot-fill follow-up as continuation", () => {
  const pass = evaluateUsageLayerIntelligencePass({
    requestText: "第一份",
    taskType: "document_lookup",
    workingMemory: {
      task_id: "task-usage-1",
      task_type: "document_lookup",
      task_phase: "waiting_user",
      task_status: "blocked",
      current_goal: "請選候選文件",
      next_best_action: "get_company_brain_doc_detail",
      unresolved_slots: ["candidate_selection_required"],
      slot_state: [
        {
          slot_key: "candidate_selection_required",
          status: "missing",
        },
      ],
    },
    unresolvedSlots: ["candidate_selection_required"],
    currentPlanStep: {
      step_id: "step-2",
      owner_agent: "doc_agent",
      intended_action: "get_company_brain_doc_detail",
    },
    selectedAction: "get_company_brain_doc_detail",
    routingReason: "working_memory_waiting_user_resume_plan_step",
  });

  assert.equal(pass.ok, true);
  assert.equal(pass.diagnostics.interpreted_as_continuation, true);
  assert.equal(pass.diagnostics.interpreted_as_new_task, false);
  assert.equal(pass.diagnostics.response_continuity_score, "high");
});

test("usage pass treats candidate-selection follow-up as continuation without action hints", () => {
  const pass = evaluateUsageLayerIntelligencePass({
    requestText: "第一份",
    taskType: "document_lookup",
    workingMemory: {
      task_id: "task-usage-selection-no-action",
      task_type: "document_lookup",
      task_phase: "executing",
      task_status: "running",
      current_goal: "整理文件並完成下一步",
      next_best_action: null,
      unresolved_slots: [],
      slot_state: [],
    },
    unresolvedSlots: [],
    currentPlanStep: {
      step_id: "step-2",
      owner_agent: "doc_agent",
      intended_action: null,
    },
    selectedAction: "",
    routingReason: "selector_new_task",
  });

  assert.equal(pass.ok, true);
  assert.equal(pass.diagnostics.interpreted_as_continuation, true);
  assert.equal(pass.diagnostics.interpreted_as_new_task, false);
});

test("usage pass detects redundant ask when slot is already filled", () => {
  const pass = evaluateUsageLayerIntelligencePass({
    requestText: "我剛剛已經給你了",
    workingMemory: {
      task_id: "task-usage-2",
      task_phase: "waiting_user",
      task_status: "blocked",
      slot_state: [
        {
          slot_key: "candidate_selection_required",
          status: "filled",
        },
      ],
    },
    unresolvedSlots: [],
    observability: {
      recovery_action: "ask_user",
      recommended_action: "ask_user",
    },
    userResponse: {
      ok: false,
      answer: "請再提供文件選擇。",
      sources: [],
      limitations: ["請補候選文件編號"],
    },
  });

  assert.equal(pass.diagnostics.redundant_question_detected, true);
  assert.equal(pass.diagnostics.usage_issue_codes.includes("redundant_slot_ask"), true);
  assert.equal(pass.diagnostics.slot_suppressed_ask, true);
  assert.equal(pass.behavior.ask_user_suppressed, true);
});

test("usage pass marks obvious topic switch as new task", () => {
  const pass = evaluateUsageLayerIntelligencePass({
    requestText: "改問 runtime pid 是多少",
    taskType: "runtime_info",
    workingMemory: {
      task_id: "task-usage-3",
      task_type: "document_lookup",
      task_phase: "executing",
      task_status: "running",
      current_goal: "整理 onboarding 文件",
      next_best_action: "search_company_brain_docs",
    },
    selectedAction: "get_runtime_info",
    routingReason: "selector_get_runtime_info",
  });

  assert.equal(pass.diagnostics.interpreted_as_continuation, false);
  assert.equal(pass.diagnostics.interpreted_as_new_task, true);
});

test("usage pass and continuity copy expose reroute context to user-visible sources", () => {
  const pass = evaluateUsageLayerIntelligencePass({
    requestText: "接著改由 runtime 處理",
    workingMemory: {
      task_id: "task-usage-4",
      task_type: "document_lookup",
      task_phase: "retrying",
      task_status: "failed",
      current_goal: "查詢 runtime path",
      slot_state: [],
    },
    observability: {
      recovery_action: "reroute_owner",
      resumed_from_retry: true,
      agent_handoff: {
        from: "doc_agent",
        to: "runtime_agent",
        reason: "capability_gap",
      },
    },
    userResponse: {
      ok: true,
      answer: "runtime 路徑已補齊。",
      sources: [],
      limitations: [],
    },
  });

  assert.equal(pass.diagnostics.interpreted_as_continuation, true);
  assert.equal(pass.diagnostics.usage_issue_codes.includes("reroute_without_user_visible_context"), true);
  const patched = applyUsageLayerContinuityCopy({
    userResponse: {
      ok: true,
      answer: "runtime 路徑已補齊。",
      sources: [],
      limitations: [],
    },
    diagnostics: pass.diagnostics,
    observability: {
      recovery_action: "reroute_owner",
      agent_handoff: {
        from: "doc_agent",
        to: "runtime_agent",
      },
    },
  });
  assert.equal(Array.isArray(patched.sources), true);
  assert.match(patched.sources[0] || "", /改由 runtime_agent|這一步我改由/);
});

test("usage pass marks retry continuity when retry response keeps contextual copy", () => {
  const pass = evaluateUsageLayerIntelligencePass({
    requestText: "retry 一次",
    workingMemory: {
      task_id: "task-usage-retry-context",
      task_type: "document_lookup",
      task_phase: "retrying",
      task_status: "failed",
      next_best_action: "search_company_brain_docs",
      slot_state: [],
    },
    observability: {
      recovery_action: "retry_same_step",
      resumed_from_retry: true,
    },
    userResponse: {
      ok: true,
      answer: "我剛剛那一步再幫你確認一下，現在接著處理。",
      sources: [],
      limitations: [],
    },
  });

  assert.equal(pass.diagnostics.interpreted_as_continuation, true);
  assert.equal(pass.diagnostics.retry_context_applied, true);
  assert.equal(pass.diagnostics.usage_issue_codes.includes("retry_without_contextual_response"), false);
});

test("usage pass scores low when multiple usage issues coexist", () => {
  const pass = evaluateUsageLayerIntelligencePass({
    requestText: "再試一次",
    taskType: "document_lookup",
    workingMemory: {
      task_id: "task-usage-multi-issue",
      task_type: "document_lookup",
      task_phase: "retrying",
      task_status: "failed",
      current_owner_agent: "runtime_agent",
      previous_owner_agent: "doc_agent",
      slot_state: [
        {
          slot_key: "candidate_selection_required",
          status: "filled",
          ttl: "2030-01-01T00:00:00.000Z",
        },
      ],
    },
    observability: {
      recovery_action: "ask_user",
      recommended_action: "ask_user",
      current_owner_agent: "runtime_agent",
      previous_owner_agent: "doc_agent",
      resumed_from_retry: true,
    },
    userResponse: {
      ok: false,
      answer: "請再補一次文件編號。",
      sources: [],
      limitations: ["請補文件編號"],
    },
  });

  assert.equal(pass.diagnostics.usage_issue_codes.includes("redundant_slot_ask"), true);
  assert.equal(pass.diagnostics.usage_issue_codes.includes("unnecessary_owner_switch"), true);
  assert.equal(pass.diagnostics.response_continuity_score, "low");
});

test("malformed usage input fails closed", () => {
  const pass = evaluateUsageLayerIntelligencePass(null);
  assert.equal(pass.ok, false);
  assert.equal(pass.fail_closed, true);
  assert.equal(pass.diagnostics.interpreted_as_new_task, true);
  assert.equal(pass.diagnostics.response_continuity_score, "low");
});
