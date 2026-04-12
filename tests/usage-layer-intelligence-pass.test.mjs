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
  assert.match(patched.sources[0] || "", /改由 runtime_agent/);
});

test("malformed usage input fails closed", () => {
  const pass = evaluateUsageLayerIntelligencePass(null);
  assert.equal(pass.ok, false);
  assert.equal(pass.fail_closed, true);
  assert.equal(pass.diagnostics.interpreted_as_new_task, true);
  assert.equal(pass.diagnostics.response_continuity_score, "low");
});
