import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildPlannedUserInputEnvelope,
  compactPlannerConversationMemory,
  dispatchPlannerTool,
  executePlannedUserInput,
  getPlannerConversationMemory,
  looksLikeExecutiveExit,
  looksLikeExecutiveStart,
  planExecutiveTurn,
  planUserInputAction,
  resetPlannerRuntimeContext,
  runPlannerMultiStep,
  runPlannerPreset,
  runPlannerToolFlow,
  validateInput,
  validateOutput,
  validatePresetOutput,
  normalizeError,
} from "../src/executive-planner.mjs";
import {
  getLatestPlannerTaskLifecycleSnapshot,
  replacePlannerTaskLifecycleStoreForTests,
} from "../src/planner-task-lifecycle-v1.mjs";
import { plannerBdFlow } from "../src/planner-bd-flow.mjs";
import { plannerDeliveryFlow } from "../src/planner-delivery-flow.mjs";
import {
  getPlannerDocQueryContext,
  hydratePlannerDocQueryRuntimeContext,
  plannerDocQueryFlow,
  resetPlannerDocQueryRuntimeContext,
} from "../src/planner-doc-query-flow.mjs";
import { plannerOkrFlow } from "../src/planner-okr-flow.mjs";
import { plannerRuntimeInfoFlow } from "../src/planner-runtime-info-flow.mjs";
import { getPlannerFlowForAction, resolvePlannerFlowRoute } from "../src/planner-flow-runtime.mjs";
import { route } from "../src/router.js";
import { setupPlannerTaskLifecycleTestHarness } from "./helpers/planner-task-lifecycle-harness.mjs";

setupPlannerTaskLifecycleTestHarness();

test("looksLikeExecutiveStart recognizes slash and executive-team requests", () => {
  assert.equal(looksLikeExecutiveStart("/ceo 幫我整理決策"), true);
  assert.equal(looksLikeExecutiveStart("先請各個 agent 一起拆解這個任務"), true);
  assert.equal(looksLikeExecutiveStart("幫我看今天日程"), false);
});

test("looksLikeExecutiveExit recognizes explicit exit phrases", () => {
  assert.equal(looksLikeExecutiveExit("退出 executive 模式"), true);
  assert.equal(looksLikeExecutiveExit("結束這個任務"), true);
  assert.equal(looksLikeExecutiveExit("幫我看今天日程"), false);
});

test("planExecutiveTurn builds collaborative work items for multi-agent requests", async () => {
  resetPlannerRuntimeContext();
  const decision = await planExecutiveTurn({
    text: "先請各個 agent 一起看這批文檔，最後再統一收斂建議",
    activeTask: null,
    async requester() {
      throw new Error("planner_unavailable");
    },
  });

  assert.equal(decision.primary_agent_id, "generalist");
  assert.equal(decision.supporting_agent_ids.length > 0, true);
  assert.equal(Array.isArray(decision.work_items), true);
  assert.equal(decision.work_items.length >= 2, true);
});

test("planUserInputAction rejects wrapped non-JSON output", async () => {
  resetPlannerRuntimeContext();
  const result = await planUserInputAction({
    text: "幫我找 OKR 文件",
    async requester() {
      return '這是額外說明 {"action":"search_company_brain_docs","params":{"q":"OKR"}}';
    },
  });

  assert.deepEqual(result, { error: "planner_failed" });
});

test("planUserInputAction rejects action outside planner_contract", async () => {
  resetPlannerRuntimeContext();
  const result = await planUserInputAction({
    text: "直接回答我",
    async requester() {
      return JSON.stringify({
        action: "free_chat_answer",
        params: {},
      });
    },
  });

  assert.equal(result.error, "invalid_action");
  assert.equal(result.action, "free_chat_answer");
  assert.deepEqual(result.params, {});
});

test("planUserInputAction returns structured semantic_mismatch when action does not match user intent", async () => {
  resetPlannerRuntimeContext();
  const result = await planUserInputAction({
    text: "幫我總結最近對話",
    async requester() {
      return JSON.stringify({
        action: "search_company_brain_docs",
        params: {
          q: "最近對話",
        },
      });
    },
  });

  assert.equal(result.error, "semantic_mismatch");
  assert.equal(result.action, "search_company_brain_docs");
  assert.equal(result.reason, "conversation_summary_not_supported_by_planner_contract");
});

test("planUserInputAction rejects stale decision reuse across different inputs", async () => {
  resetPlannerRuntimeContext();

  const first = await planUserInputAction({
    text: "整理 OKR 文件",
    async requester() {
      return JSON.stringify({
        action: "search_company_brain_docs",
        params: {
          q: "OKR",
        },
      });
    },
  });
  assert.equal(first.action, "search_company_brain_docs");

  const second = await planUserInputAction({
    text: "整理 BD 文件",
    async requester() {
      return JSON.stringify({
        action: "search_company_brain_docs",
        params: {
          q: "OKR",
        },
      });
    },
  });

  assert.equal(second.error, "stale_decision_reused");
  assert.equal(second.reason, "decision_identical_to_previous_turn_without_explicit_same_task");
  assert.equal(second.previous_user_text, "整理 OKR 文件");
});

test("buildPlannedUserInputEnvelope exposes chosen_action and fallback_reason for structured failures", () => {
  const envelope = buildPlannedUserInputEnvelope({
    ok: false,
    error: "semantic_mismatch",
    action: "search_company_brain_docs",
    params: {
      q: "最近對話",
    },
    reason: "conversation_summary_not_supported_by_planner_contract",
    trace_id: "trace_semantic",
  });

  assert.equal(envelope.trace?.chosen_action, "search_company_brain_docs");
  assert.equal(envelope.trace?.fallback_reason, "conversation_summary_not_supported_by_planner_contract");
});

test("different planner inputs do not collapse into the same fixed envelope", async () => {
  resetPlannerRuntimeContext();

  const documentResult = buildPlannedUserInputEnvelope(await executePlannedUserInput({
    text: "整理 OKR 文件",
    async requester() {
      return JSON.stringify({
        action: "search_company_brain_docs",
        params: {
          q: "OKR",
        },
      });
    },
    async toolFlowRunner() {
      return {
        selected_action: "search_company_brain_docs",
        execution_result: {
          ok: true,
          action: "search_company_brain_docs",
          trace_id: "trace_doc",
          data: {
            success: true,
            data: {
              q: "OKR",
              total: 0,
              items: [],
            },
            error: null,
          },
        },
        trace_id: "trace_doc",
      };
    },
  }));

  const conversationResult = buildPlannedUserInputEnvelope(await executePlannedUserInput({
    text: "總結最近對話",
    async requester() {
      return JSON.stringify({
        action: "search_company_brain_docs",
        params: {
          q: "OKR",
        },
      });
    },
  }));

  assert.notDeepEqual(documentResult, conversationResult);
  assert.equal(documentResult.ok, true);
  assert.equal(conversationResult.ok, false);
});

test("planUserInputAction accepts strict multi-step output", async () => {
  resetPlannerRuntimeContext();
  const result = await planUserInputAction({
    text: "先建立文件再列出文件",
    async requester() {
      return JSON.stringify({
        steps: [
          {
            action: "create_doc",
            params: {
              title: "demo",
            },
          },
          {
            action: "list_company_brain_docs",
            params: {
              limit: 3,
            },
          },
        ],
      });
    },
  });

  assert.deepEqual(result, {
    steps: [
      {
        action: "create_doc",
        params: {
          title: "demo",
        },
      },
      {
        action: "list_company_brain_docs",
        params: {
          limit: 3,
        },
      },
    ],
  });
});

test("planExecutiveTurn accepts injected planner requester", async () => {
  resetPlannerRuntimeContext();
  const decision = await planExecutiveTurn({
    text: "把這輪改交給 /cmo",
    activeTask: null,
    async requester() {
      return JSON.stringify({
        action: "start",
        objective: "改由 /cmo 處理",
        primary_agent_id: "cmo",
        next_agent_id: "cmo",
        supporting_agent_ids: ["consult"],
        reason: "測試注入 planner",
        pending_questions: [],
        work_items: [
          { agent_id: "cmo", task: "主責整理", role: "primary" },
          { agent_id: "consult", task: "補充比較", role: "supporting" },
        ],
      });
    },
  });

  assert.equal(decision.primary_agent_id, "cmo");
  assert.equal(decision.next_agent_id, "cmo");
  assert.equal(decision.supporting_agent_ids.includes("consult"), true);
  assert.equal(decision.work_items.length, 2);
});

test("planExecutiveTurn auto-generates latest summary when conversation grows long", async () => {
  resetPlannerRuntimeContext();

  for (let index = 0; index < 6; index += 1) {
    await planExecutiveTurn({
      text: `第${index}輪 planner 對話 ${index === 0 ? "ancient-marker-001" : `recent-marker-00${index}`}`,
      activeTask: null,
      async requester() {
        return JSON.stringify({
          action: "continue",
          objective: "延續任務",
          primary_agent_id: "generalist",
          next_agent_id: "generalist",
          supporting_agent_ids: [],
          reason: "測試長對話 summary",
          pending_questions: [],
          work_items: [],
        });
      },
    });
  }

  const memory = getPlannerConversationMemory();
  assert.equal(Boolean(memory.latest_summary), true);
  assert.equal(Array.isArray(memory.latest_summary?.current_flows), true);
  assert.equal(memory.latest_summary?.current_flows.some((flow) => flow.id === "runtime_info"), true);
  assert.equal("active_doc" in memory.latest_summary, true);
  assert.equal("active_theme" in memory.latest_summary, true);
});

test("planExecutiveTurn builds prompt from latest summary plus recent messages instead of full history replay", async () => {
  resetPlannerRuntimeContext();

  for (let index = 0; index < 6; index += 1) {
    await planExecutiveTurn({
      text: `對話輪次 ${index} ${index === 0 ? "ancient-marker-001" : `recent-marker-00${index}`}`,
      activeTask: null,
      async requester() {
        return JSON.stringify({
          action: "continue",
          objective: "延續任務",
          primary_agent_id: "generalist",
          next_agent_id: "generalist",
          supporting_agent_ids: [],
          reason: "測試 summary prompt",
          pending_questions: [],
          work_items: [],
        });
      },
    });
  }

  let capturedPrompt = "";
  await planExecutiveTurn({
    text: "請繼續這個任務",
    activeTask: null,
    async requester({ prompt }) {
      capturedPrompt = String(prompt || "");
      return JSON.stringify({
        action: "continue",
        objective: "延續任務",
        primary_agent_id: "generalist",
        next_agent_id: "generalist",
        supporting_agent_ids: [],
        reason: "測試 prompt context",
        pending_questions: [],
        work_items: [],
      });
    },
  });

  assert.equal(capturedPrompt.includes("latest_summary"), true);
  assert.equal(capturedPrompt.includes("ancient-marker-001"), false);
  assert.equal(capturedPrompt.includes("recent-marker-005"), true);
});

test("planExecutiveTurn trims oversized active-task context down to recent steps", async () => {
  resetPlannerRuntimeContext();
  replacePlannerTaskLifecycleStoreForTests({
    tasks: {
      task_big_context_focus: {
        id: "task_big_context_focus",
        scope_key: "scope_big_context",
        title: "先處理關鍵客訴",
        theme: "bd",
        owner: "Alice",
        deadline: "2026-03-30",
        task_state: "in_progress",
        progress_status: "half_done",
        progress_summary: "已完成一半",
        source_doc_id: "doc_big_context",
        source_title: "Customer Escalation Runbook",
        source_summary: `priority-doc-summary-keep ${"客訴升級處理摘要 ".repeat(60)}`,
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-21T00:00:00.000Z",
      },
    },
    scopes: {
      scope_big_context: {
        scope_key: "scope_big_context",
        theme: "bd",
        selected_action: "search_and_detail_doc",
        user_intent: "整理客訴應對文件",
        trace_id: "trace_big_context",
        source_kind: "search_and_detail",
        source_doc_id: "doc_big_context",
        source_title: "Customer Escalation Runbook",
        last_active_task_id: "task_big_context_focus",
        current_task_ids: ["task_big_context_focus"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-21T00:00:00.000Z",
      },
    },
    latest_scope_key: "scope_big_context",
  });

  const activeTask = {
    id: "exec_task_big_context",
    objective: "持續處理高優先客訴升級流程",
    primary_agent_id: "generalist",
    current_agent_id: "generalist",
    work_plan: Array.from({ length: 8 }, (_, index) => ({
      agent_id: "generalist",
      task: `${index === 0 ? "ancient-plan-001" : `recent-plan-00${index}`} ${"處理步驟 ".repeat(30)}`,
      role: "primary",
      status: index < 5 ? "done" : "pending",
    })),
    turns: Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "planner",
      text: `${index === 0 ? "ancient-turn-001" : `recent-turn-00${index}`} ${"長上下文內容 ".repeat(50)}`,
    })),
    handoffs: [
      { from_agent_id: "generalist", to_agent_id: "consult", reason: `ancient-handoff-001 ${"handoff ".repeat(20)}` },
      { from_agent_id: "consult", to_agent_id: "generalist", reason: `recent-handoff-002 ${"return ".repeat(20)}` },
    ],
    agent_outputs: [
      { agent_id: "consult", summary: `ancient-output-001 ${"summary ".repeat(25)}` },
      { agent_id: "generalist", summary: `recent-output-002 ${"summary ".repeat(25)}` },
    ],
    pending_questions: Array.from({ length: 5 }, (_, index) => `pending-question-00${index} ${"待確認 ".repeat(20)}`),
  };

  let capturedPrompt = "";
  await planExecutiveTurn({
    text: "這個任務下一步是什麼？",
    activeTask,
    async requester({ prompt }) {
      capturedPrompt = String(prompt || "");
      return JSON.stringify({
        action: "continue",
        objective: "延續客訴任務",
        primary_agent_id: "generalist",
        next_agent_id: "generalist",
        supporting_agent_ids: [],
        reason: "測試 context window clipping",
        pending_questions: [],
        work_items: [],
      });
    },
  });

  assert.ok(capturedPrompt.length < 5200);
  assert.equal(capturedPrompt.includes("ancient-turn-001"), false);
  assert.equal(capturedPrompt.includes("ancient-plan-001"), false);
  assert.equal(capturedPrompt.includes("recent-turn-009"), true);
  assert.equal(capturedPrompt.includes("recent-output-002"), true);
  assert.match(capturedPrompt, /priority-doc-summary-keep/);
});

test("planExecutiveTurn keeps focused task and high-weight doc summary under long-context pressure", async () => {
  resetPlannerRuntimeContext();

  for (let index = 0; index < 6; index += 1) {
    await planExecutiveTurn({
      text: `${index === 0 ? "ancient-dialogue-001" : `recent-dialogue-00${index}`} ${"舊對話 ".repeat(70)}`,
      activeTask: null,
      async requester() {
        return JSON.stringify({
          action: "continue",
          objective: "延續任務",
          primary_agent_id: "generalist",
          next_agent_id: "generalist",
          supporting_agent_ids: [],
          reason: "測試長對話壓力",
          pending_questions: [],
          work_items: [],
        });
      },
    });
  }

  replacePlannerTaskLifecycleStoreForTests({
    tasks: {
      task_doc_pressure: {
        id: "task_doc_pressure",
        scope_key: "scope_doc_pressure",
        title: "先同步客訴處理窗口",
        theme: "bd",
        owner: "Alice",
        deadline: "2026-03-31",
        task_state: "planned",
        source_doc_id: "doc_doc_pressure",
        source_title: "Customer Escalation Runbook",
        source_summary: `priority-doc-summary-keep ${"文件重點 ".repeat(80)}`,
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-21T00:00:00.000Z",
      },
    },
    scopes: {
      scope_doc_pressure: {
        scope_key: "scope_doc_pressure",
        theme: "bd",
        selected_action: "search_and_detail_doc",
        user_intent: "整理客訴升級文件",
        trace_id: "trace_doc_pressure",
        source_kind: "search_and_detail",
        source_doc_id: "doc_doc_pressure",
        source_title: "Customer Escalation Runbook",
        last_active_task_id: "task_doc_pressure",
        current_task_ids: ["task_doc_pressure"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-21T00:00:00.000Z",
      },
    },
    latest_scope_key: "scope_doc_pressure",
  });
  hydratePlannerDocQueryRuntimeContext({
    activeDoc: { doc_id: "doc_doc_pressure", title: "Customer Escalation Runbook" },
    activeTheme: "bd",
  });

  let capturedPrompt = "";
  await planExecutiveTurn({
    text: "這份文件接下來誰要先推進？",
    activeTask: null,
    async requester({ prompt }) {
      capturedPrompt = String(prompt || "");
      return JSON.stringify({
        action: "continue",
        objective: "延續客訴處理任務",
        primary_agent_id: "generalist",
        next_agent_id: "generalist",
        supporting_agent_ids: [],
        reason: "測試高權重摘要保留",
        pending_questions: [],
        work_items: [],
      });
    },
  });

  assert.equal(capturedPrompt.includes("ancient-dialogue-001"), false);
  assert.match(capturedPrompt, /focused_task/);
  assert.match(capturedPrompt, /先同步客訴處理窗口/);
  assert.match(capturedPrompt, /high_weight_doc_summaries/);
  assert.match(capturedPrompt, /Customer Escalation Runbook/);
  assert.match(capturedPrompt, /priority-doc-summary-keep/);
});

test("planExecutiveTurn injects planner task context with unfinished, blocked, and in-progress hints", async () => {
  resetPlannerRuntimeContext();
  replacePlannerTaskLifecycleStoreForTests({
    tasks: {
      task_planned_1: {
        id: "task_planned_1",
        scope_key: "scope_prompt_task_context",
        title: "整理報價回覆",
        theme: "bd",
        owner: "Alice",
        deadline: "2026-03-28",
        task_state: "planned",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
      task_blocked_1: {
        id: "task_blocked_1",
        scope_key: "scope_prompt_task_context",
        title: "等法務確認條款",
        theme: "bd",
        owner: "Bob",
        deadline: "2026-03-29",
        task_state: "blocked",
        progress_status: "blocked",
        progress_summary: "卡點：等法務確認",
        note: "等法務確認",
        risks: ["合約條款未定"],
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
      task_in_progress_1: {
        id: "task_in_progress_1",
        scope_key: "scope_prompt_task_context",
        title: "更新專案排程",
        theme: "bd",
        owner: "CS Team",
        deadline: "2026-03-30",
        task_state: "in_progress",
        progress_status: "half_done",
        progress_summary: "完成一半",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    scopes: {
      scope_prompt_task_context: {
        scope_key: "scope_prompt_task_context",
        theme: "bd",
        selected_action: "search_and_detail_doc",
        user_intent: "整理 BD 文件",
        trace_id: "trace_prompt_task_context",
        source_kind: "search_and_detail",
        source_doc_id: "doc_prompt_task_context",
        source_title: "BD Execution Board",
        current_task_ids: ["task_planned_1", "task_blocked_1", "task_in_progress_1"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    latest_scope_key: "scope_prompt_task_context",
  });

  let capturedPrompt = "";
  await planExecutiveTurn({
    text: "接下來要怎麼推進這個案子？",
    activeTask: null,
    async requester({ prompt }) {
      capturedPrompt = String(prompt || "");
      return JSON.stringify({
        action: "continue",
        objective: "延續 BD 推進",
        primary_agent_id: "generalist",
        next_agent_id: "generalist",
        supporting_agent_ids: [],
        reason: "測試 task context prompt",
        pending_questions: [],
        work_items: [],
      });
    },
  });

  assert.equal(capturedPrompt.includes("planner_task_context"), true);
  assert.match(capturedPrompt, /優先引用未完成 task/);
  assert.match(capturedPrompt, /需主動提醒 blocked 風險/);
  assert.match(capturedPrompt, /可提供進度摘要/);
  assert.match(capturedPrompt, /主動下一步/);
  assert.match(capturedPrompt, /等法務確認條款/);
  assert.match(capturedPrompt, /更新專案排程/);
});

test("planExecutiveTurn auto-fills task-driving work items for blocked tasks", async () => {
  resetPlannerRuntimeContext();
  replacePlannerTaskLifecycleStoreForTests({
    tasks: {
      task_blocked_2: {
        id: "task_blocked_2",
        scope_key: "scope_task_driving_1",
        title: "等法務確認條款",
        theme: "bd",
        owner: null,
        deadline: null,
        task_state: "blocked",
        progress_status: "blocked",
        progress_summary: "卡點：等法務確認",
        note: "等法務確認",
        risks: ["合約條款未定"],
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    scopes: {
      scope_task_driving_1: {
        scope_key: "scope_task_driving_1",
        theme: "bd",
        selected_action: "search_and_detail_doc",
        user_intent: "整理 BD 文件",
        trace_id: "trace_task_driving_1",
        source_kind: "search_and_detail",
        source_doc_id: "doc_task_driving_1",
        source_title: "BD Execution Board",
        current_task_ids: ["task_blocked_2"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    latest_scope_key: "scope_task_driving_1",
  });

  const decision = await planExecutiveTurn({
    text: "接下來怎麼推進？",
    activeTask: null,
    async requester() {
      return JSON.stringify({
        action: "continue",
        objective: "延續 BD 推進",
        primary_agent_id: "generalist",
        next_agent_id: "generalist",
        supporting_agent_ids: [],
        reason: "測試 task driving",
        pending_questions: [],
        work_items: [],
      });
    },
  });

  assert.deepEqual(decision.work_items, [
    {
      agent_id: "generalist",
      task: "優先解除阻塞：「等法務確認條款」先處理 等法務確認",
      role: "primary",
      status: "pending",
    },
  ]);
  assert.deepEqual(decision.pending_questions, [
    "誰可以主責解除「等法務確認條款」的阻塞？",
  ]);
});

test("planExecutiveTurn prefers the current focused task for generic current-task follow-up", async () => {
  resetPlannerRuntimeContext();
  replacePlannerTaskLifecycleStoreForTests({
    tasks: {
      task_current_focus: {
        id: "task_current_focus",
        scope_key: "scope_current_focus",
        title: "先寄報價單",
        theme: "bd",
        owner: "Alice",
        deadline: "2026-03-28",
        task_state: "planned",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
      task_current_blocked: {
        id: "task_current_blocked",
        scope_key: "scope_current_focus",
        title: "等法務確認條款",
        theme: "bd",
        owner: "Bob",
        deadline: "2026-03-29",
        task_state: "blocked",
        progress_status: "blocked",
        progress_summary: "卡點：等法務確認",
        note: "等法務確認",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    scopes: {
      scope_current_focus: {
        scope_key: "scope_current_focus",
        theme: "bd",
        selected_action: "search_and_detail_doc",
        user_intent: "整理 BD 文件",
        trace_id: "trace_current_focus",
        source_kind: "search_and_detail",
        source_doc_id: "doc_current_focus",
        source_title: "BD Execution Board",
        last_active_task_id: "task_current_focus",
        current_task_ids: ["task_current_focus", "task_current_blocked"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    latest_scope_key: "scope_current_focus",
  });

  let capturedPrompt = "";
  const decision = await planExecutiveTurn({
    text: "這個現在怎麼辦？",
    activeTask: null,
    async requester({ prompt }) {
      capturedPrompt = String(prompt || "");
      return JSON.stringify({
        action: "continue",
        objective: "延續 BD 任務",
        primary_agent_id: "generalist",
        next_agent_id: "generalist",
        supporting_agent_ids: [],
        reason: "",
        pending_questions: [],
        work_items: [],
      });
    },
  });

  assert.match(capturedPrompt, /當前優先 task：先寄報價單/);
  assert.match(capturedPrompt, /綁定來源=沿用當前 task/);
  assert.deepEqual(decision.work_items, [
    {
      agent_id: "generalist",
      task: "先由 Alice 推進「先寄報價單」，目標 2026-03-28",
      role: "primary",
      status: "pending",
    },
  ]);
  assert.match(decision.reason, /先寄報價單/);
});

test("planExecutiveTurn prefers the mentioned document's task scope over the latest snapshot", async () => {
  resetPlannerRuntimeContext();
  replacePlannerTaskLifecycleStoreForTests({
    tasks: {
      task_bd_latest: {
        id: "task_bd_latest",
        scope_key: "scope_bd_latest",
        title: "等法務確認條款",
        theme: "bd",
        owner: "Bob",
        deadline: "2026-03-29",
        task_state: "blocked",
        progress_status: "blocked",
        progress_summary: "卡點：等法務確認",
        note: "等法務確認",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
      task_okr_doc: {
        id: "task_okr_doc",
        scope_key: "scope_okr_doc",
        title: "更新 KR 週進度",
        theme: "okr",
        owner: "Alice",
        deadline: "2026-03-28",
        task_state: "planned",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    scopes: {
      scope_bd_latest: {
        scope_key: "scope_bd_latest",
        theme: "bd",
        selected_action: "search_and_detail_doc",
        user_intent: "整理 BD 文件",
        trace_id: "trace_bd_latest",
        source_kind: "search_and_detail",
        source_doc_id: "doc_bd_latest",
        source_title: "BD Execution Board",
        last_active_task_id: "task_bd_latest",
        current_task_ids: ["task_bd_latest"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-21T00:00:00.000Z",
      },
      scope_okr_doc: {
        scope_key: "scope_okr_doc",
        theme: "okr",
        selected_action: "search_and_detail_doc",
        user_intent: "整理 OKR 文件",
        trace_id: "trace_okr_doc",
        source_kind: "search_and_detail",
        source_doc_id: "doc_okr_doc",
        source_title: "OKR Weekly Review",
        last_active_task_id: "task_okr_doc",
        current_task_ids: ["task_okr_doc"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    latest_scope_key: "scope_bd_latest",
  });

  let capturedPrompt = "";
  const decision = await planExecutiveTurn({
    text: "OKR Weekly Review 這份文件接下來怎麼辦？",
    activeTask: null,
    async requester({ prompt }) {
      capturedPrompt = String(prompt || "");
      return JSON.stringify({
        action: "continue",
        objective: "延續 OKR 文件任務",
        primary_agent_id: "generalist",
        next_agent_id: "generalist",
        supporting_agent_ids: [],
        reason: "",
        pending_questions: [],
        work_items: [],
      });
    },
  });

  assert.match(capturedPrompt, /scope_title: OKR Weekly Review/);
  assert.match(capturedPrompt, /scope_binding: 命中文件名稱/);
  assert.match(capturedPrompt, /當前優先 task：更新 KR 週進度/);
  assert.deepEqual(decision.work_items, [
    {
      agent_id: "generalist",
      task: "先由 Alice 推進「更新 KR 週進度」，目標 2026-03-28",
      role: "primary",
      status: "pending",
    },
  ]);
});

test("planExecutiveTurn keeps task driving on active_doc and active_theme context", async () => {
  resetPlannerRuntimeContext();
  replacePlannerTaskLifecycleStoreForTests({
    tasks: {
      task_latest_blocked: {
        id: "task_latest_blocked",
        scope_key: "scope_latest_blocked",
        title: "等法務確認條款",
        theme: "bd",
        owner: "Bob",
        deadline: "2026-03-29",
        task_state: "blocked",
        progress_status: "blocked",
        progress_summary: "卡點：等法務確認",
        note: "等法務確認",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
      task_doc_context: {
        id: "task_doc_context",
        scope_key: "scope_doc_context",
        title: "整理 OKR 本週更新",
        theme: "okr",
        owner: "Alice",
        deadline: "2026-03-28",
        task_state: "planned",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    scopes: {
      scope_latest_blocked: {
        scope_key: "scope_latest_blocked",
        theme: "bd",
        selected_action: "search_and_detail_doc",
        user_intent: "整理 BD 文件",
        trace_id: "trace_latest_blocked",
        source_kind: "search_and_detail",
        source_doc_id: "doc_latest_blocked",
        source_title: "BD Execution Board",
        last_active_task_id: "task_latest_blocked",
        current_task_ids: ["task_latest_blocked"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-21T00:00:00.000Z",
      },
      scope_doc_context: {
        scope_key: "scope_doc_context",
        theme: "okr",
        selected_action: "search_and_detail_doc",
        user_intent: "整理 OKR 文件",
        trace_id: "trace_doc_context",
        source_kind: "search_and_detail",
        source_doc_id: "doc_focus_okr",
        source_title: "OKR Weekly Review",
        last_active_task_id: "task_doc_context",
        current_task_ids: ["task_doc_context"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    latest_scope_key: "scope_latest_blocked",
  });
  hydratePlannerDocQueryRuntimeContext({
    activeDoc: { doc_id: "doc_focus_okr", title: "OKR Weekly Review" },
    activeTheme: "okr",
  });

  const decision = await planExecutiveTurn({
    text: "接下來怎麼推進這份文件？",
    activeTask: null,
    async requester() {
      return JSON.stringify({
        action: "continue",
        objective: "延續 OKR 文件任務",
        primary_agent_id: "generalist",
        next_agent_id: "generalist",
        supporting_agent_ids: [],
        reason: "",
        pending_questions: [],
        work_items: [],
      });
    },
  });

  assert.deepEqual(decision.work_items, [
    {
      agent_id: "generalist",
      task: "先由 Alice 推進「整理 OKR 本週更新」，目標 2026-03-28",
      role: "primary",
      status: "pending",
    },
  ]);
});

test("manual compact entry rebuilds planner latest summary without changing public planner result shape", async () => {
  resetPlannerRuntimeContext();
  await planExecutiveTurn({
    text: "先記一輪對話",
    activeTask: null,
    async requester() {
      return JSON.stringify({
        action: "continue",
        objective: "延續任務",
        primary_agent_id: "generalist",
        next_agent_id: "generalist",
        supporting_agent_ids: [],
        reason: "測試 manual compact",
        pending_questions: [],
        work_items: [],
      });
    },
  });

  const summary = compactPlannerConversationMemory();
  assert.equal(Boolean(summary?.system_architecture_status), true);
  assert.equal(Array.isArray(summary?.completed_features), true);
});

test("planner conversation memory persists latest summary across restart", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "planner-memory-"));
  const memoryPath = join(tempDir, "planner-conversation-memory.json");

  try {
    const commonEnv = {
      ...process.env,
      PLANNER_CONVERSATION_MEMORY_PATH: memoryPath,
    };

    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const memory = await import(${JSON.stringify("file:///Users/seanhan/Documents/Playground/src/planner-conversation-memory.mjs")});
        memory.resetPlannerConversationMemory();
        memory.recordPlannerConversationMessages([
          { role: "user", content: "請整理 OKR 進度" },
          { role: "planner", content: "planner action search_and_detail_doc succeeded" },
        ]);
        memory.compactPlannerConversationMemory({
          flows: [
            { id: "okr", priority: 80, context: {} },
            {
              id: "doc_query",
              priority: 10,
              context: {
                activeDoc: { doc_id: "okr_1", title: "OKR Weekly Review" },
                activeCandidates: [],
                activeTheme: "okr",
              },
            },
          ],
          latestSelectedAction: "search_and_detail_doc",
          reason: "test_persist",
        });
        console.log(JSON.stringify(memory.getPlannerConversationMemory()));
      `,
    ], {
      env: commonEnv,
      stdio: "pipe",
      encoding: "utf8",
    });

    const reloaded = execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
        const memory = await import(${JSON.stringify("file:///Users/seanhan/Documents/Playground/src/planner-conversation-memory.mjs")});
        console.log(JSON.stringify(memory.getPlannerConversationMemory()));
      `,
    ], {
      env: commonEnv,
      stdio: "pipe",
      encoding: "utf8",
    });

    const restored = JSON.parse(String(reloaded).trim());
    assert.equal(Boolean(restored.latest_summary), true);
    assert.equal(Array.isArray(restored.recent_messages), true);
    assert.equal(restored.recent_messages.length > 0, true);
    assert.equal(Boolean(restored.last_compacted_at), true);
    assert.equal(restored.latest_summary?.current_flows.some((flow) => flow.id === "okr"), true);
    assert.equal(restored.latest_summary?.active_theme, "okr");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runPlannerToolFlow selects and dispatches matching planner tool", async () => {
  const calls = [];
  const result = await runPlannerToolFlow({
    userIntent: "create doc",
    payload: { title: "test" },
    logger: console,
    async dispatcher({ action, payload }) {
      calls.push({ action, payload });
      return {
        ok: true,
        action,
        data: { echoed_title: payload.title },
        trace_id: "trace_test_dispatch",
      };
    },
  });

  assert.equal(result.selected_action, "create_doc");
  assert.equal(result.execution_result?.ok, true);
  assert.equal(result.trace_id, "trace_test_dispatch");
  assert.deepEqual(calls, [{ action: "create_doc", payload: { title: "test" } }]);
});

test("dispatchPlannerTool builds dynamic detail path for company brain doc detail", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          action: "company_brain_doc_detail",
          data: {
            doc_id: "doc_123",
          },
          trace_id: "trace_detail",
        });
      },
    };
  };

  try {
    const result = await dispatchPlannerTool({
      action: "get_company_brain_doc_detail",
      payload: { doc_id: "doc_123" },
      logger: console,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(result.ok, true);
    assert.equal(result.trace_id, "trace_detail");
    assert.deepEqual(calls, ["http://localhost:3333/agent/company-brain/docs/doc_123"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchPlannerTool emits minimal runtime trace events", async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  const logger = {
    debug(_message, event) {
      events.push(event);
    },
    info() {},
    warn() {},
  };
  globalThis.fetch = async () => ({
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        action: "get_runtime_info",
        trace_id: "trace_runtime_event",
        data: {
          db_path: "/tmp/db.sqlite",
          node_pid: 123,
          cwd: "/tmp",
          service_start_time: "2026-03-19T00:00:00.000Z",
        },
      });
    },
  });

  try {
    const result = await dispatchPlannerTool({
      action: "get_runtime_info",
      payload: {},
      logger,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(result.ok, true);
    assert.equal(events.some((event) => event?.event_type === "action_dispatch"), true);
    assert.equal(events.some((event) => event?.event_type === "action_result"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchPlannerTool logs successful tool execution with request_id", async () => {
  const originalFetch = globalThis.fetch;
  const toolLogs = [];
  const seenHeaders = [];
  const logger = {
    info(message, event) {
      if (message === "lobster_tool_execution") {
        toolLogs.push(event);
      }
    },
    warn() {},
    error() {},
    debug() {},
  };

  globalThis.fetch = async (_url, init = {}) => {
    seenHeaders.push(init.headers);
    return {
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          action: "get_runtime_info",
          trace_id: "trace_runtime_success",
          data: {
            db_path: "/tmp/db.sqlite",
            node_pid: 456,
            cwd: "/tmp",
            service_start_time: "2026-03-19T00:00:00.000Z",
          },
        });
      },
    };
  };

  try {
    const result = await dispatchPlannerTool({
      action: "get_runtime_info",
      payload: {},
      logger,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(result.ok, true);
    assert.equal(toolLogs.length, 1);
    assert.equal(toolLogs[0].action, "get_runtime_info");
    assert.match(toolLogs[0].request_id, /^planner_tool_/);
    assert.deepEqual(toolLogs[0].params, {});
    assert.deepEqual(toolLogs[0].result, {
      success: true,
      data: {
        db_path: "/tmp/db.sqlite",
        node_pid: 456,
        cwd: "/tmp",
        service_start_time: "2026-03-19T00:00:00.000Z",
        retry_count: 0,
      },
      error: null,
    });
    assert.equal(toolLogs[0].trace_id, "trace_runtime_success");
    assert.equal(seenHeaders[0]["X-Request-Id"], toolLogs[0].request_id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchPlannerTool logs failed tool execution with request_id", async () => {
  const originalFetch = globalThis.fetch;
  const toolLogs = [];
  const logger = {
    info() {},
    warn() {},
    error(message, event) {
      if (message === "lobster_tool_execution") {
        toolLogs.push(event);
      }
    },
    debug() {},
  };

  globalThis.fetch = async () => ({
    status: 500,
    async text() {
      return JSON.stringify({
        ok: false,
        action: "get_runtime_info",
        error: "tool_error",
        trace_id: "trace_runtime_fail",
        data: {
          message: "upstream_failed",
        },
      });
    },
  });

  try {
    const result = await dispatchPlannerTool({
      action: "get_runtime_info",
      payload: {},
      logger,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(result.ok, false);
    assert.equal(toolLogs.length, 1);
    assert.equal(toolLogs[0].action, "get_runtime_info");
    assert.match(toolLogs[0].request_id, /^planner_tool_/);
    assert.deepEqual(toolLogs[0].result, {
      success: false,
      data: {
        message: "upstream_failed",
        stop_reason: "tool_error",
        stopped: true,
        retry_count: 1,
      },
      error: "tool_error",
    });
    assert.equal(toolLogs[0].trace_id, "trace_runtime_fail");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runPlannerPreset emits minimal runtime preset trace events", async () => {
  const events = [];
  const logger = {
    debug(_message, event) {
      events.push(event);
    },
    info() {},
    warn() {},
  };

  const result = await runPlannerPreset({
    preset: "runtime_and_list_docs",
    input: { limit: 3 },
    logger,
    async multiStepRunner({ steps }) {
      const action = steps[0]?.action;
      return {
        steps: steps.map((step) => ({ action: step.action })),
        results: [
          action === "get_runtime_info"
            ? { ok: true, action: "get_runtime_info", trace_id: "trace_runtime" }
            : { ok: true, action: "list_company_brain_docs", trace_id: "trace_list" },
        ],
        trace_id: action === "get_runtime_info" ? "trace_runtime" : "trace_list",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(events.some((event) => event?.event_type === "preset_start"), true);
  assert.equal(events.some((event) => event?.event_type === "preset_result"), true);
});

test("validateInput checks required fields and simple types from planner contract", () => {
  const missingTitle = validateInput("create_doc", { folder_token: "folder_123" });
  const invalidDocId = validateInput("get_company_brain_doc_detail", { doc_id: 123 });

  assert.equal(missingTitle.ok, false);
  assert.equal(missingTitle.violations[0].type, "required");
  assert.equal(invalidDocId.ok, false);
  assert.equal(invalidDocId.violations[0].type, "type");
});

test("validateOutput soft-fails when successful result violates contract", () => {
  const outputValidation = validateOutput("get_runtime_info", {
    ok: true,
    action: "get_runtime_info",
    trace_id: "trace_runtime",
    data: {
      db_path: "/tmp/db.sqlite",
      node_pid: 123,
      cwd: "/tmp",
    },
  });

  assert.equal(outputValidation.ok, false);
  assert.equal(outputValidation.violations[0].type, "required");
});

test("validatePresetOutput catches missing preset fields on success result", () => {
  const outputValidation = validatePresetOutput("create_and_list_doc", {
    ok: true,
    preset: "create_and_list_doc",
    steps: [{ action: "create_doc" }],
    results: [{ ok: true, action: "create_doc", trace_id: "trace_create" }],
    trace_id: "trace_create",
    stopped: false,
  });

  assert.equal(outputValidation.ok, false);
  assert.equal(outputValidation.violations[0].type, "required");
  assert.equal(outputValidation.violations[0].path, "result.stopped_at_step");
  assert.equal(outputValidation.violations[0].code, "missing_required");
});

test("dispatchPlannerTool heals missing required input and can return success", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init = {}) => {
    capturedBody = JSON.parse(String(init.body || "{}"));
    return {
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          action: "create_doc",
          trace_id: "trace_healed_required",
          data: {
            account_id: "acc",
            auth_mode: "user_access_token",
            document_id: "doc_1",
            revision_id: 1,
            title: "",
            folder_token: "folder_123",
            url: "https://example.com/doc_1",
            fallback_root: false,
            permission_grant_failed: false,
            permission_grant_skipped: true,
            permission_grant_error: null,
            write_result: null,
          },
        });
      },
    };
  };

  try {
    const result = await dispatchPlannerTool({
      action: "create_doc",
      payload: { folder_token: "folder_123" },
      logger: console,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(capturedBody.title, "");
    assert.equal(result.ok, true);
    assert.equal(result.data.healed, true);
    assert.equal(result.data.retry_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchPlannerTool heals type mismatch input and can return success", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          action: "company_brain_doc_detail",
          trace_id: "trace_healed_type",
          account_id: "acc",
          auth_mode: "user_access_token",
          item: {
            doc_id: "123",
            title: "demo",
            source: "api",
            created_at: "2026-03-19T00:00:00.000Z",
            creator: {
              account_id: "acc",
              open_id: "open_1",
            },
          },
        });
      },
    };
  };

  try {
    const result = await dispatchPlannerTool({
      action: "get_company_brain_doc_detail",
      payload: { doc_id: 123 },
      logger: console,
      baseUrl: "http://localhost:3333",
    });

    assert.deepEqual(calls, ["http://localhost:3333/agent/company-brain/docs/123"]);
    assert.equal(result.ok, true);
    assert.equal(result.data.healed, true);
    assert.equal(result.data.retry_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchPlannerTool returns contract_violation when self-heal still ends in contract_violation", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return {
      status: 400,
      async text() {
        return JSON.stringify({
          ok: false,
          action: "create_doc",
          error: "contract_violation",
          data: {
            phase: "input",
          },
          trace_id: "trace_heal_failed",
        });
      },
    };
  };

  try {
    const result = await dispatchPlannerTool({
      action: "create_doc",
      payload: { folder_token: "folder_123" },
      logger: console,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(callCount, 1);
    assert.equal(result.ok, false);
    assert.equal(result.error, "contract_violation");
    assert.equal(result.trace_id, "trace_heal_failed");
    assert.equal(result.data.retry_count, 1);
    assert.equal(result.data.stopped, true);
    assert.equal(result.data.stop_reason, "contract_violation");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchPlannerTool returns contract_violation on invalid success output without throwing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        action: "get_runtime_info",
        trace_id: "trace_invalid_output",
        data: {
          db_path: "/tmp/db.sqlite",
          node_pid: 123,
          cwd: "/tmp",
        },
      });
    },
  });

  try {
    const result = await dispatchPlannerTool({
      action: "get_runtime_info",
      payload: {},
      logger: console,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "contract_violation");
    assert.equal(result.data.phase, "output");
    assert.equal(result.trace_id, "trace_invalid_output");
    assert.equal(result.data.stopped, true);
    assert.equal(result.data.stop_reason, "contract_violation");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizeError keeps existing error and fills unified shape", () => {
  const result = normalizeError({
    ok: false,
    action: "create_doc",
    error: "not_found",
    data: null,
    trace_id: "trace_existing_error",
  }, {
    action: "create_doc",
    fallbackError: "tool_error",
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, "create_doc");
  assert.equal(result.error, "not_found");
  assert.deepEqual(result.data, {});
  assert.equal(result.trace_id, "trace_existing_error");
});

test("dispatchPlannerTool normalizes tool failure to tool_error without throwing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 500,
    async text() {
      return JSON.stringify({
        ok: false,
        action: "create_doc",
        data: {
          message: "upstream failed",
        },
        trace_id: "trace_tool_error",
      });
    },
  });

  try {
    const result = await dispatchPlannerTool({
      action: "create_doc",
      payload: { title: "demo" },
      logger: console,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, "create_doc");
    assert.equal(result.error, "tool_error");
    assert.equal(result.trace_id, "trace_tool_error");
    assert.equal(result.data.stopped, true);
    assert.equal(result.data.stop_reason, "tool_error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchPlannerTool normalizes runtime exception without throwing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network exploded");
  };

  try {
    const result = await dispatchPlannerTool({
      action: "get_runtime_info",
      payload: {},
      logger: console,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, "get_runtime_info");
    assert.equal(result.error, "runtime_exception");
    assert.equal(result.data.message, "network exploded");
    assert.equal(result.data.stopped, true);
    assert.equal(result.data.stop_reason, "runtime_exception");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchPlannerTool stops after exhausting tool_error retry policy", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return {
      status: 500,
      async text() {
        return JSON.stringify({
          ok: false,
          action: "create_doc",
          data: { message: "still broken" },
          trace_id: "trace_tool_stop",
        });
      },
    };
  };

  try {
    const result = await dispatchPlannerTool({
      action: "create_doc",
      payload: { title: "demo" },
      logger: console,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(callCount, 2);
    assert.equal(result.ok, false);
    assert.equal(result.error, "tool_error");
    assert.equal(result.data.retry_count, 1);
    assert.equal(result.data.stopped, true);
    assert.equal(result.data.stop_reason, "tool_error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchPlannerTool stops after exhausting runtime_exception retry policy", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    throw new Error("still broken");
  };

  try {
    const result = await dispatchPlannerTool({
      action: "get_runtime_info",
      payload: {},
      logger: console,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(callCount, 2);
    assert.equal(result.ok, false);
    assert.equal(result.error, "runtime_exception");
    assert.equal(result.data.retry_count, 1);
    assert.equal(result.data.stopped, true);
    assert.equal(result.data.stop_reason, "runtime_exception");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchPlannerTool retries tool_error once and can return success", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return {
        status: 500,
        async text() {
          return JSON.stringify({
            ok: false,
            action: "create_doc",
            data: { message: "temporary upstream error" },
            trace_id: "trace_retry_tool",
          });
        },
      };
    }
    return {
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          action: "create_doc",
          trace_id: "trace_success_ignored",
          data: {
            account_id: "acc",
            auth_mode: "user_access_token",
            document_id: "doc_1",
            revision_id: 1,
            title: "demo",
            folder_token: null,
            url: "https://example.com/doc_1",
            fallback_root: false,
            permission_grant_failed: false,
            permission_grant_skipped: true,
            permission_grant_error: null,
            write_result: null,
          },
        });
      },
    };
  };

  try {
    const result = await dispatchPlannerTool({
      action: "create_doc",
      payload: { title: "demo" },
      logger: console,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(callCount, 2);
    assert.equal(result.ok, true);
    assert.equal(result.trace_id, "trace_retry_tool");
    assert.equal(result.data.retry_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchPlannerTool retries runtime_exception once and can return success", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error("temporary network error");
    }
    return {
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          action: "get_runtime_info",
          trace_id: "trace_runtime_success",
          data: {
            db_path: "/tmp/db.sqlite",
            node_pid: 123,
            cwd: "/tmp",
            service_start_time: "2026-03-19T00:00:00.000Z",
          },
        });
      },
    };
  };

  try {
    const result = await dispatchPlannerTool({
      action: "get_runtime_info",
      payload: {},
      logger: console,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(callCount, 2);
    assert.equal(result.ok, true);
    assert.equal(result.data.retry_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchPlannerTool does not retry contract_violation", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return {
      status: 400,
      async text() {
        return JSON.stringify({
          ok: false,
          action: "create_doc",
          error: "contract_violation",
          data: {
            phase: "input",
          },
          trace_id: "trace_contract_violation",
        });
      },
    };
  };

  try {
    const result = await dispatchPlannerTool({
      action: "create_doc",
      payload: { folder_token: "folder_123" },
      logger: console,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(callCount, 1);
    assert.equal(result.ok, false);
    assert.equal(result.error, "contract_violation");
    assert.equal(result.trace_id, "trace_contract_violation");
    assert.equal(result.data.retry_count, 1);
    assert.equal(result.data.stopped, true);
    assert.equal(result.data.stop_reason, "contract_violation");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchPlannerTool does not retry business_error", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return {
      status: 400,
      async text() {
        return JSON.stringify({
          ok: false,
          action: "create_doc",
          error: "business_error",
          data: {
            message: "business rule blocked",
          },
          trace_id: "trace_business_error",
        });
      },
    };
  };

  try {
    const result = await dispatchPlannerTool({
      action: "create_doc",
      payload: { title: "demo" },
      logger: console,
      baseUrl: "http://localhost:3333",
    });

    assert.equal(callCount, 1);
    assert.equal(result.ok, false);
    assert.equal(result.error, "business_error");
    assert.equal(result.trace_id, "trace_business_error");
    assert.equal(result.data.retry_count, 0);
    assert.equal(result.data.stopped, true);
    assert.equal(result.data.stop_reason, "business_error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runPlannerPreset returns contract_violation on invalid success output without throwing", async () => {
  const result = await runPlannerPreset({
    preset: "create_and_list_doc",
    input: {
      title: "demo",
      folder_token: "folder_123",
      limit: 5,
    },
    logger: console,
    async multiStepRunner({ steps }) {
      const action = steps[0]?.action;
      return {
        steps: steps.map((step) => ({ action: step.action })),
        results: [
          action === "create_doc"
            ? { ok: true, action: "create_doc", trace_id: "trace_create" }
            : { ok: true, action: "list_company_brain_docs", trace_id: 12345 },
        ],
        trace_id: action === "create_doc" ? "trace_create" : 12345,
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.preset, "create_and_list_doc");
  assert.equal(result.error, "contract_violation");
  assert.equal(result.data.phase, "preset_output");
  assert.equal(result.trace_id, 12345);
  assert.equal(result.data.stopped, true);
  assert.equal(result.data.stop_reason, "contract_violation");
});

test("runPlannerPreset does not misclassify controlled preset failure as contract violation", async () => {
  const result = await runPlannerPreset({
    preset: "create_and_list_doc",
    input: {
      title: "demo",
      folder_token: "folder_123",
      limit: 5,
    },
    logger: console,
    async multiStepRunner({ steps }) {
      return {
        steps: steps.map((step) => ({ action: step.action })),
        results: [
          steps[0]?.action === "create_doc"
            ? { ok: true, action: "create_doc", trace_id: "trace_create" }
            : { ok: false, action: "list_company_brain_docs", trace_id: "trace_list" },
        ],
        trace_id: steps[0]?.action === "create_doc" ? "trace_create" : "trace_list",
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "business_error");
  assert.equal(result.preset, "create_and_list_doc");
  assert.equal(result.stopped, true);
  assert.equal(result.stopped_at_step, 1);
  assert.equal(result.data.stopped, true);
  assert.equal(result.data.stop_reason, "business_error");
});

test("runPlannerToolFlow returns fallback when no planner tool matches", async () => {
  let dispatcherCalled = false;
  const result = await runPlannerToolFlow({
    userIntent: "幫我看看",
    taskType: "",
    logger: console,
    async dispatcher() {
      dispatcherCalled = true;
      return { ok: true };
    },
  });

  assert.equal(result.selected_action, null);
  assert.equal(result.execution_result?.ok, false);
  assert.equal(result.execution_result?.error, "business_error");
  assert.equal(result.execution_result?.data?.reason, "未命中受控工具規則，保持空選擇。");
  assert.equal(result.execution_result?.data?.stopped, true);
  assert.equal(result.execution_result?.data?.stop_reason, "business_error");
  assert.equal(result.trace_id, null);
  assert.equal(dispatcherCalled, false);
});

test("router hard-routes search-like query to company brain search", () => {
  assert.equal(route("幫我找關於 OKR 的文件"), "search_company_brain_docs");
});

test("router prefers search over detail when query contains both 搜尋 and 內容", () => {
  assert.equal(route("搜尋有提到 OKR 的內容"), "search_company_brain_docs");
});

test("router uses active doc for pronoun detail query and falls back when missing", () => {
  assert.equal(
    route("這份文件裡面寫了什麼", { activeDoc: { doc_id: "doc_123", title: "Demo" } }),
    "get_company_brain_doc_detail",
  );
  assert.equal(route("這份文件裡面寫了什麼"), "search_and_detail_doc");
});

test("router uses active candidates for ordinal follow-up selection", () => {
  assert.equal(
    route("打開第一個", {
      activeCandidates: [
        { doc_id: "doc_1", title: "OKR 文件" },
        { doc_id: "doc_2", title: "OKR 範本" },
      ],
    }),
    "get_company_brain_doc_detail",
  );
});

test("planner flow runtime resolves doc query flow route", () => {
  const resolved = resolvePlannerFlowRoute({
    flows: [plannerDocQueryFlow],
    userIntent: "幫我找 OKR 文件",
    payload: { limit: 5 },
    logger: console,
  });

  assert.equal(resolved.flow?.id, "doc_query");
  assert.equal(resolved.action, "search_company_brain_docs");
  assert.deepEqual(resolved.payload, {
    limit: 5,
    q: "幫我找 OKR 文件",
    query: "幫我找 OKR 文件",
  });
});

test("planner flow runtime can map company brain detail action back to doc query flow", () => {
  const flow = getPlannerFlowForAction([plannerDocQueryFlow], "get_company_brain_doc_detail");
  assert.equal(flow?.id, "doc_query");
});

test("planner flow runtime resolves runtime info query to runtime-info flow", () => {
  const resolved = resolvePlannerFlowRoute({
    flows: [plannerRuntimeInfoFlow, plannerOkrFlow, plannerDeliveryFlow, plannerDocQueryFlow],
    userIntent: "幫我看 runtime info",
    payload: {},
    logger: console,
  });

  assert.equal(resolved.flow?.id, "runtime_info");
  assert.equal(resolved.action, "get_runtime_info");
  assert.deepEqual(resolved.payload, {});
});

test("planner flow runtime keeps doc query on doc flow when multiple flows coexist", () => {
  const resolved = resolvePlannerFlowRoute({
    flows: [plannerRuntimeInfoFlow, plannerOkrFlow, plannerDeliveryFlow, plannerDocQueryFlow],
    userIntent: "幫我找 OKR 文件",
    payload: { limit: 3 },
    logger: console,
  });
  assert.equal(resolved.flow?.id, "okr");
  assert.equal(resolved.action, "search_company_brain_docs");
  assert.deepEqual(resolved.payload, {
    limit: 3,
    q: "幫我找 OKR 文件",
    query: "幫我找 OKR 文件",
  });
});

test("planner flow runtime routes general file query to doc query flow when multiple flows coexist", () => {
  const resolved = resolvePlannerFlowRoute({
    flows: [plannerRuntimeInfoFlow, plannerOkrFlow, plannerBdFlow, plannerDeliveryFlow, plannerDocQueryFlow],
    userIntent: "幫我找 onboarding 文件",
    payload: { limit: 3 },
    logger: console,
  });

  assert.equal(resolved.flow?.id, "delivery");
  assert.equal(resolved.action, "search_company_brain_docs");
  assert.deepEqual(resolved.payload, {
    limit: 3,
    q: "幫我找 onboarding 文件",
    query: "幫我找 onboarding 文件",
  });
});

test("planner flow runtime routes OKR summary query to okr flow", () => {
  const resolved = resolvePlannerFlowRoute({
    flows: [plannerRuntimeInfoFlow, plannerOkrFlow, plannerBdFlow, plannerDeliveryFlow, plannerDocQueryFlow],
    userIntent: "幫我整理本週 OKR 進度",
    payload: {},
    logger: console,
  });

  assert.equal(resolved.flow?.id, "okr");
  assert.equal(resolved.action, "search_and_detail_doc");
  assert.deepEqual(resolved.payload, {
    q: "幫我整理本週 OKR 進度",
    query: "幫我整理本週 OKR 進度",
  });
});

test("planner flow runtime routes delivery summary query to delivery flow", () => {
  const resolved = resolvePlannerFlowRoute({
    flows: [plannerRuntimeInfoFlow, plannerOkrFlow, plannerBdFlow, plannerDeliveryFlow, plannerDocQueryFlow],
    userIntent: "幫我整理交付 SOP 流程",
    payload: {},
    logger: console,
  });

  assert.equal(resolved.flow?.id, "delivery");
  assert.equal(resolved.action, "search_and_detail_doc");
  assert.deepEqual(resolved.payload, {
    q: "幫我整理交付 SOP 流程",
    query: "幫我整理交付 SOP 流程",
  });
});

test("planner flow runtime routes BD summary query to bd flow", () => {
  const resolved = resolvePlannerFlowRoute({
    flows: [plannerRuntimeInfoFlow, plannerOkrFlow, plannerBdFlow, plannerDeliveryFlow, plannerDocQueryFlow],
    userIntent: "幫我整理 BD 跟進進度",
    payload: {},
    logger: console,
  });

  assert.equal(resolved.flow?.id, "bd");
  assert.equal(resolved.action, "search_and_detail_doc");
  assert.deepEqual(resolved.payload, {
    q: "幫我整理 BD 跟進進度",
    query: "幫我整理 BD 跟進進度",
  });
});

test("planner flow runtime prefers higher keyword hit count when OKR and delivery could both match", () => {
  const resolved = resolvePlannerFlowRoute({
    flows: [
      { ...plannerRuntimeInfoFlow, priority: 100, matchKeywords: ["runtime", "db path", "pid", "cwd"] },
      {
        ...plannerOkrFlow,
        priority: 80,
        matchKeywords: ["okr", "目標", "kr", "關鍵結果", "週進度", "本週 todo"],
      },
      {
        ...plannerBdFlow,
        priority: 80,
        matchKeywords: ["bd", "商機", "客戶", "跟進", "demo", "提案"],
      },
      {
        ...plannerDeliveryFlow,
        priority: 80,
        matchKeywords: ["交付", "sop", "驗收", "導入", "onboarding"],
      },
      { ...plannerDocQueryFlow, priority: 10, matchKeywords: [] },
    ],
    userIntent: "幫我整理 OKR 關鍵結果與 onboarding 進度",
    payload: {},
    logger: console,
  });

  assert.equal(resolved.flow?.id, "okr");
  assert.equal(resolved.action, "search_and_detail_doc");
});

test("planner flow runtime prefers delivery flow when delivery keyword hits exceed OKR hits", () => {
  const resolved = resolvePlannerFlowRoute({
    flows: [
      { ...plannerRuntimeInfoFlow, priority: 100, matchKeywords: ["runtime", "db path", "pid", "cwd"] },
      {
        ...plannerOkrFlow,
        priority: 80,
        matchKeywords: ["okr", "目標", "kr", "關鍵結果", "週進度", "本週 todo"],
      },
      {
        ...plannerBdFlow,
        priority: 80,
        matchKeywords: ["bd", "商機", "客戶", "跟進", "demo", "提案"],
      },
      {
        ...plannerDeliveryFlow,
        priority: 80,
        matchKeywords: ["交付", "sop", "驗收", "導入", "onboarding"],
      },
      { ...plannerDocQueryFlow, priority: 10, matchKeywords: [] },
    ],
    userIntent: "幫我整理交付 onboarding 驗收流程與 OKR",
    payload: {},
    logger: console,
  });

  assert.equal(resolved.flow?.id, "delivery");
  assert.equal(resolved.action, "search_and_detail_doc");
});

test("planner flow runtime routes runtime query ahead of bd flow", () => {
  const resolved = resolvePlannerFlowRoute({
    flows: [plannerRuntimeInfoFlow, plannerOkrFlow, plannerBdFlow, plannerDeliveryFlow, plannerDocQueryFlow],
    userIntent: "請給我 runtime db path",
    payload: {},
    logger: console,
  });

  assert.equal(resolved.flow?.id, "runtime_info");
  assert.equal(resolved.action, "get_runtime_info");
});

test("planner flow runtime keeps generic document query on doc flow when BD does not match", () => {
  const resolved = resolvePlannerFlowRoute({
    flows: [plannerRuntimeInfoFlow, plannerOkrFlow, plannerBdFlow, plannerDeliveryFlow, plannerDocQueryFlow],
    userIntent: "幫我找季度回顧文件",
    payload: { limit: 2 },
    logger: console,
  });

  assert.equal(resolved.flow?.id, "doc_query");
  assert.equal(resolved.action, "search_company_brain_docs");
  assert.deepEqual(resolved.payload, {
    limit: 2,
    q: "幫我找季度回顧文件",
    query: "幫我找季度回顧文件",
  });
});

test("planner flow runtime keeps generic document query on doc flow when no themed flow matches", () => {
  const resolved = resolvePlannerFlowRoute({
    flows: [plannerRuntimeInfoFlow, plannerOkrFlow, plannerBdFlow, plannerDeliveryFlow, plannerDocQueryFlow],
    userIntent: "幫我找季度回顧文件",
    payload: { limit: 2 },
    logger: console,
  });

  assert.equal(resolved.flow?.id, "doc_query");
  assert.equal(resolved.action, "search_company_brain_docs");
  assert.deepEqual(resolved.payload, {
    limit: 2,
    q: "幫我找季度回顧文件",
    query: "幫我找季度回顧文件",
  });
});

test("runPlannerToolFlow prefers hard route before planner selector", async () => {
  const calls = [];
  const result = await runPlannerToolFlow({
    userIntent: "幫我找關於 OKR 的文件",
    payload: { limit: 5 },
    logger: console,
    selector() {
      return {
        selected_action: null,
        reason: "selector_should_not_run",
      };
    },
    async dispatcher({ action, payload }) {
      calls.push({ action, payload });
      return {
        ok: true,
        action,
        data: { total: 0 },
        trace_id: "trace_hard_route",
      };
    },
  });

  assert.equal(result.selected_action, "search_company_brain_docs");
  assert.equal(result.execution_result?.ok, true);
  assert.equal(result.trace_id, "trace_hard_route");
  assert.deepEqual(calls, [{
    action: "search_company_brain_docs",
    payload: {
      limit: 5,
      q: "幫我找關於 OKR 的文件",
      query: "幫我找關於 OKR 的文件",
    },
  }]);
});

test("runPlannerToolFlow uses runtime-info flow for runtime query without affecting doc flow", async () => {
  const calls = [];
  const result = await runPlannerToolFlow({
    userIntent: "請給我 db path 和 pid",
    logger: console,
    selector() {
      return {
        selected_action: null,
        reason: "selector_should_not_run",
      };
    },
    async dispatcher({ action, payload }) {
      calls.push({ action, payload });
      return {
        ok: true,
        action,
        data: {
          db_path: "/tmp/lark-rag.sqlite",
          node_pid: 123,
          cwd: "/tmp",
          service_start_time: "2026-03-20T00:00:00.000Z",
        },
        trace_id: "trace_runtime_flow",
      };
    },
  });

  assert.equal(result.selected_action, "get_runtime_info");
  assert.equal(result.execution_result?.ok, true);
  assert.equal(result.execution_result?.formatted_output?.kind, "runtime_info");
  assert.equal(result.execution_result?.formatted_output?.db_path, "/tmp/lark-rag.sqlite");
  assert.deepEqual(calls, [{
    action: "get_runtime_info",
    payload: {},
  }]);
});

test("runPlannerToolFlow emits doc query route and result debug traces for search flow", async () => {
  resetPlannerRuntimeContext();
  const debugEvents = [];
  const logger = {
    debug(label, event) {
      debugEvents.push({ label, event });
    },
    info() {},
    warn() {},
  };

  const result = await runPlannerToolFlow({
    userIntent: "幫我找季度回顧文件",
    payload: { limit: 5 },
    logger,
    async dispatcher() {
      return {
        ok: true,
        action: "company_brain_docs_search",
        items: [
          { doc_id: "doc_1", title: "OKR 文件" },
          { doc_id: "doc_2", title: "OKR 範本" },
        ],
        trace_id: "trace_doc_query_debug",
      };
    },
  });

  assert.equal(result.execution_result?.ok, true);
  const routeEvent = debugEvents.find((item) => item.event?.event_type === "doc_query_route");
  const resultEvent = debugEvents.find((item) => item.event?.event_type === "doc_query_result");
  assert.equal(routeEvent?.label, "planner_doc_query_pipeline");
  assert.equal(routeEvent?.event?.user_query, "幫我找季度回顧文件");
  assert.equal(routeEvent?.event?.tool, "search_company_brain_docs");
  assert.equal(routeEvent?.event?.active_doc_exists, false);
  assert.equal(routeEvent?.event?.active_candidates_exists, false);
  assert.equal(resultEvent?.label, "planner_doc_query_pipeline");
  assert.equal(resultEvent?.event?.tool, "search_company_brain_docs");
  assert.equal(resultEvent?.event?.hit_count, 2);
  assert.equal(resultEvent?.event?.formatter_kind, "search");
  assert.equal(resultEvent?.event?.trace_id, "trace_doc_query_debug");
});

test("runPlannerToolFlow reuses active_doc so pronoun detail query hits detail after search-and-detail success", async () => {
  resetPlannerRuntimeContext();
  const dispatcherCalls = [];

  const first = await runPlannerToolFlow({
    userIntent: "整理 OKR 文件",
    payload: { limit: 5 },
    logger: console,
    async presetRunner({ preset, input }) {
      assert.equal(preset, "search_and_detail_doc");
      assert.equal(input.q, "整理 OKR 文件");
      return {
        ok: true,
        preset,
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [{ doc_id: "doc_okr_1", title: "OKR 文件" }],
            trace_id: "trace_search",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: { doc_id: "doc_okr_1", title: "OKR 文件" },
            trace_id: "trace_detail",
          },
        ],
        trace_id: "trace_detail",
        stopped: false,
        stopped_at_step: null,
      };
    },
  });

  const second = await runPlannerToolFlow({
    userIntent: "這份文件裡面寫了什麼",
    payload: {},
    logger: console,
    async dispatcher({ action, payload }) {
      dispatcherCalls.push({ action, payload });
      return {
        ok: true,
        action: "company_brain_doc_detail",
        item: { doc_id: payload.doc_id, title: "OKR 文件" },
        trace_id: "trace_active_detail",
      };
    },
  });

  assert.equal(first.selected_action, "search_and_detail_doc");
  assert.equal(first.execution_result?.ok, true);
  assert.equal(second.selected_action, "get_company_brain_doc_detail");
  assert.equal(second.execution_result?.ok, true);
  assert.deepEqual(dispatcherCalls, [{
    action: "get_company_brain_doc_detail",
    payload: {
      doc_id: "doc_okr_1",
      query: "這份文件裡面寫了什麼",
    },
  }]);

  resetPlannerRuntimeContext();
});

test("runPlannerToolFlow formats search result instead of only returning raw tool output", async () => {
  resetPlannerRuntimeContext();
  const result = await runPlannerToolFlow({
    userIntent: "幫我找 OKR 文件",
    payload: { limit: 5 },
    logger: console,
    async dispatcher({ action }) {
      assert.equal(action, "search_company_brain_docs");
      return {
        ok: true,
        action: "company_brain_docs_search",
        items: [
          { doc_id: "doc_1", title: "OKR 文件" },
          { doc_id: "doc_2", title: "OKR 範本" },
        ],
        trace_id: "trace_search_format",
      };
    },
  });

  assert.equal(result.execution_result?.ok, true);
  assert.equal(result.execution_result?.formatted_output?.kind, "search");
  assert.deepEqual(result.execution_result?.formatted_output?.items, [
    { title: "OKR 文件", doc_id: "doc_1" },
    { title: "OKR 範本", doc_id: "doc_2" },
  ]);
  assert.equal(result.execution_result?.formatted_output?.found, true);
  assert.deepEqual(result.execution_result?.formatted_output?.action_layer, {
    summary: "找到 2 份OKR文件：OKR 文件、OKR 範本",
    next_actions: [
      "查看文件：OKR 文件",
      "查看文件：OKR 範本",
    ],
    owner: null,
    deadline: null,
    risks: [],
    status: null,
  });
});

test("runPlannerToolFlow formats detail result with content summary", async () => {
  resetPlannerRuntimeContext();
  await runPlannerToolFlow({
    userIntent: "整理交付 SOP",
    payload: {},
    logger: console,
    async presetRunner({ preset }) {
      assert.equal(preset, "search_and_detail_doc");
      return {
        ok: true,
        preset,
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [{ doc_id: "doc_detail_1", title: "交付 SOP" }],
            trace_id: "trace_seed_search",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: { doc_id: "doc_detail_1", title: "交付 SOP" },
            trace_id: "trace_seed_detail",
          },
        ],
        trace_id: "trace_seed_detail",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return null;
    },
  });

  const result = await runPlannerToolFlow({
    userIntent: "這份文件裡面寫了什麼",
    payload: {},
    logger: console,
    async dispatcher({ action, payload }) {
      assert.equal(action, "get_company_brain_doc_detail");
      assert.equal(payload.doc_id, "doc_detail_1");
      return {
        ok: true,
        action: "company_brain_doc_detail",
        item: { doc_id: "doc_detail_1", title: "交付 SOP" },
        trace_id: "trace_detail_format",
      };
    },
    async contentReader({ docId }) {
      assert.equal(docId, "doc_detail_1");
      return {
        title: "交付 SOP",
        content: "這份文件描述 onboarding 與交付步驟，包含角色分工、時程與驗收方式。",
      };
    },
  });

  assert.equal(result.execution_result?.ok, true);
  assert.equal(result.execution_result?.formatted_output?.kind, "detail");
  assert.equal(result.execution_result?.formatted_output?.title, "交付 SOP");
  assert.equal(result.execution_result?.formatted_output?.doc_id, "doc_detail_1");
  assert.equal(
    result.execution_result?.formatted_output?.content_summary,
    "這份文件描述 onboarding 與交付步驟，包含角色分工、時程與驗收方式。",
  );
  assert.equal(result.execution_result?.formatted_output?.found, true);
  resetPlannerRuntimeContext();
});

test("runPlannerToolFlow formats mixed search-and-detail result with title match reason and summary", async () => {
  resetPlannerRuntimeContext();
  const result = await runPlannerToolFlow({
    userIntent: "搜尋 onboarding 流程並解釋",
    payload: { limit: 5 },
    logger: console,
    async presetRunner({ preset, input }) {
      assert.equal(preset, "search_and_detail_doc");
      assert.equal(input.q, "搜尋 onboarding 流程並解釋");
      return {
        ok: true,
        preset,
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [{ doc_id: "doc_onboarding_1", title: "Onboarding 流程" }],
            trace_id: "trace_search_mixed",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: { doc_id: "doc_onboarding_1", title: "Onboarding 流程" },
            trace_id: "trace_detail_mixed",
          },
        ],
        trace_id: "trace_detail_mixed",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader({ docId }) {
      assert.equal(docId, "doc_onboarding_1");
      return {
        title: "Onboarding 流程",
        content: "內容重點：新人報到、工具開通、第一週訓練、owner 追蹤與驗收。",
      };
    },
  });

  assert.equal(result.execution_result?.ok, true);
  assert.equal(result.execution_result?.formatted_output?.kind, "search_and_detail");
  assert.equal(result.execution_result?.formatted_output?.title, "Onboarding 流程");
  assert.equal(result.execution_result?.formatted_output?.doc_id, "doc_onboarding_1");
  assert.equal(result.execution_result?.formatted_output?.match_reason, "搜尋 onboarding 流程並解釋");
  assert.equal(
    result.execution_result?.formatted_output?.content_summary,
    "內容重點：新人報到、工具開通、第一週訓練、owner 追蹤與驗收。",
  );
  assert.equal(result.execution_result?.formatted_output?.found, true);
  assert.deepEqual(result.execution_result?.formatted_output?.action_layer, {
    summary: "內容重點：新人報到、工具開通、第一週訓練、owner 追蹤與驗收。",
    next_actions: [
      "確認 交付後續跟進事項",
      "確認 owner",
      "確認 deadline",
    ],
    owner: null,
    deadline: null,
    risks: [],
    status: null,
  });
});

test("runPlannerToolFlow returns candidate list when search_and_detail_doc hits multiple files", async () => {
  resetPlannerRuntimeContext();
  const debugEvents = [];
  const result = await runPlannerToolFlow({
    userIntent: "幫我查 BD 文件並整理重點",
    payload: { limit: 10 },
    logger: {
      debug(label, event) {
        debugEvents.push({ label, event });
      },
      info() {},
      warn() {},
    },
    async presetRunner({ preset }) {
      assert.equal(preset, "search_and_detail_doc");
      return {
        ok: true,
        preset,
        steps: [
          { action: "search_company_brain_docs" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [
              { doc_id: "doc_bd_1", title: "BD Playbook" },
              { doc_id: "doc_bd_2", title: "BD SOP" },
              { doc_id: "doc_bd_3", title: "BD FAQ" },
            ],
            trace_id: "trace_search_candidates",
          },
        ],
        trace_id: "trace_search_candidates",
        stopped: false,
        stopped_at_step: null,
      };
    },
  });

  assert.equal(result.execution_result?.ok, true);
  assert.equal(result.execution_result?.formatted_output?.kind, "search_and_detail_candidates");
  assert.deepEqual(result.execution_result?.formatted_output?.items, [
    { title: "BD Playbook", doc_id: "doc_bd_1" },
    { title: "BD SOP", doc_id: "doc_bd_2" },
    { title: "BD FAQ", doc_id: "doc_bd_3" },
  ]);
  assert.equal(result.execution_result?.formatted_output?.match_reason, "幫我查 BD 文件並整理重點");
  assert.equal(result.execution_result?.formatted_output?.found, true);
  assert.deepEqual(result.execution_result?.formatted_output?.action_layer, {
    summary: "找到多份BD文件，需先指定要讀哪一份。",
    next_actions: [
      "打開第1份：BD Playbook",
      "打開第2份：BD SOP",
      "打開第3份：BD FAQ",
    ],
    owner: null,
    deadline: null,
    risks: ["命中多份文件，尚未唯一確定。"],
    status: null,
  });
  const resultEvent = debugEvents.find((item) => item.event?.event_type === "doc_query_result");
  assert.equal(resultEvent?.event?.hit_count, 3);
  assert.equal(resultEvent?.event?.formatter_kind, "search_and_detail_candidates");
  assert.equal(resultEvent?.event?.tool, "search_and_detail_doc");
  resetPlannerRuntimeContext();
});

test("runPlannerToolFlow returns explicit not-found output when search_and_detail_doc finds no files", async () => {
  resetPlannerRuntimeContext();
  const result = await runPlannerToolFlow({
    userIntent: "搜尋不存在的流程並解釋",
    payload: { limit: 10 },
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [],
            trace_id: "trace_search_none",
          },
        ],
        trace_id: "trace_search_none",
        stopped: false,
        stopped_at_step: null,
      };
    },
  });

  assert.deepEqual(result.execution_result?.formatted_output, {
    kind: "search_and_detail_not_found",
    title: null,
    doc_id: null,
    items: [],
    match_reason: "搜尋不存在的流程並解釋",
    content_summary: null,
    learning_status: null,
    learning_concepts: [],
    learning_tags: [],
    found: false,
  });
  resetPlannerRuntimeContext();
});

test("runPlannerToolFlow adds OKR action layer on themed search result", async () => {
  resetPlannerRuntimeContext();
  const result = await runPlannerToolFlow({
    userIntent: "幫我看 OKR 文件",
    payload: { limit: 5 },
    logger: console,
    async dispatcher({ action }) {
      assert.equal(action, "search_company_brain_docs");
      return {
        ok: true,
        action: "company_brain_docs_search",
        items: [
          { doc_id: "okr_1", title: "OKR Q2 Plan" },
          { doc_id: "okr_2", title: "OKR Weekly Review" },
        ],
        trace_id: "trace_okr_action_layer",
      };
    },
  });

  assert.deepEqual(result.execution_result?.formatted_output?.action_layer, {
    summary: "找到 2 份OKR文件：OKR Q2 Plan、OKR Weekly Review",
    next_actions: [
      "查看文件：OKR Q2 Plan",
      "查看文件：OKR Weekly Review",
    ],
    owner: null,
    deadline: null,
    risks: [],
    status: null,
  });
});

test("runPlannerToolFlow adds BD action layer on themed candidate result", async () => {
  resetPlannerRuntimeContext();
  const result = await runPlannerToolFlow({
    userIntent: "幫我查 BD 文件並整理重點",
    payload: { limit: 10 },
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [
              { doc_id: "doc_bd_1", title: "BD Playbook" },
              { doc_id: "doc_bd_2", title: "BD SOP" },
            ],
            trace_id: "trace_bd_action_layer",
          },
        ],
        trace_id: "trace_bd_action_layer",
        stopped: false,
        stopped_at_step: null,
      };
    },
  });

  assert.deepEqual(result.execution_result?.formatted_output?.action_layer, {
    summary: "找到多份BD文件，需先指定要讀哪一份。",
    next_actions: [
      "打開第1份：BD Playbook",
      "打開第2份：BD SOP",
    ],
    owner: null,
    deadline: null,
    risks: ["命中多份文件，尚未唯一確定。"],
    status: null,
  });
});

test("runPlannerToolFlow extracts action layer fields for OKR detail result", async () => {
  resetPlannerRuntimeContext();
  const result = await runPlannerToolFlow({
    userIntent: "整理 OKR 文件",
    payload: { limit: 5 },
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [{ doc_id: "okr_detail_1", title: "OKR Weekly Review" }],
            trace_id: "trace_okr_search",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: { doc_id: "okr_detail_1", title: "OKR Weekly Review" },
            trace_id: "trace_okr_detail_extracted",
          },
        ],
        trace_id: "trace_okr_detail_extracted",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return {
        title: "OKR Weekly Review",
        content: "owner: Alice; deadline: 2026-03-28; status: on_track; risks: 資料延遲、跨部門依賴。",
      };
    },
  });

  assert.deepEqual(result.execution_result?.formatted_output?.action_layer, {
    summary: "owner: Alice; deadline: 2026-03-28; status: on_track; risks: 資料延遲、跨部門依賴。",
    next_actions: [
      "確認 OKR後續跟進事項",
      "確認 owner",
      "確認 deadline",
    ],
    owner: "Alice",
    deadline: "2026-03-28",
    risks: ["資料延遲", "跨部門依賴"],
    status: "on_track",
  });
  resetPlannerRuntimeContext();
});

test("runPlannerToolFlow makes action layer next step proactive for blocked detail result", async () => {
  resetPlannerRuntimeContext();
  const result = await runPlannerToolFlow({
    userIntent: "整理 BD 文件",
    payload: { limit: 5 },
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [{ doc_id: "bd_detail_blocked_1", title: "BD Playbook" }],
            trace_id: "trace_bd_detail_blocked_search",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: { doc_id: "bd_detail_blocked_1", title: "BD Playbook" },
            trace_id: "trace_bd_detail_blocked_detail",
          },
        ],
        trace_id: "trace_bd_detail_blocked_detail",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return {
        title: "BD Playbook",
        content: "負責人：Bob；截止：下週一；狀態：blocked；風險：客戶回覆延遲。",
      };
    },
  });

  assert.deepEqual(result.execution_result?.formatted_output?.action_layer, {
    summary: "負責人：Bob；截止：下週一；狀態：blocked；風險：客戶回覆延遲。",
    next_actions: [
      "優先解除 BD卡點",
      "確認 owner",
      "確認 deadline",
    ],
    owner: "Bob",
    deadline: "下週一",
    risks: ["客戶回覆延遲"],
    status: "blocked",
  });
});

test("runPlannerToolFlow syncs action_layer next_actions into task lifecycle v1 store", async () => {
  resetPlannerRuntimeContext();
  await runPlannerToolFlow({
    userIntent: "整理 OKR 文件",
    payload: { limit: 5 },
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [{ doc_id: "okr_lifecycle_1", title: "OKR Weekly Review" }],
            trace_id: "trace_okr_lifecycle_search",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: { doc_id: "okr_lifecycle_1", title: "OKR Weekly Review" },
            trace_id: "trace_okr_lifecycle_detail",
          },
        ],
        trace_id: "trace_okr_lifecycle_detail",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return {
        title: "OKR Weekly Review",
        content: "owner: Alice; deadline: 2026-03-28; status: on_track; risks: 資料延遲。",
      };
    },
  });

  const snapshot = await getLatestPlannerTaskLifecycleSnapshot();

  assert.equal(snapshot?.scope?.theme, "okr");
  assert.equal(snapshot?.scope?.source_doc_id, "okr_lifecycle_1");
  assert.deepEqual(snapshot?.tasks?.map((task) => task.title), [
    "確認 OKR後續跟進事項",
    "確認 owner",
    "確認 deadline",
  ]);
  assert.equal(snapshot?.tasks?.[0]?.lifecycle_state, "planned");
  assert.deepEqual(snapshot?.tasks?.[0]?.lifecycle_history?.map((item) => item.to), [
    "clarified",
    "planned",
  ]);
  assert.equal(snapshot?.tasks?.[0]?.owner, "Alice");
  assert.equal(snapshot?.tasks?.[0]?.deadline, "2026-03-28");
  assert.deepEqual(snapshot?.tasks?.[0]?.risks, ["資料延遲"]);
  assert.equal(snapshot?.tasks?.[0]?.source_status, "on_track");
  assert.equal(snapshot?.tasks?.[0]?.suggestion_count, 1);
});

test("runPlannerToolFlow reuses lifecycle task ids when the same next_actions are suggested again", async () => {
  resetPlannerRuntimeContext();
  const runScenario = async (traceId) => {
    await runPlannerToolFlow({
      userIntent: "整理 BD 文件",
      payload: { limit: 5 },
      logger: console,
      async presetRunner() {
        return {
          ok: true,
          preset: "search_and_detail_doc",
          steps: [
            { action: "search_company_brain_docs" },
            { action: "get_company_brain_doc_detail" },
          ],
          results: [
            {
              ok: true,
              action: "company_brain_docs_search",
              items: [{ doc_id: "bd_lifecycle_1", title: "BD Playbook" }],
              trace_id: `${traceId}_search`,
            },
            {
              ok: true,
              action: "company_brain_doc_detail",
              item: { doc_id: "bd_lifecycle_1", title: "BD Playbook" },
              trace_id: traceId,
            },
          ],
          trace_id: traceId,
          stopped: false,
          stopped_at_step: null,
        };
      },
      async contentReader() {
        return {
          title: "BD Playbook",
          content: "負責人：Bob；截止：下週一；風險：客戶回覆延遲。",
        };
      },
    });
    return getLatestPlannerTaskLifecycleSnapshot();
  };

  const first = await runScenario("trace_bd_lifecycle_1");
  const second = await runScenario("trace_bd_lifecycle_2");

  assert.deepEqual(first?.tasks?.map((task) => task.id), second?.tasks?.map((task) => task.id));
  assert.deepEqual(second?.tasks?.map((task) => task.suggestion_count), [2, 2, 2]);
  assert.equal(second?.scope?.trace_id, "trace_bd_lifecycle_2");
});

test("follow-up turn reads planner-task-lifecycle-v1 before doc follow-up dispatch", async () => {
  resetPlannerRuntimeContext();
  await runPlannerToolFlow({
    userIntent: "整理 OKR 文件",
    payload: { limit: 5 },
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [{ doc_id: "okr_task_followup_1", title: "OKR Weekly Review" }],
            trace_id: "trace_task_followup_search",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: { doc_id: "okr_task_followup_1", title: "OKR Weekly Review" },
            trace_id: "trace_task_followup_detail",
          },
        ],
        trace_id: "trace_task_followup_detail",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return {
        title: "OKR Weekly Review",
        content: "owner: Alice; deadline: 2026-03-28; status: on_track; risks: 資料延遲。",
      };
    },
  });

  let dispatched = false;
  const result = await runPlannerToolFlow({
    userIntent: "誰負責這些 task？",
    payload: {},
    logger: console,
    async dispatcher() {
      dispatched = true;
      throw new Error("should_not_dispatch_doc_tool");
    },
  });

  assert.equal(dispatched, false);
  assert.equal(result.selected_action, "read_task_lifecycle_v1");
  assert.equal(result.execution_result?.action, "read_task_lifecycle_v1");
  assert.equal(result.execution_result?.formatted_output?.kind, "task_lifecycle");
  assert.equal(result.execution_result?.formatted_output?.content_summary, "目前 task 負責人：Alice。");
  assert.equal(result.execution_result?.formatted_output?.action_layer?.owner, "Alice");
  assert.equal(result.execution_result?.formatted_output?.action_layer?.deadline, "2026-03-28");
});

test("follow-up turn can advance a single targeted task state by ordinal and later read updated status", async () => {
  resetPlannerRuntimeContext();
  await runPlannerToolFlow({
    userIntent: "整理 BD 文件",
    payload: { limit: 5 },
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [{ doc_id: "bd_task_followup_1", title: "BD Playbook" }],
            trace_id: "trace_bd_task_search",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: { doc_id: "bd_task_followup_1", title: "BD Playbook" },
            trace_id: "trace_bd_task_detail",
          },
        ],
        trace_id: "trace_bd_task_detail",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return {
        title: "BD Playbook",
        content: "負責人：Bob；截止：下週一；風險：客戶回覆延遲。",
      };
    },
  });

  const inProgress = await runPlannerToolFlow({
    userIntent: "第一個開始處理了",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });
  assert.equal(inProgress.selected_action, "update_task_lifecycle_v1");
  assert.equal(inProgress.execution_result?.formatted_output?.kind, "task_lifecycle_update");
  assert.equal(inProgress.execution_result?.formatted_output?.action_layer?.status, "in_progress");
  assert.equal(inProgress.execution_result?.data?.updated_count, 1);
  assert.equal(inProgress.execution_result?.data?.tasks?.length, 1);
  assert.equal(inProgress.execution_result?.data?.tasks?.[0]?.task_state, "in_progress");

  const blocked = await runPlannerToolFlow({
    userIntent: "第二個卡住了",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });
  assert.equal(blocked.selected_action, "update_task_lifecycle_v1");
  assert.equal(blocked.execution_result?.formatted_output?.action_layer?.status, "blocked");
  assert.equal(blocked.execution_result?.data?.updated_count, 1);
  assert.equal(blocked.execution_result?.data?.tasks?.[0]?.task_state, "blocked");

  const done = await runPlannerToolFlow({
    userIntent: "第一個完成了",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });
  assert.equal(done.selected_action, "update_task_lifecycle_v1");
  assert.equal(done.execution_result?.formatted_output?.action_layer?.status, "done");
  assert.equal(done.execution_result?.data?.updated_count, 1);
  assert.equal(done.execution_result?.data?.tasks?.[0]?.task_state, "done");

  const snapshot = await getLatestPlannerTaskLifecycleSnapshot();
  assert.deepEqual(snapshot?.tasks?.map((task) => task.task_state), ["done", "blocked", "planned"]);

  const status = await runPlannerToolFlow({
    userIntent: "現在進度怎麼樣？",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });
  assert.equal(status.selected_action, "read_task_lifecycle_v1");
  assert.equal(
    status.execution_result?.formatted_output?.content_summary,
    "目前 task 狀態：planned 1 個、in_progress 0 個、blocked 1 個、done 1 個。",
  );
});

test("ambiguous '這個' follow-up returns candidate tasks without updating state", async () => {
  resetPlannerRuntimeContext();
  await runPlannerToolFlow({
    userIntent: "整理 BD 文件",
    payload: { limit: 5 },
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [{ doc_id: "bd_task_followup_ambiguous", title: "BD Playbook" }],
            trace_id: "trace_bd_task_ambiguous_search",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: { doc_id: "bd_task_followup_ambiguous", title: "BD Playbook" },
            trace_id: "trace_bd_task_ambiguous_detail",
          },
        ],
        trace_id: "trace_bd_task_ambiguous_detail",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return {
        title: "BD Playbook",
        content: "負責人：Bob；截止：下週一；風險：客戶回覆延遲。",
      };
    },
  });

  const result = await runPlannerToolFlow({
    userIntent: "這個卡住了",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });

  assert.equal(result.selected_action, "update_task_lifecycle_v1");
  assert.equal(result.execution_result?.formatted_output?.kind, "task_lifecycle_candidates");
  assert.equal(result.execution_result?.data?.updated_count, 0);
  assert.equal(result.execution_result?.data?.target_mode, "ambiguous");
  assert.equal(
    result.execution_result?.formatted_output?.content_summary,
    "目前無法唯一定位 task，請指定第一個、第二個，或帶 owner 的 task。",
  );

  const snapshot = await getLatestPlannerTaskLifecycleSnapshot();
  assert.deepEqual(snapshot?.tasks?.map((task) => task.task_state), ["planned", "planned", "planned"]);
});

test("follow-up turn can advance a single targeted task by unique owner", async () => {
  resetPlannerRuntimeContext();
  replacePlannerTaskLifecycleStoreForTests({
    tasks: {
      task_a: {
        id: "task_a",
        scope_key: "scope_owner_unique",
        title: "跟進 Alice",
        theme: "okr",
        owner: "Alice",
        deadline: "2026-03-28",
        task_state: "planned",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
      task_b: {
        id: "task_b",
        scope_key: "scope_owner_unique",
        title: "跟進 Bob",
        theme: "okr",
        owner: "Bob",
        deadline: "2026-03-29",
        task_state: "planned",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    scopes: {
      scope_owner_unique: {
        scope_key: "scope_owner_unique",
        theme: "okr",
        selected_action: "search_and_detail_doc",
        user_intent: "整理 OKR 文件",
        trace_id: "trace_owner_unique",
        source_kind: "search_and_detail",
        source_doc_id: "doc_owner_unique",
        source_title: "OKR Weekly Review",
        current_task_ids: ["task_a", "task_b"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    latest_scope_key: "scope_owner_unique",
  });

  const result = await runPlannerToolFlow({
    userIntent: "Alice 的 task 完成了",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });

  assert.equal(result.selected_action, "update_task_lifecycle_v1");
  assert.equal(result.execution_result?.data?.updated_count, 1);
  assert.equal(result.execution_result?.data?.tasks?.length, 1);
  assert.equal(result.execution_result?.data?.tasks?.[0]?.owner, "Alice");
  assert.equal(result.execution_result?.data?.tasks?.[0]?.task_state, "done");

  const snapshot = await getLatestPlannerTaskLifecycleSnapshot();
  assert.deepEqual(snapshot?.tasks?.map((task) => task.task_state), ["done", "planned"]);
});

test("follow-up turn can read single targeted task owner and deadline", async () => {
  resetPlannerRuntimeContext();
  replacePlannerTaskLifecycleStoreForTests({
    tasks: {
      task_single_read_a: {
        id: "task_single_read_a",
        scope_key: "scope_single_read",
        title: "跟進 Alice",
        theme: "okr",
        owner: "Alice",
        deadline: "2026-03-28",
        task_state: "planned",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
      task_single_read_b: {
        id: "task_single_read_b",
        scope_key: "scope_single_read",
        title: "跟進 Bob",
        theme: "okr",
        owner: "Bob",
        deadline: "2026-03-29",
        task_state: "in_progress",
        progress_status: "started",
        progress_summary: "已開始",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    scopes: {
      scope_single_read: {
        scope_key: "scope_single_read",
        theme: "okr",
        selected_action: "search_and_detail_doc",
        user_intent: "整理 OKR 文件",
        trace_id: "trace_single_read",
        source_kind: "search_and_detail",
        source_doc_id: "doc_single_read",
        source_title: "OKR Weekly Review",
        current_task_ids: ["task_single_read_a", "task_single_read_b"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    latest_scope_key: "scope_single_read",
  });

  const ownerRead = await runPlannerToolFlow({
    userIntent: "第一個誰負責？",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });

  assert.equal(ownerRead.selected_action, "read_task_lifecycle_v1");
  assert.equal(ownerRead.execution_result?.data?.query_type, "owner");
  assert.equal(ownerRead.execution_result?.data?.target_mode, "single");
  assert.equal(ownerRead.execution_result?.formatted_output?.content_summary, "task「跟進 Alice」目前負責人：Alice。");

  const deadlineRead = await runPlannerToolFlow({
    userIntent: "Bob 的 task 何時到期？",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });

  assert.equal(deadlineRead.selected_action, "read_task_lifecycle_v1");
  assert.equal(deadlineRead.execution_result?.data?.query_type, "deadline");
  assert.equal(deadlineRead.execution_result?.data?.target_mode, "single");
  assert.equal(deadlineRead.execution_result?.data?.target_reason, "owner");
  assert.equal(deadlineRead.execution_result?.data?.tasks?.[0]?.owner, "Bob");
  assert.equal(deadlineRead.execution_result?.formatted_output?.content_summary, "task「跟進 Bob」目前到期時間：2026-03-29。");
});

test("follow-up turn can persist execution progress, blocker note, and completion result", async () => {
  resetPlannerRuntimeContext();
  replacePlannerTaskLifecycleStoreForTests({
    tasks: {
      task_exec_1: {
        id: "task_exec_1",
        scope_key: "scope_exec_v1",
        title: "跟進報價單",
        theme: "bd",
        owner: "Alice",
        deadline: "2026-03-28",
        task_state: "planned",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    scopes: {
      scope_exec_v1: {
        scope_key: "scope_exec_v1",
        theme: "bd",
        selected_action: "search_and_detail_doc",
        user_intent: "整理 BD 文件",
        trace_id: "trace_exec_v1",
        source_kind: "search_and_detail",
        source_doc_id: "doc_exec_v1",
        source_title: "BD Execution Board",
        current_task_ids: ["task_exec_1"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    latest_scope_key: "scope_exec_v1",
  });

  const halfDone = await runPlannerToolFlow({
    userIntent: "第一個完成一半了",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });

  assert.equal(halfDone.selected_action, "update_task_lifecycle_v1");
  assert.equal(halfDone.execution_result?.data?.updated_count, 1);
  assert.equal(halfDone.execution_result?.data?.tasks?.[0]?.task_state, "in_progress");
  assert.equal(halfDone.execution_result?.data?.tasks?.[0]?.progress_status, "half_done");
  assert.match(halfDone.execution_result?.formatted_output?.content_summary || "", /完成一半/);

  const blocked = await runPlannerToolFlow({
    userIntent: "第一個卡點：等法務確認",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });

  assert.equal(blocked.selected_action, "update_task_lifecycle_v1");
  assert.equal(blocked.execution_result?.data?.updated_count, 1);
  assert.equal(blocked.execution_result?.data?.tasks?.[0]?.task_state, "blocked");
  assert.equal(blocked.execution_result?.data?.tasks?.[0]?.progress_status, "blocked");
  assert.equal(blocked.execution_result?.data?.tasks?.[0]?.note, "等法務確認");
  assert.match(blocked.execution_result?.formatted_output?.content_summary || "", /卡點：等法務確認/);

  const done = await runPlannerToolFlow({
    userIntent: "第一個完成了，結果是已寄出報價單，備註是等待客戶回簽",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });

  assert.equal(done.selected_action, "update_task_lifecycle_v1");
  assert.equal(done.execution_result?.data?.updated_count, 1);
  assert.equal(done.execution_result?.data?.tasks?.[0]?.task_state, "done");
  assert.equal(done.execution_result?.data?.tasks?.[0]?.progress_status, "completed");
  assert.equal(done.execution_result?.data?.tasks?.[0]?.result, "已寄出報價單");
  assert.equal(done.execution_result?.data?.tasks?.[0]?.note, "等待客戶回簽");
  assert.match(done.execution_result?.formatted_output?.content_summary || "", /result：已寄出報價單/);
  assert.match(done.execution_result?.formatted_output?.content_summary || "", /note：等待客戶回簽/);

  const status = await runPlannerToolFlow({
    userIntent: "第一個現在進度怎麼樣？",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });

  assert.equal(status.selected_action, "read_task_lifecycle_v1");
  assert.equal(status.execution_result?.data?.tasks?.[0]?.task_state, "done");
  assert.match(status.execution_result?.formatted_output?.content_summary || "", /已完成/);
  assert.match(status.execution_result?.formatted_output?.content_summary || "", /result：已寄出報價單/);
  assert.match(status.execution_result?.formatted_output?.content_summary || "", /note：等待客戶回簽/);

  const snapshot = await getLatestPlannerTaskLifecycleSnapshot();
  assert.equal(snapshot?.tasks?.[0]?.progress_status, "completed");
  assert.equal(snapshot?.tasks?.[0]?.result, "已寄出報價單");
  assert.equal(snapshot?.tasks?.[0]?.note, "等待客戶回簽");
  assert.equal(snapshot?.tasks?.[0]?.execution_history?.length, 3);
});

test("follow-up turn can read recorded result and note from execution store", async () => {
  resetPlannerRuntimeContext();
  replacePlannerTaskLifecycleStoreForTests({
    tasks: {
      task_exec_read_1: {
        id: "task_exec_read_1",
        scope_key: "scope_exec_read",
        title: "整理驗收回覆",
        theme: "delivery",
        owner: "CS Team",
        deadline: "2026-03-29",
        task_state: "done",
        progress_status: "completed",
        progress_summary: "已完成",
        result: "已同步客戶驗收結論",
        note: "待補正式會議紀錄",
        execution_started_at: "2026-03-20T00:00:00.000Z",
        last_progress_at: "2026-03-20T01:00:00.000Z",
        completed_at: "2026-03-20T01:00:00.000Z",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T01:00:00.000Z",
      },
    },
    scopes: {
      scope_exec_read: {
        scope_key: "scope_exec_read",
        theme: "delivery",
        selected_action: "search_and_detail_doc",
        user_intent: "整理交付文件",
        trace_id: "trace_exec_read",
        source_kind: "search_and_detail",
        source_doc_id: "doc_exec_read",
        source_title: "Delivery Follow-up",
        current_task_ids: ["task_exec_read_1"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T01:00:00.000Z",
      },
    },
    latest_scope_key: "scope_exec_read",
  });

  const resultRead = await runPlannerToolFlow({
    userIntent: "第一個的結果是什麼？",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });

  assert.equal(resultRead.selected_action, "read_task_lifecycle_v1");
  assert.equal(resultRead.execution_result?.data?.query_type, "result");
  assert.equal(resultRead.execution_result?.formatted_output?.content_summary, "task「整理驗收回覆」目前 result：已同步客戶驗收結論。");

  const noteRead = await runPlannerToolFlow({
    userIntent: "第一個的備註呢？",
    payload: {},
    logger: console,
    async dispatcher() {
      throw new Error("should_not_dispatch_doc_tool");
    },
  });

  assert.equal(noteRead.selected_action, "read_task_lifecycle_v1");
  assert.equal(noteRead.execution_result?.data?.query_type, "note");
  assert.equal(noteRead.execution_result?.formatted_output?.content_summary, "task「整理驗收回覆」目前 note：待補正式會議紀錄。");
});

test("runPlannerToolFlow extracts action layer fields for delivery mixed result", async () => {
  resetPlannerRuntimeContext();
  const result = await runPlannerToolFlow({
    userIntent: "整理 onboarding 流程",
    payload: { limit: 5 },
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [{ doc_id: "delivery_1", title: "Onboarding 流程" }],
            trace_id: "trace_delivery_search",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: { doc_id: "delivery_1", title: "Onboarding 流程" },
            trace_id: "trace_delivery_detail",
          },
        ],
        trace_id: "trace_delivery_detail",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return {
        title: "Onboarding 流程",
        content: "負責人：CS Team；截止：本週五；風險：帳號開通延遲；狀態：blocked。",
      };
    },
  });

  assert.deepEqual(result.execution_result?.formatted_output?.action_layer, {
    summary: "負責人：CS Team；截止：本週五；風險：帳號開通延遲；狀態：blocked。",
    next_actions: [
      "優先解除 交付卡點",
      "確認 owner",
      "確認 deadline",
    ],
    owner: "CS Team",
    deadline: "本週五",
    risks: ["帳號開通延遲"],
    status: "blocked",
  });
});

test("runPlannerToolFlow keeps OKR theme on pronoun follow-up", async () => {
  resetPlannerRuntimeContext();
  await runPlannerToolFlow({
    userIntent: "整理 OKR 文件",
    payload: { limit: 5 },
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [{ doc_id: "okr_theme_1", title: "OKR Weekly Review" }],
            trace_id: "trace_okr_theme_search",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: { doc_id: "okr_theme_1", title: "OKR Weekly Review" },
            trace_id: "trace_okr_theme_detail",
          },
        ],
        trace_id: "trace_okr_theme_detail",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return {
        title: "OKR Weekly Review",
        content: "owner: Alice; deadline: 2026-03-28; risks: 資料延遲。",
      };
    },
  });

  const debugEvents = [];
  const result = await runPlannerToolFlow({
    userIntent: "這份文件裡面寫了什麼",
    payload: {},
    logger: {
      debug(label, event) {
        debugEvents.push({ label, event });
      },
      info() {},
      warn() {},
    },
    async dispatcher({ action, payload }) {
      assert.equal(action, "get_company_brain_doc_detail");
      assert.equal(payload.doc_id, "okr_theme_1");
      return {
        ok: true,
        action: "company_brain_doc_detail",
        item: { doc_id: "okr_theme_1", title: "OKR Weekly Review" },
        trace_id: "trace_okr_followup",
      };
    },
    async contentReader() {
      return {
        title: "OKR Weekly Review",
        content: "owner: Alice; deadline: 2026-03-28; risks: 資料延遲。",
      };
    },
  });

  assert.equal(result.execution_result?.formatted_output?.action_layer?.owner, "Alice");
  assert.equal(result.execution_result?.formatted_output?.action_layer?.deadline, "2026-03-28");
  assert.deepEqual(result.execution_result?.formatted_output?.action_layer?.risks, ["資料延遲"]);
  assert.equal(result.execution_result?.formatted_output?.action_layer?.next_actions?.[0], "確認 OKR後續跟進事項");
  const routeEvent = debugEvents.find((item) => item.label === "planner_okr_flow" && item.event?.event_type === "okr_route");
  assert.equal(routeEvent?.event?.tool, "get_company_brain_doc_detail");
});

test("runPlannerToolFlow keeps BD theme on pronoun follow-up", async () => {
  resetPlannerRuntimeContext();
  await runPlannerToolFlow({
    userIntent: "整理 BD 文件",
    payload: { limit: 5 },
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [{ doc_id: "bd_theme_1", title: "BD Playbook" }],
            trace_id: "trace_bd_theme_search",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: { doc_id: "bd_theme_1", title: "BD Playbook" },
            trace_id: "trace_bd_theme_detail",
          },
        ],
        trace_id: "trace_bd_theme_detail",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return {
        title: "BD Playbook",
        content: "負責人：Bob；截止：下週一；風險：客戶回覆延遲。",
      };
    },
  });

  const result = await runPlannerToolFlow({
    userIntent: "這份文件裡面寫了什麼",
    payload: {},
    logger: console,
    async dispatcher() {
      return {
        ok: true,
        action: "company_brain_doc_detail",
        item: { doc_id: "bd_theme_1", title: "BD Playbook" },
        trace_id: "trace_bd_followup",
      };
    },
    async contentReader() {
      return {
        title: "BD Playbook",
        content: "負責人：Bob；截止：下週一；風險：客戶回覆延遲。",
      };
    },
  });

  assert.equal(result.execution_result?.formatted_output?.action_layer?.owner, "Bob");
  assert.equal(result.execution_result?.formatted_output?.action_layer?.deadline, "下週一");
  assert.deepEqual(result.execution_result?.formatted_output?.action_layer?.risks, ["客戶回覆延遲"]);
  assert.equal(result.execution_result?.formatted_output?.action_layer?.next_actions?.[0], "確認 BD後續跟進事項");
});

test("runPlannerToolFlow keeps delivery theme on pronoun follow-up", async () => {
  resetPlannerRuntimeContext();
  await runPlannerToolFlow({
    userIntent: "整理 onboarding 流程",
    payload: { limit: 5 },
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
          { action: "get_company_brain_doc_detail" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [{ doc_id: "delivery_theme_1", title: "Onboarding 流程" }],
            trace_id: "trace_delivery_theme_search",
          },
          {
            ok: true,
            action: "company_brain_doc_detail",
            item: { doc_id: "delivery_theme_1", title: "Onboarding 流程" },
            trace_id: "trace_delivery_theme_detail",
          },
        ],
        trace_id: "trace_delivery_theme_detail",
        stopped: false,
        stopped_at_step: null,
      };
    },
    async contentReader() {
      return {
        title: "Onboarding 流程",
        content: "owner: CS Team; deadline: 本週五; risks: 帳號開通延遲。",
      };
    },
  });

  const result = await runPlannerToolFlow({
    userIntent: "這份文件裡面寫了什麼",
    payload: {},
    logger: console,
    async dispatcher() {
      return {
        ok: true,
        action: "company_brain_doc_detail",
        item: { doc_id: "delivery_theme_1", title: "Onboarding 流程" },
        trace_id: "trace_delivery_followup",
      };
    },
    async contentReader() {
      return {
        title: "Onboarding 流程",
        content: "owner: CS Team; deadline: 本週五; risks: 帳號開通延遲。",
      };
    },
  });

  assert.equal(result.execution_result?.formatted_output?.action_layer?.owner, "CS Team");
  assert.equal(result.execution_result?.formatted_output?.action_layer?.deadline, "本週五");
  assert.deepEqual(result.execution_result?.formatted_output?.action_layer?.risks, ["帳號開通延遲"]);
  assert.equal(result.execution_result?.formatted_output?.action_layer?.next_actions?.[0], "確認 交付後續跟進事項");
});

for (const scenario of [
  {
    label: "OKR",
    seedQuery: "整理 OKR 文件",
    seedDocId: "okr_compact_1",
    seedTitle: "OKR Weekly Review",
    seedContent: "owner: Alice; deadline: 2026-03-28; risks: 資料延遲。",
    expectedOwner: "Alice",
    expectedNextAction: "確認 OKR後續跟進事項",
  },
  {
    label: "BD",
    seedQuery: "整理 BD 文件",
    seedDocId: "bd_compact_1",
    seedTitle: "BD Playbook",
    seedContent: "負責人：Bob；截止：下週一；風險：客戶回覆延遲。",
    expectedOwner: "Bob",
    expectedNextAction: "確認 BD後續跟進事項",
  },
  {
    label: "delivery",
    seedQuery: "整理 onboarding 流程",
    seedDocId: "delivery_compact_1",
    seedTitle: "Onboarding 流程",
    seedContent: "owner: CS Team; deadline: 本週五; risks: 帳號開通延遲。",
    expectedOwner: "CS Team",
    expectedNextAction: "確認 交付後續跟進事項",
  },
]) {
  test(`compact keeps ${scenario.label} theme for pronoun follow-up`, async () => {
    resetPlannerRuntimeContext();
    await runPlannerToolFlow({
      userIntent: scenario.seedQuery,
      payload: { limit: 5 },
      logger: console,
      async presetRunner() {
        return {
          ok: true,
          preset: "search_and_detail_doc",
          steps: [
            { action: "search_company_brain_docs" },
            { action: "get_company_brain_doc_detail" },
          ],
          results: [
            {
              ok: true,
              action: "company_brain_docs_search",
              items: [{ doc_id: scenario.seedDocId, title: scenario.seedTitle }],
              trace_id: `trace_${scenario.label}_compact_search`,
            },
            {
              ok: true,
              action: "company_brain_doc_detail",
              item: { doc_id: scenario.seedDocId, title: scenario.seedTitle },
              trace_id: `trace_${scenario.label}_compact_detail`,
            },
          ],
          trace_id: `trace_${scenario.label}_compact_detail`,
          stopped: false,
          stopped_at_step: null,
        };
      },
      async contentReader() {
        return {
          title: scenario.seedTitle,
          content: scenario.seedContent,
        };
      },
    });

    const summary = compactPlannerConversationMemory({
      latestSelectedAction: "search_and_detail_doc",
      reason: `test_${scenario.label}_theme_compact`,
    });
    assert.equal(summary?.active_theme, scenario.label === "delivery" ? "delivery" : scenario.label.toLowerCase());

    resetPlannerDocQueryRuntimeContext();
    assert.equal(getPlannerDocQueryContext().activeTheme, null);

    const result = await runPlannerToolFlow({
      userIntent: "這份文件裡面寫了什麼",
      payload: {},
      logger: console,
      async dispatcher({ action, payload }) {
        assert.equal(action, "get_company_brain_doc_detail");
        assert.equal(payload.doc_id, scenario.seedDocId);
        return {
          ok: true,
          action: "company_brain_doc_detail",
          item: { doc_id: scenario.seedDocId, title: scenario.seedTitle },
          trace_id: `trace_${scenario.label}_compact_followup`,
        };
      },
      async contentReader() {
        return {
          title: scenario.seedTitle,
          content: scenario.seedContent,
        };
      },
    });

    assert.equal(result.execution_result?.formatted_output?.action_layer?.owner, scenario.expectedOwner);
    assert.equal(result.execution_result?.formatted_output?.action_layer?.next_actions?.[0], scenario.expectedNextAction);
    assert.equal(getPlannerDocQueryContext().activeTheme, scenario.label === "delivery" ? "delivery" : scenario.label.toLowerCase());
    resetPlannerRuntimeContext();
  });
}

test("runPlannerToolFlow reuses active candidates so ordinal follow-up hits detail", async () => {
  resetPlannerRuntimeContext();
  const dispatcherCalls = [];

  const first = await runPlannerToolFlow({
    userIntent: "幫我查 BD 文件並整理重點",
    payload: { limit: 10 },
    logger: console,
    async presetRunner() {
      return {
        ok: true,
        preset: "search_and_detail_doc",
        steps: [
          { action: "search_company_brain_docs" },
        ],
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [
              { doc_id: "doc_bd_1", title: "BD Playbook" },
              { doc_id: "doc_bd_2", title: "BD SOP" },
            ],
            trace_id: "trace_candidates_seed",
          },
        ],
        trace_id: "trace_candidates_seed",
        stopped: false,
        stopped_at_step: null,
      };
    },
  });

  const second = await runPlannerToolFlow({
    userIntent: "打開第一個",
    payload: {},
    logger: console,
    async dispatcher({ action, payload }) {
      dispatcherCalls.push({ action, payload });
      return {
        ok: true,
        action: "company_brain_doc_detail",
        item: { doc_id: payload.doc_id, title: "BD Playbook" },
        trace_id: "trace_followup_detail",
      };
    },
  });

  assert.equal(first.execution_result?.formatted_output?.kind, "search_and_detail_candidates");
  assert.equal(second.selected_action, "get_company_brain_doc_detail");
  assert.deepEqual(dispatcherCalls, [{
    action: "get_company_brain_doc_detail",
    payload: {
      doc_id: "doc_bd_1",
      query: "打開第一個",
    },
  }]);
  resetPlannerRuntimeContext();
});

test("selectPlannerTool prefers preset for compound create-and-list intent", async () => {
  const { selectPlannerTool } = await import("../src/executive-planner.mjs");
  const result = selectPlannerTool({
    userIntent: "建立文件後列出知識庫",
    taskType: "",
    logger: console,
  });

  assert.equal(result.selected_action, "create_and_list_doc");
  assert.equal(result.reason, "命中複合任務，優先使用 preset。");
});

test("selectPlannerTool prefers create_search_detail_list_doc for compound create-and-search intent", async () => {
  const { selectPlannerTool } = await import("../src/executive-planner.mjs");
  const result = selectPlannerTool({
    userIntent: "建立文件並查詢",
    taskType: "",
    logger: console,
  });

  assert.equal(result.selected_action, "create_search_detail_list_doc");
  assert.equal(result.reason, "命中完整流程任務，使用 demo preset。");
});

test("runPlannerToolFlow executes preset runner when selection returns preset", async () => {
  let dispatcherCalled = false;
  let presetCalled = false;
  const result = await runPlannerToolFlow({
    userIntent: "create doc then list docs",
    payload: { title: "demo", folder_token: "folder_123", limit: 5 },
    logger: console,
    async dispatcher() {
      dispatcherCalled = true;
      return { ok: true, trace_id: "unexpected_dispatch" };
    },
    async presetRunner({ preset, input }) {
      presetCalled = true;
      assert.equal(preset, "create_and_list_doc");
      assert.deepEqual(input, { title: "demo", folder_token: "folder_123", limit: 5 });
      return {
        ok: true,
        preset,
        steps: [
          { action: "create_doc" },
          { action: "list_company_brain_docs" },
        ],
        results: [
          { ok: true, action: "create_doc", trace_id: "trace_create" },
          { ok: true, action: "list_company_brain_docs", trace_id: "trace_list" },
        ],
        trace_id: "trace_list",
      };
    },
  });

  assert.equal(result.selected_action, "create_and_list_doc");
  assert.equal(result.trace_id, "trace_list");
  assert.equal(result.execution_result?.ok, true);
  assert.equal(result.execution_result?.preset, "create_and_list_doc");
  assert.equal(presetCalled, true);
  assert.equal(dispatcherCalled, false);
});

test("runPlannerMultiStep dispatches steps in order and returns last trace id", async () => {
  const calls = [];
  const result = await runPlannerMultiStep({
    steps: [
      { action: "create_doc", payload: { title: "one" } },
      { action: "list_company_brain_docs", payload: { limit: 10 } },
    ],
    logger: console,
    async dispatcher({ action, payload }) {
      calls.push({ action, payload });
      return {
        ok: true,
        action,
        data: { echoed: payload },
        trace_id: action === "create_doc" ? "trace_step_1" : "trace_step_2",
      };
    },
  });

  assert.deepEqual(result.steps, [
    { action: "create_doc" },
    { action: "list_company_brain_docs" },
  ]);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].action, "create_doc");
  assert.equal(result.results[1].action, "list_company_brain_docs");
  assert.equal(result.trace_id, "trace_step_2");
  assert.deepEqual(calls, [
    { action: "create_doc", payload: { title: "one" } },
    { action: "list_company_brain_docs", payload: { limit: 10 } },
  ]);
});

test("runPlannerMultiStep ignores invalid steps and keeps null trace when nothing runs", async () => {
  let dispatcherCalled = false;
  const result = await runPlannerMultiStep({
    steps: [{}, { action: "" }, null],
    logger: console,
    async dispatcher() {
      dispatcherCalled = true;
      return { ok: true, trace_id: "unexpected" };
    },
  });

  assert.deepEqual(result.steps, []);
  assert.deepEqual(result.results, []);
  assert.equal(result.trace_id, null);
  assert.equal(dispatcherCalled, false);
});

test("executePlannedUserInput runs multi-step decisions through sequential tool dispatch", async () => {
  const calls = [];
  const result = await executePlannedUserInput({
    text: "先建立文件再列出文件",
    logger: console,
    async requester() {
      return JSON.stringify({
        steps: [
          {
            action: "create_doc",
            params: {
              title: "demo",
            },
          },
          {
            action: "list_company_brain_docs",
            params: {
              limit: 2,
            },
          },
        ],
      });
    },
    async dispatcher({ action, payload }) {
      calls.push({ action, payload });
      return {
        ok: true,
        action,
        data: { echoed: payload },
        trace_id: action === "create_doc" ? "trace_create" : "trace_list",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.steps, [
    {
      action: "create_doc",
      params: {
        title: "demo",
      },
    },
    {
      action: "list_company_brain_docs",
      params: {
        limit: 2,
      },
    },
  ]);
  assert.equal(result.error, null);
  assert.equal(result.trace_id, "trace_list");
  assert.equal(result.execution_result?.ok, true);
  assert.equal(result.execution_result?.stopped, false);
  assert.equal(result.execution_result?.results.length, 2);
  assert.deepEqual(calls, [
    {
      action: "create_doc",
      payload: {
        title: "demo",
      },
    },
    {
      action: "list_company_brain_docs",
      payload: {
        limit: 2,
      },
    },
  ]);
});

test("executePlannedUserInput stops multi-step execution on middle failure and returns error", async () => {
  const calls = [];
  const result = await executePlannedUserInput({
    text: "先建立文件再查詢最後列出",
    logger: console,
    async requester() {
      return JSON.stringify({
        steps: [
          {
            action: "create_doc",
            params: {
              title: "demo",
            },
          },
          {
            action: "search_company_brain_docs",
            params: {
              q: "demo",
            },
          },
          {
            action: "list_company_brain_docs",
            params: {
              limit: 5,
            },
          },
        ],
      });
    },
    async dispatcher({ action, payload }) {
      calls.push({ action, payload });
      if (action === "search_company_brain_docs") {
        return {
          ok: false,
          action,
          error: "tool_error",
          data: {
            stopped: true,
            stop_reason: "tool_error",
          },
          trace_id: "trace_search_fail",
        };
      }
      return {
        ok: true,
        action,
        data: { echoed: payload },
        trace_id: "trace_create",
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "tool_error");
  assert.equal(result.trace_id, "trace_search_fail");
  assert.equal(result.execution_result?.ok, false);
  assert.equal(result.execution_result?.stopped, true);
  assert.equal(result.execution_result?.stopped_at_step, 1);
  assert.equal(result.execution_result?.error, "tool_error");
  assert.equal(result.execution_result?.results.length, 2);
  assert.deepEqual(calls, [
    {
      action: "create_doc",
      payload: {
        title: "demo",
      },
    },
    {
      action: "search_company_brain_docs",
      payload: {
        q: "demo",
      },
    },
  ]);
});

test("runPlannerPreset builds create_and_list_doc steps and returns preset output", async () => {
  const calls = [];
  const result = await runPlannerPreset({
    preset: "create_and_list_doc",
    input: {
      title: "demo",
      folder_token: "folder_123",
      limit: 5,
    },
    logger: console,
    async multiStepRunner({ steps }) {
      calls.push(...steps);
      const action = steps[0]?.action;
      return {
        steps: steps.map((step) => ({ action: step.action })),
        results: [
          action === "create_doc"
            ? { ok: true, action: "create_doc", trace_id: "trace_create" }
            : { ok: true, action: "list_company_brain_docs", trace_id: "trace_list" },
        ],
        trace_id: action === "create_doc" ? "trace_create" : "trace_list",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.preset, "create_and_list_doc");
  assert.equal(result.stopped, false);
  assert.equal(result.stopped_at_step, null);
  assert.deepEqual(result.steps, [
    { action: "create_doc" },
    { action: "list_company_brain_docs" },
  ]);
  assert.equal(result.results.length, 2);
  assert.equal(result.trace_id, "trace_list");
  assert.deepEqual(calls, [
    {
      action: "create_doc",
      payload: {
        title: "demo",
        folder_token: "folder_123",
      },
    },
    {
      action: "list_company_brain_docs",
      payload: {
        limit: 5,
      },
    },
  ]);
});

test("runPlannerPreset returns ok=false when any step fails", async () => {
  const calls = [];
  const result = await runPlannerPreset({
    preset: "create_and_list_doc",
    input: {
      title: "demo",
      folder_token: "folder_123",
      limit: 5,
    },
    logger: console,
    async multiStepRunner({ steps }) {
      calls.push(...steps);
      return {
        steps: steps.map((step) => ({ action: step.action })),
        results: [
          steps[0]?.action === "create_doc"
            ? { ok: true, action: "create_doc", trace_id: "trace_create" }
            : { ok: false, action: "list_company_brain_docs", trace_id: "trace_list" },
        ],
        trace_id: steps[0]?.action === "create_doc" ? "trace_create" : "trace_list",
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.trace_id, "trace_list");
  assert.equal(result.stopped, true);
  assert.equal(result.stopped_at_step, 1);
  assert.deepEqual(calls, [
    {
      action: "create_doc",
      payload: {
        title: "demo",
        folder_token: "folder_123",
      },
    },
    {
      action: "list_company_brain_docs",
      payload: {
        limit: 5,
      },
    },
  ]);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
});

test("runPlannerPreset continues when stop_on_error is false", async () => {
  const calls = [];
  const result = await runPlannerPreset({
    preset: "create_and_list_doc",
    input: {
      title: "demo",
      folder_token: "folder_123",
      limit: 5,
    },
    logger: console,
    stop_on_error: false,
    async multiStepRunner({ steps }) {
      calls.push(...steps);
      return {
        steps: steps.map((step) => ({ action: step.action })),
        results: [
          { ok: false, action: "create_doc", trace_id: "trace_create" },
          { ok: true, action: "list_company_brain_docs", trace_id: "trace_list" },
        ],
        trace_id: "trace_list",
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stopped, false);
  assert.equal(result.stopped_at_step, null);
  assert.equal(result.results.length, 2);
  assert.deepEqual(calls, [
    {
      action: "create_doc",
      payload: {
        title: "demo",
        folder_token: "folder_123",
      },
    },
    {
      action: "list_company_brain_docs",
      payload: {
        limit: 5,
      },
    },
  ]);
});

test("runPlannerPreset builds runtime_and_list_docs steps and returns preset output", async () => {
  const calls = [];
  const result = await runPlannerPreset({
    preset: "runtime_and_list_docs",
    input: {
      limit: 3,
    },
    logger: console,
    async multiStepRunner({ steps }) {
      calls.push(...steps);
      const action = steps[0]?.action;
      return {
        steps: steps.map((step) => ({ action: step.action })),
        results: [
          action === "get_runtime_info"
            ? { ok: true, action: "get_runtime_info", trace_id: "trace_runtime" }
            : { ok: true, action: "list_company_brain_docs", trace_id: "trace_list" },
        ],
        trace_id: action === "get_runtime_info" ? "trace_runtime" : "trace_list",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.preset, "runtime_and_list_docs");
  assert.equal(result.stopped, false);
  assert.equal(result.stopped_at_step, null);
  assert.deepEqual(result.steps, [
    { action: "get_runtime_info" },
    { action: "list_company_brain_docs" },
  ]);
  assert.equal(result.results.length, 2);
  assert.equal(result.trace_id, "trace_list");
  assert.deepEqual(calls, [
    {
      action: "get_runtime_info",
      payload: {},
    },
    {
      action: "list_company_brain_docs",
      payload: {
        limit: 3,
      },
    },
  ]);
});

test("runPlannerPreset builds search_and_detail_doc steps and returns preset output", async () => {
  const calls = [];
  const result = await runPlannerPreset({
    preset: "search_and_detail_doc",
    input: {
      q: "Planner",
      doc_id: "doc_123",
      limit: 3,
    },
    logger: console,
    async multiStepRunner({ steps }) {
      calls.push(...steps);
      const action = steps[0]?.action;
      return {
        steps: steps.map((step) => ({ action: step.action })),
        results: [
          action === "search_company_brain_docs"
            ? { ok: true, action: "search_company_brain_docs", trace_id: "trace_search" }
            : { ok: true, action: "get_company_brain_doc_detail", trace_id: "trace_detail" },
        ],
        trace_id: action === "search_company_brain_docs" ? "trace_search" : "trace_detail",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.preset, "search_and_detail_doc");
  assert.equal(result.stopped, false);
  assert.equal(result.stopped_at_step, null);
  assert.deepEqual(result.steps, [
    { action: "search_company_brain_docs" },
    { action: "get_company_brain_doc_detail" },
  ]);
  assert.equal(result.results.length, 2);
  assert.equal(result.trace_id, "trace_detail");
  assert.deepEqual(calls, [
    {
      action: "search_company_brain_docs",
      payload: {
        q: "Planner",
        limit: 3,
      },
    },
    {
      action: "get_company_brain_doc_detail",
      payload: {
        doc_id: "doc_123",
      },
    },
  ]);
});

test("runPlannerPreset keeps only search step when search_and_detail_doc returns no matches", async () => {
  const calls = [];
  const result = await runPlannerPreset({
    preset: "search_and_detail_doc",
    input: {
      q: "missing",
      limit: 3,
    },
    logger: console,
    async multiStepRunner({ steps }) {
      calls.push(...steps);
      return {
        steps: steps.map((step) => ({ action: step.action })),
        results: [
          { ok: true, action: "company_brain_docs_search", items: [], trace_id: "trace_search_missing" },
        ],
        trace_id: "trace_search_missing",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.stopped, false);
  assert.equal(result.stopped_at_step, null);
  assert.deepEqual(result.steps, [
    { action: "search_company_brain_docs" },
  ]);
  assert.equal(result.results.length, 1);
  assert.deepEqual(calls, [
    {
      action: "search_company_brain_docs",
      payload: {
        q: "missing",
        limit: 3,
      },
    },
  ]);
});

test("runPlannerPreset keeps only search step when search_and_detail_doc returns multiple matches", async () => {
  const calls = [];
  const result = await runPlannerPreset({
    preset: "search_and_detail_doc",
    input: {
      q: "Planner",
      limit: 3,
    },
    logger: console,
    async multiStepRunner({ steps }) {
      calls.push(...steps);
      return {
        steps: steps.map((step) => ({ action: step.action })),
        results: [
          {
            ok: true,
            action: "company_brain_docs_search",
            items: [
              { doc_id: "doc_1", title: "Planner A" },
              { doc_id: "doc_2", title: "Planner B" },
            ],
            trace_id: "trace_search_many",
          },
        ],
        trace_id: "trace_search_many",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.stopped, false);
  assert.equal(result.stopped_at_step, null);
  assert.deepEqual(result.steps, [
    { action: "search_company_brain_docs" },
  ]);
  assert.equal(result.results.length, 1);
  assert.deepEqual(calls, [
    {
      action: "search_company_brain_docs",
      payload: {
        q: "Planner",
        limit: 3,
      },
    },
  ]);
});

test("runPlannerPreset builds create_search_detail_list_doc steps and returns preset output", async () => {
  const calls = [];
  const result = await runPlannerPreset({
    preset: "create_search_detail_list_doc",
    input: {
      title: "demo",
      folder_token: "folder_123",
      q: "Planner",
      doc_id: "doc_123",
      limit: 3,
    },
    logger: console,
    async multiStepRunner({ steps }) {
      calls.push(...steps);
      const action = steps[0]?.action;
      return {
        steps: steps.map((step) => ({ action: step.action })),
        results: [
          action === "create_doc"
            ? { ok: true, action: "create_doc", trace_id: "trace_create" }
            : action === "search_company_brain_docs"
              ? { ok: true, action: "company_brain_docs_search", items: [{ doc_id: "doc_123" }], trace_id: "trace_search" }
              : action === "get_company_brain_doc_detail"
                ? { ok: true, action: "company_brain_doc_detail", trace_id: "trace_detail" }
                : { ok: true, action: "list_company_brain_docs", trace_id: "trace_list" },
        ],
        trace_id: action === "create_doc"
          ? "trace_create"
          : action === "search_company_brain_docs"
            ? "trace_search"
            : action === "get_company_brain_doc_detail"
              ? "trace_detail"
              : "trace_list",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.preset, "create_search_detail_list_doc");
  assert.equal(result.stopped, false);
  assert.equal(result.stopped_at_step, null);
  assert.deepEqual(result.steps, [
    { action: "create_doc" },
    { action: "search_company_brain_docs" },
    { action: "get_company_brain_doc_detail" },
    { action: "list_company_brain_docs" },
  ]);
  assert.equal(result.results.length, 4);
  assert.equal(result.trace_id, "trace_list");
  assert.deepEqual(calls, [
    {
      action: "create_doc",
      payload: {
        title: "demo",
        folder_token: "folder_123",
      },
    },
    {
      action: "search_company_brain_docs",
      payload: {
        q: "Planner",
        limit: 3,
      },
    },
    {
      action: "get_company_brain_doc_detail",
      payload: {
        doc_id: "doc_123",
      },
    },
    {
      action: "list_company_brain_docs",
      payload: {
        limit: 3,
      },
    },
  ]);
});

test("runPlannerPreset keeps create_search_detail_list_doc at search step when search returns no results", async () => {
  const calls = [];
  const result = await runPlannerPreset({
    preset: "create_search_detail_list_doc",
    input: {
      title: "demo",
      folder_token: "folder_123",
      q: "missing",
      limit: 3,
    },
    logger: console,
    async multiStepRunner({ steps }) {
      calls.push(...steps);
      const action = steps[0]?.action;
      return {
        steps: steps.map((step) => ({ action: step.action })),
        results: [
          action === "create_doc"
            ? { ok: true, action: "create_doc", trace_id: "trace_create" }
            : { ok: true, action: "company_brain_docs_search", items: [], trace_id: "trace_search" },
        ],
        trace_id: action === "create_doc" ? "trace_create" : "trace_search",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.stopped, false);
  assert.equal(result.stopped_at_step, null);
  assert.equal(result.trace_id, "trace_search");
  assert.deepEqual(result.steps, [
    { action: "create_doc" },
    { action: "search_company_brain_docs" },
  ]);
  assert.equal(result.results.length, 2);
  assert.deepEqual(calls, [
    {
      action: "create_doc",
      payload: {
        title: "demo",
        folder_token: "folder_123",
      },
    },
    {
      action: "search_company_brain_docs",
      payload: {
        q: "missing",
        limit: 3,
      },
    },
  ]);
});
