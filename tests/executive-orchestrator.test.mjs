import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
import { setupExecutiveTaskStateTestHarness } from "./helpers/executive-task-state-harness.mjs";
import { FALLBACK_DISABLED } from "../src/planner-error-codes.mjs";

const testDb = await createTestDbHarness();
const {
  buildExecutiveBrief,
  buildSupportingContext,
  buildVisibleSupportingOutputs,
  buildVisibleWorkPlan,
  ensureDocRewriteWorkflowTask,
  executeExecutiveTurn,
  executeWorkItemsSequentially,
  finalizeDocRewriteWorkflowTask,
  markDocRewriteApplying,
  normalizeWorkPlan,
} = await import("../src/executive-orchestrator.mjs");
const {
  getActiveExecutiveTask,
  updateExecutiveTask,
} = await import("../src/executive-task-state.mjs");

setupExecutiveTaskStateTestHarness();

test.after(() => {
  testDb.close();
});

test("normalizeWorkPlan keeps at most three roles and reserves the merge agent slot", () => {
  const plan = normalizeWorkPlan(
    null,
    {
      primary_agent_id: "generalist",
      work_items: [
        { agent_id: "consult", task: "拆解問題" },
        { agent_id: "consult", task: "重複項目" },
        { agent_id: "product", task: "整理產品角度" },
        { agent_id: "tech", task: "整理技術風險" },
      ],
    },
    "原始任務",
  );

  assert.equal(plan.length, 3);
  assert.equal(plan[0].agent_id, "consult");
  assert.equal(plan[1].agent_id, "product");
  assert.equal(plan[2].agent_id, "generalist");
});

test("normalizeWorkPlan caps visible work items to three unique roles", () => {
  const plan = normalizeWorkPlan(
    null,
    {
      work_items: [
        { agent_id: "generalist", task: "主責收斂" },
        { agent_id: "consult", task: "拆解問題" },
        { agent_id: "tech", task: "檢查技術風險" },
        { agent_id: "product", task: "補充產品價值" },
      ],
    },
    "原始任務",
  );

  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((item) => item.agent_id), ["consult", "tech", "generalist"]);
});

test("buildSupportingContext formats agent outputs for synthesis", () => {
  const text = buildSupportingContext([
    { agent_id: "consult", task: "拆解問題", summary: "問題邊界已整理" },
    { agent_id: "product", task: "整理產品角度", summary: "產品價值已整理" },
  ]);

  assert.match(text, /\/consult/);
  assert.match(text, /問題邊界已整理/);
  assert.match(text, /\/product/);
});

test("buildVisibleWorkPlan formats readable task list", () => {
  const text = buildVisibleWorkPlan(
    [
      { agent_id: "generalist", task: "主責收斂", role: "primary", status: "pending" },
      { agent_id: "consult", task: "做方案比較", role: "supporting", status: "completed" },
    ],
    { primaryAgentId: "generalist" },
  );

  assert.match(text, /這輪分工/);
  assert.match(text, /主責 \/generalist｜待處理/);
  assert.match(text, /支援 \/consult｜已完成/);
});

test("buildVisibleSupportingOutputs formats readable agent summaries", () => {
  const text = buildVisibleSupportingOutputs([
    { agent_id: "consult", task: "做方案比較", summary: "已整理方案差異與風險" },
  ]);

  assert.match(text, /我另外參考了/);
  assert.match(text, /\/consult/);
  assert.match(text, /已整理方案差異與風險/);
});

test("buildExecutiveBrief combines header, task list, support summaries, and synthesis", () => {
  const text = buildExecutiveBrief({
    header: "我先把這題交給 /generalist 主責收斂，並同步參考 /consult 的補充。",
    workPlan: [
      { agent_id: "generalist", task: "主責收斂", role: "primary", status: "pending" },
      { agent_id: "consult", task: "做方案比較", role: "supporting", status: "completed" },
    ],
    primaryAgentId: "generalist",
    supportingOutputs: [
      { agent_id: "consult", task: "做方案比較", summary: "已整理方案差異與風險" },
    ],
    primaryReplyText: [
      "結論：先把模糊文檔拆成待確認與待改派兩類。",
      "",
      "重點：",
      "- 待確認項目先補 owner",
      "- 待確認項目先補 owner",
      "",
      "下一步：先補 owner，再決定要不要改派。",
      "",
      "來源",
      "- 文件 A｜https://example.com/a",
      "- 文件 B｜https://example.com/b",
    ].join("\n"),
  });

  assert.match(text, /^結論：/);
  assert.match(text, /待確認與待改派/);
  assert.match(text, /重點：/);
  assert.match(text, /參考來源：文件 A、文件 B/);
  assert.equal((text.match(/待確認項目先補 owner/g) || []).length, 1);
  assert.match(text, /下一步：/);
  assert.doesNotMatch(text, /這輪分工/);
  assert.doesNotMatch(text, /我另外參考了/);
  assert.doesNotMatch(text, /\/consult/);
});

test("buildExecutiveBrief drops JSON-like primary reply and leaked supporting summaries", () => {
  const text = buildExecutiveBrief({
    supportingOutputs: [
      { agent_id: "consult", task: "做方案比較", summary: "{\"answer\":\"這段不該直接出現\"}" },
      { agent_id: "product", task: "整理產品角度", summary: "先確認 owner 與 review 邊界。" },
    ],
    primaryReplyText: "```json\n{\"ok\":false,\"error\":\"tool_error\",\"details\":{\"message\":\"boom\"}}\n```",
  });

  assert.match(text, /^結論：/);
  assert.match(text, /先確認 owner 與 review 邊界/);
  assert.doesNotMatch(text, /```json|\"ok\"|\"error\"|tool_error|\{\"answer\"/);
});

test("executeWorkItemsSequentially runs specialists in order and merges into one final response", async () => {
  const calls = [];
  const result = await executeWorkItemsSequentially({
    accountId: "acct-1",
    requestText: "請整理結論",
    workPlan: [
      { agent_id: "consult", task: "拆解問題", role: "supporting" },
      { agent_id: "product", task: "整理產品角度", role: "supporting" },
      { agent_id: "generalist", task: "統一收斂", role: "primary" },
    ],
    async executeAgentFn({ agent, requestText, supportingContext = "" }) {
      calls.push({ agentId: agent.id, requestText, supportingContext });
      return { text: `${agent.id}:${requestText}` };
    },
  });

  assert.deepEqual(calls.map((item) => item.agentId), ["consult", "product", "generalist"]);
  assert.equal(calls[2].requestText, "請整理結論");
  assert.equal(calls[2].supportingContext.includes("/consult"), true);
  assert.equal(calls[2].supportingContext.includes("/product"), true);
  assert.equal(result.reply?.text, "generalist:請整理結論");
  assert.equal(result.supportingOutputs.length, 2);
  assert.equal(result.finalWorkPlan[0].status, "completed");
  assert.equal(result.finalWorkPlan[2].agent_id, "generalist");
});

test("executeWorkItemsSequentially preserves generalist fallback when a specialist fails", async () => {
  const calls = [];
  const result = await executeWorkItemsSequentially({
    accountId: "acct-1",
    requestText: "請收斂結果",
    mergeAgentId: "ceo",
    workPlan: [
      { agent_id: "consult", task: "拆解問題", role: "supporting" },
      { agent_id: "ceo", task: "統一收斂", role: "primary" },
    ],
    async executeAgentFn({ agent, requestText }) {
      calls.push(agent.id);
      if (agent.id === "consult") {
        throw new Error("specialist_failed");
      }
      return { text: `${agent.id}:${requestText}` };
    },
  });

  assert.deepEqual(calls, ["consult", "generalist"]);
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.reply?.text, "generalist:統一收斂");
  assert.equal(result.finalWorkPlan[0].status, "failed");
  assert.equal(result.finalWorkPlan[1].agent_id, "generalist");
});

test("executeWorkItemsSequentially rejects raw and fenced JSON-like specialist replies", async () => {
  const result = await executeWorkItemsSequentially({
    accountId: "acct-1",
    requestText: "請收斂結果",
    workPlan: [
      { agent_id: "consult", task: "拆解問題", role: "supporting" },
      { agent_id: "product", task: "整理產品角度", role: "supporting" },
      { agent_id: "generalist", task: "統一收斂", role: "primary" },
    ],
    async executeAgentFn({ agent }) {
      if (agent.id === "consult") {
        return { text: "{\"answer\":\"這是一個 raw JSON object\"}" };
      }
      if (agent.id === "product") {
        return { text: "```json\n{\"answer\":\"這是一個 fenced JSON object\"}\n```" };
      }
      return { text: "結論：改由 /generalist 直接收斂。" };
    },
  });

  assert.equal(result.supportingOutputs.length, 0);
  assert.deepEqual(
    result.failedAgents.map((item) => item.error),
    ["rejected_json_object", "rejected_json_object_fenced"],
  );
  assert.equal(result.reply?.text, "結論：改由 /generalist 直接收斂。");
  assert.equal(result.finalWorkPlan[0].status, "failed");
  assert.equal(result.finalWorkPlan[1].status, "failed");
  assert.equal(result.finalWorkPlan[2].status, "completed");
});

test("executeWorkItemsSequentially rejects structured envelope merge reply and falls back to generalist", async () => {
  const calls = [];
  const result = await executeWorkItemsSequentially({
    accountId: "acct-1",
    requestText: "請收斂結果",
    mergeAgentId: "ceo",
    workPlan: [
      { agent_id: "consult", task: "拆解問題", role: "supporting" },
      { agent_id: "ceo", task: "統一收斂", role: "primary" },
    ],
    async executeAgentFn({ agent }) {
      calls.push(agent.id);
      if (agent.id === "consult") {
        return { text: "問題邊界已整理。" };
      }
      if (agent.id === "ceo") {
        return { text: "```json\n{\"ok\":false,\"error\":\"runtime_exception\",\"details\":{\"message\":\"bad merge\"}}\n```" };
      }
      return { text: "結論：改由 /generalist fail-soft 收斂。" };
    },
  });

  assert.deepEqual(calls, ["consult", "ceo", "generalist"]);
  assert.equal(result.reply?.text, "結論：改由 /generalist fail-soft 收斂。");
  assert.equal(result.mergeAgent?.id, "generalist");
});

test("executeWorkItemsSequentially keeps ordinary JSON string literal on the normal success path", async () => {
  const result = await executeWorkItemsSequentially({
    accountId: "acct-1",
    requestText: "請收斂結果",
    workPlan: [
      { agent_id: "consult", task: "拆解問題", role: "supporting" },
      { agent_id: "generalist", task: "統一收斂", role: "primary" },
    ],
    async executeAgentFn({ agent }) {
      if (agent.id === "consult") {
        return { text: "\"這是一段一般 JSON string literal 回答\"" };
      }
      return { text: "結論：已整合支援輸出。" };
    },
  });

  assert.equal(result.supportingOutputs.length, 1);
  assert.equal(result.supportingOutputs[0].summary, "\"這是一段一般 JSON string literal 回答\"");
  assert.equal(result.failedAgents.length, 0);
  assert.equal(result.reply?.text, "結論：已整合支援輸出。");
});

test("executeExecutiveTurn slash-command no-match reply is natural language instead of raw JSON", async () => {
  const result = await executeExecutiveTurn({
    accountId: "acct-executive-1",
    scope: {
      session_key: "session-executive-no-match",
      trace_id: "trace-executive-no-match",
    },
    event: {
      trace_id: "trace-executive-no-match",
      message: {
        content: JSON.stringify({
          text: "/knowledge unknown-subcommand 幫我看看",
        }),
      },
    },
  });

  assert.ok(result);
  assert.match(result.text, /^結論/m);
  assert.match(result.text, /registered agent|slash 指令/);
  assert.doesNotMatch(result.text, /ROUTING_NO_MATCH|registered_agent_command_no_match|\"ok\"|\"error\"|\"details\"/);
});

test("executeExecutiveTurn planner fallback-disabled reply is natural language and keeps structured fields", async () => {
  const result = await executeExecutiveTurn({
    accountId: "acct-executive-2",
    scope: {
      session_key: "session-executive-fallback-disabled",
      trace_id: "trace-executive-fallback-disabled",
    },
    event: {
      trace_id: "trace-executive-fallback-disabled",
      message: {
        content: JSON.stringify({
          text: "請多 agent 一起評估這題",
        }),
      },
    },
    async planExecutiveTurnFn() {
      return {
        error: FALLBACK_DISABLED,
        action: null,
        objective: "請多 agent 一起評估這題",
        primary_agent_id: "generalist",
        next_agent_id: "generalist",
        supporting_agent_ids: ["consult"],
        reason: "executive_planner_fallback_disabled",
        why: "LLM planner 沒有產出可用 JSON，而且 heuristic fallback 已被停用。",
        alternative: {
          action: "clarify",
          agent_id: "generalist",
          summary: "如需繼續，必須先提供更明確的 agent 指令或讓 planner 重新產生合法 JSON。",
        },
        pending_questions: [],
        work_items: [],
      };
    },
  });

  assert.ok(result);
  assert.match(result.text, /^答案/m);
  assert.match(result.text, /安全結果|executive planner|系統錯誤/);
  assert.doesNotMatch(result.text, /FALLBACK_DISABLED|executive_planner_fallback_disabled|\"ok\"|\"error\"|\"details\"/);
  assert.equal(result.error, FALLBACK_DISABLED);
  assert.deepEqual(result.details, {
    message: "executive_planner_fallback_disabled",
  });
  assert.deepEqual(result.context, {
    objective: "請多 agent 一起評估這題",
    primary_agent_id: "generalist",
    next_agent_id: "generalist",
    supporting_agent_ids: ["consult"],
    why: "LLM planner 沒有產出可用 JSON，而且 heuristic fallback 已被停用。",
    alternative: {
      action: "clarify",
      agent_id: "generalist",
      summary: "如需繼續，必須先提供更明確的 agent 指令或讓 planner 重新產生合法 JSON。",
    },
  });
});

test("truthful completion gate uses blocked tone when verifier fails", async () => {
  const result = await executeExecutiveTurn({
    accountId: "acct-executive-truthful-blocked",
    scope: {
      session_key: "session-executive-truthful-blocked",
      trace_id: "trace-executive-truthful-blocked",
    },
    event: {
      trace_id: "trace-executive-truthful-blocked",
      message: {
        chat_id: "chat-executive-truthful-blocked",
        content: JSON.stringify({
          text: "請多 agent 一起看這題",
        }),
      },
    },
    async planExecutiveTurnFn() {
      return {
        action: "start",
        objective: "請幫我收斂這題",
        primary_agent_id: "generalist",
        next_agent_id: "generalist",
        supporting_agent_ids: [],
        reason: "test",
        why: "test",
        alternative: null,
        pending_questions: [],
        work_items: [
          { agent_id: "generalist", task: "收斂", role: "primary", tool_required: true },
        ],
      };
    },
    async executeWorkItemsFn() {
      return {
        reply: { text: "先整理目前資訊。" },
        mergeAgent: { id: "generalist" },
        supportingOutputs: [],
        finalWorkPlan: [
          { agent_id: "generalist", task: "收斂", role: "primary", status: "completed", tool_required: true },
        ],
        failedAgents: [],
        fallbackUsed: false,
        dispatchedActions: [],
      };
    },
  });

  assert.equal(result?.verification?.pass, false);
  assert.equal(result?.verification?.fake_completion, false);
  assert.match(result?.text || "", /^答案/m);
  assert.match(result?.text || "", /目前狀態：blocked/);
  assert.doesNotMatch(result?.text || "", /已完成|已處理完/);
});

test("truthful completion gate uses escalated tone for fake_completion", async () => {
  const result = await executeExecutiveTurn({
    accountId: "acct-executive-truthful-escalated",
    scope: {
      session_key: "session-executive-truthful-escalated",
      trace_id: "trace-executive-truthful-escalated",
    },
    event: {
      trace_id: "trace-executive-truthful-escalated",
      message: {
        chat_id: "chat-executive-truthful-escalated",
        content: JSON.stringify({
          text: "請多 agent 一起看這題",
        }),
      },
    },
    async planExecutiveTurnFn() {
      return {
        action: "start",
        objective: "請幫我收斂這題",
        primary_agent_id: "generalist",
        next_agent_id: "generalist",
        supporting_agent_ids: [],
        reason: "test",
        why: "test",
        alternative: null,
        pending_questions: [],
        work_items: [
          { agent_id: "generalist", task: "收斂", role: "primary", tool_required: true },
        ],
      };
    },
    async executeWorkItemsFn() {
      return {
        reply: { text: "我已完成這輪整理。" },
        mergeAgent: { id: "generalist" },
        supportingOutputs: [],
        finalWorkPlan: [
          { agent_id: "generalist", task: "收斂", role: "primary", status: "completed", tool_required: true },
        ],
        failedAgents: [],
        fallbackUsed: false,
        dispatchedActions: [],
      };
    },
  });

  assert.equal(result?.verification?.pass, false);
  assert.equal(result?.verification?.fake_completion, true);
  assert.match(result?.text || "", /目前狀態：escalated/);
  assert.doesNotMatch(result?.text || "", /已完成|已處理完/);
});

test("truthful completion gate handles partial_completion without completed tone", async () => {
  const result = await executeExecutiveTurn({
    accountId: "acct-executive-truthful-partial",
    scope: {
      session_key: "session-executive-truthful-partial",
      trace_id: "trace-executive-truthful-partial",
    },
    event: {
      trace_id: "trace-executive-truthful-partial",
      message: {
        chat_id: "chat-executive-truthful-partial",
        content: JSON.stringify({
          text: "請多 agent 一起看這題",
        }),
      },
    },
    async planExecutiveTurnFn() {
      return {
        action: "start",
        objective: "請幫我收斂這題",
        primary_agent_id: "generalist",
        next_agent_id: "generalist",
        supporting_agent_ids: [],
        reason: "test",
        why: "test",
        alternative: null,
        pending_questions: [],
        work_items: [
          { agent_id: "generalist", task: "收斂", role: "primary" },
        ],
      };
    },
    async executeWorkItemsFn() {
      return {
        reply: { text: "先給你一版草稿。" },
        mergeAgent: { id: "generalist" },
        supportingOutputs: [],
        finalWorkPlan: [
          { agent_id: "generalist", task: "收斂", role: "primary", status: "completed" },
        ],
        failedAgents: [],
        fallbackUsed: false,
        dispatchedActions: [],
      };
    },
  });

  assert.equal(result?.verification?.pass, false);
  assert.equal(result?.verification?.partial_completion, true);
  assert.match(result?.text || "", /^答案/m);
  assert.match(result?.text || "", /^來源/m);
  assert.match(result?.text || "", /^待確認\/限制/m);
  assert.doesNotMatch(result?.text || "", /已完成|已處理完/);
});

test("workflow finalize fail-soft does not keep failed terminal state after verifier rejection", async () => {
  const scope = {
    session_key: `doc-rewrite-orchestrator-${Date.now()}`,
    trace_id: "trace-orchestrator-fail-soft",
  };
  const event = {
    trace_id: "trace-orchestrator-fail-soft",
    message: {
      chat_id: "chat-orchestrator-fail-soft",
      message_id: "msg-orchestrator-fail-soft",
    },
  };
  await ensureDocRewriteWorkflowTask({
    accountId: "acct-orchestrator-fail-soft",
    documentId: "doc-orchestrator-fail-soft",
    documentTitle: "規格草稿",
    scope,
    event,
    workflowState: "awaiting_review",
    routingHint: "doc_rewrite_review_pending",
  });
  await markDocRewriteApplying({
    accountId: "acct-orchestrator-fail-soft",
    scope,
    event,
    meta: {
      confirmation_id: "confirm-orchestrator-fail-soft",
    },
  });
  const applyingTask = await getActiveExecutiveTask("acct-orchestrator-fail-soft", scope.session_key);
  await updateExecutiveTask(applyingTask.id, {
    execution_journal: {
      tool_required: true,
      dispatched_actions: [],
      fallback_used: false,
      raw_evidence: [],
    },
  });
  const finalized = await finalizeDocRewriteWorkflowTask({
    accountId: "acct-orchestrator-fail-soft",
    scope,
    structuredResult: {
      patch_plan: [],
      structure_preserved: false,
      retry_count: 3,
      max_retries: 1,
    },
    extraEvidence: [
      { type: "file_updated", summary: "document:doc-orchestrator-fail-soft" },
    ],
  });

  assert.equal(finalized?.verification?.pass, false);
  assert.notEqual(finalized?.task?.lifecycle_state, "completed");
  assert.notEqual(finalized?.task?.status, "completed");
  assert.notEqual(finalized?.task?.lifecycle_state, "failed");
  assert.notEqual(finalized?.task?.status, "failed");
  assert.equal(finalized?.task?.lifecycle_state, "blocked");
  assert.equal(finalized?.task?.status, "blocked");
});
