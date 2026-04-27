import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExecutionJournal,
  buildExecutionReflection,
  finalizeExecutiveTaskTurn,
} from "../src/executive-closed-loop.mjs";
import { listArchivedExecutiveReflections } from "../src/executive-improvement-workflow.mjs";
import {
  getExecutiveTask,
  startExecutiveTask,
} from "../src/executive-task-state.mjs";
import { setupExecutiveTaskStateTestHarness } from "./helpers/executive-task-state-harness.mjs";

setupExecutiveTaskStateTestHarness({
  includeImprovementWorkflowStores: true,
  includeExecutiveMemoryStores: true,
});

test("execution reflection marks completed planner steps as success", () => {
  const reflection = buildExecutionReflection({
    task: {
      success_criteria: ["有可讀結論", "有來源證據"],
      work_plan: [
        {
          agent_id: "research",
          task: "搜尋資料",
          selected_action: "search_company_brain_docs",
          status: "completed",
        },
        {
          agent_id: "generalist",
          task: "整合答案",
          selected_action: "answer_user",
          status: "completed",
        },
      ],
    },
    executionJournal: {
      classified_intent: "search",
      selected_action: "answer_user",
      dispatched_actions: [
        { action: "search_company_brain_docs", status: "completed" },
        { action: "answer_user", status: "completed" },
      ],
      raw_evidence: [{ type: "tool_output", summary: "sources_found" }],
      reply_text: "這是整理後的答案。",
      fallback_used: false,
    },
  });

  assert.equal(reflection.overall_status, "success");
  assert.deepEqual(
    reflection.step_reviews.map((item) => ({
      intent: item.intent,
      success: item.success,
      success_match: item.success_match,
      deviation: item.deviation,
      reason: item.reason,
    })),
    [
      {
        intent: "search_company_brain_docs",
        success: true,
        success_match: {
          matched: true,
          matched_criteria: ["有可讀結論", "有來源證據"],
          unmet_criteria: [],
        },
        deviation: "none",
        reason: "none",
      },
      {
        intent: "answer_user",
        success: true,
        success_match: {
          matched: true,
          matched_criteria: ["有可讀結論", "有來源證據"],
          unmet_criteria: [],
        },
        deviation: "none",
        reason: "none",
      },
    ],
  );
});

test("execution reflection captures partial success and fallback deviation", () => {
  const reflection = buildExecutionReflection({
    task: {
      success_criteria: ["先回答問題", "有依據", "有風險與下一步"],
      work_plan: [
        {
          agent_id: "product",
          task: "整理產品觀點",
          selected_action: "product_synthesis",
          status: "failed",
        },
        {
          agent_id: "generalist",
          task: "回覆使用者",
          selected_action: "answer_user",
          status: "completed",
        },
      ],
    },
    executionJournal: {
      classified_intent: "decision_support",
      selected_action: "answer_user",
      dispatched_actions: [
        { action: "answer_user", status: "completed" },
      ],
      raw_evidence: [
        { type: "summary_generated", summary: "reply_text_present" },
        { type: "tool_output", summary: "retrieved_sources:2" },
      ],
      structured_result: {
        risks: ["來源仍需補強"],
        next_actions: ["補上來源列表"],
      },
      reply_text: "先給你結論，風險是來源仍需補強，下一步先補上來源列表。",
      fallback_used: true,
    },
  });

  assert.equal(reflection.overall_status, "partial_success");
  assert.deepEqual(reflection.step_reviews[0], {
    intent: "product_synthesis",
    success: false,
    success_match: {
      matched: false,
      matched_criteria: [],
      unmet_criteria: ["先回答問題", "有依據", "有風險與下一步"],
    },
    deviation: "tool_failure",
    reason: "tool_failure",
  });
  assert.deepEqual(reflection.step_reviews[1], {
    intent: "answer_user",
    success: true,
    success_match: {
      matched: true,
      matched_criteria: ["先回答問題", "有依據", "有風險與下一步"],
      unmet_criteria: [],
    },
    deviation: "fallback_used",
    reason: "none",
  });
});

test("execution reflection prefers planner step metadata from execution journal and falls back missing fields", () => {
  const executionJournal = buildExecutionJournal({
    classifiedIntent: "search",
    selectedAction: "answer_user",
    plannerSteps: [
      {
        intent: "search_company_brain_docs",
        success_criteria: ["有來源證據"],
      },
      {
        selected_action: "answer_user",
      },
    ],
    dispatchedActions: [
      { action: "search_company_brain_docs", status: "completed" },
      { action: "answer_user", status: "completed" },
    ],
    structuredResult: {
      risks: ["仍有一個待確認點"],
      next_actions: ["補上最後確認項"],
    },
    reply: { text: "這是整理後的答案，風險是仍有一個待確認點，下一步補上最後確認項。" },
  });

  const reflection = buildExecutionReflection({
    task: {
      success_criteria: ["先回答問題", "有風險與下一步"],
    },
    executionJournal,
  });

  assert.equal(reflection.overall_status, "success");
  assert.deepEqual(reflection.step_reviews, [
    {
      intent: "search_company_brain_docs",
      success: true,
      success_match: {
        matched: true,
        matched_criteria: ["有來源證據"],
        unmet_criteria: [],
      },
      deviation: "none",
      reason: "none",
    },
    {
      intent: "answer_user",
      success: true,
      success_match: {
        matched: true,
        matched_criteria: ["先回答問題", "有風險與下一步"],
        unmet_criteria: [],
      },
      deviation: "none",
      reason: "none",
    },
  ]);
});

test("execution reflection classifies planning error when intent is observed but success criteria are unmet", () => {
  const reflection = buildExecutionReflection({
    task: {
      work_plan: [
        {
          agent_id: "generalist",
          task: "回答使用者",
          selected_action: "answer_user",
          status: "completed",
          success_criteria: ["有來源證據"],
        },
      ],
    },
    executionJournal: {
      selected_action: "answer_user",
      dispatched_actions: [
        { action: "answer_user", status: "completed" },
      ],
      raw_evidence: [{ type: "summary_generated", summary: "reply_text_present" }],
      reply_text: "這是結論，但沒有來源。",
    },
  });

  assert.deepEqual(reflection, {
    overall_status: "failed",
    step_reviews: [
      {
        intent: "answer_user",
        success: false,
        success_match: {
          matched: false,
          matched_criteria: [],
          unmet_criteria: ["有來源證據"],
        },
        deviation: "success_criteria_unmet",
        reason: "planning_error",
      },
    ],
  });
});

test("execution reflection classifies missing info when success criteria stay unmet behind open questions", () => {
  const reflection = buildExecutionReflection({
    task: {
      work_plan: [
        {
          agent_id: "generalist",
          task: "整理會議",
          selected_action: "summarize_meeting",
          status: "completed",
          success_criteria: ["有 owner"],
        },
      ],
    },
    executionJournal: {
      selected_action: "summarize_meeting",
      dispatched_actions: [
        { action: "summarize_meeting", status: "completed" },
      ],
      raw_evidence: [{ type: "structured_output", summary: "structured_result_present" }],
      structured_result: {
        summary: "已整理會議。",
        action_items: [
          {
            title: "確認預算",
            owner: "待確認",
          },
        ],
        open_questions: ["預算仍待確認"],
      },
      reply_text: "目前有一項待確認。",
    },
  });

  assert.deepEqual(reflection, {
    overall_status: "failed",
    step_reviews: [
      {
        intent: "summarize_meeting",
        success: false,
        success_match: {
          matched: false,
          matched_criteria: [],
          unmet_criteria: ["有 owner"],
        },
        deviation: "success_criteria_unmet",
        reason: "missing_info",
      },
    ],
  });
});

test("closed loop attaches lightweight improvement proposal to execution journal after reflection", async () => {
  const task = await startExecutiveTask({
    accountId: "acct-improvement-journal",
    sessionKey: "sess-improvement-journal",
    objective: "回覆使用者問題",
    primaryAgentId: "generalist",
    currentAgentId: "generalist",
    taskType: "search",
    lifecycleState: "awaiting_result",
  });

  const logs = [];
  await finalizeExecutiveTaskTurn({
    task,
    accountId: "acct-improvement-journal",
    sessionKey: "sess-improvement-journal",
    requestText: "請整理答案",
    reply: {
      text: "任務已啟動，這是整理後的答案。",
    },
    routing: {
      action: "answer_user",
      dispatched_actions: [
        { action: "answer_user", status: "completed" },
      ],
    },
    logger: {
      info(event, payload) {
        logs.push({ event, payload });
      },
    },
  });

  const updatedTask = await getExecutiveTask(task.id);
  assert.deepEqual(updatedTask?.execution_journal?.improvement_proposal, {
    type: "prompt_fix",
    summary: "Prompt constraints did not keep the response grounded and on-contract.",
    action_suggestion: "Tighten answer-order, completion-gate, and evidence-language instructions for this failure pattern.",
  });
  assert.deepEqual(updatedTask?.meta?.evolution_metrics?.current, {
    execution_reflection_summary: {
      overall_status: "success",
      total_steps: 1,
      deviated_steps: 0,
      deviation_rate: 0,
    },
    reflection_deviation_rate: 0,
    improvement_trigger_rate: 1,
    retry_success_rate: null,
    improvement_triggered: true,
    retry_attempted: false,
    retry_succeeded: false,
  });

  const archived = (await listArchivedExecutiveReflections({
    accountId: "acct-improvement-journal",
    sessionKey: "sess-improvement-journal",
    taskId: task.id,
    limit: 2,
  })).at(-1);
  assert.equal(Boolean(archived), true);
  assert.equal(archived.improvement_triggered, true);
  assert.equal(archived.retry_attempted, false);
  assert.equal(archived.retry_succeeded, false);
  assert.deepEqual(archived.execution_reflection_summary, {
    overall_status: "success",
    total_steps: 1,
    deviated_steps: 0,
    deviation_rate: 0,
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "executive_evolution_metrics");
  assert.deepEqual(logs[0].payload.metrics.current, updatedTask?.meta?.evolution_metrics?.current);
  assert.deepEqual(logs[0].payload.metrics.rolling, updatedTask?.meta?.evolution_metrics?.rolling);
});
