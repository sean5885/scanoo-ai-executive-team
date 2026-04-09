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
    reloadPlannerConversationMemory,
    resetPlannerConversationMemory,
  },
] = await Promise.all([
  import("../src/executive-planner.mjs"),
  import("../src/planner-conversation-memory.mjs"),
]);

test.after(() => {
  testDb.close();
});

test("ellipsis follow-up reuses prior routing context (agent hint / skill memory) without fresh planning", async () => {
  const sessionKey = "wm-v1-ellipsis-skill";
  resetPlannerRuntimeContext({ sessionKey });
  applyPlannerWorkingMemoryPatch({
    sessionKey,
    source: "test_seed",
    patch: {
      current_goal: "整理 onboarding 文件重點",
      inferred_task_type: "skill_read",
      last_selected_agent: "doc_agent",
      last_selected_skill: "search_and_summarize",
      last_tool_result_summary: "已整理 onboarding 核心段落",
      unresolved_slots: [],
      next_best_action: "search_company_brain_docs",
      confidence: 0.91,
    },
  });

  let plannerRequested = false;
  let forcedAction = null;

  const result = await executePlannedUserInput({
    text: "繼續",
    sessionKey,
    async requester() {
      plannerRequested = true;
      return JSON.stringify({
        action: "list_company_brain_docs",
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
            answer: "沿用既有 skill 繼續完成。",
            sources: ["working memory"],
            limitations: [],
          },
        },
        trace_id: "trace-wm-ellipsis-skill",
      };
    },
  });

  assert.equal(plannerRequested, false);
  assert.equal(forcedAction, "search_company_brain_docs");
  assert.equal(result.action, "search_company_brain_docs");
  assert.equal(result.ok, true);
  resetPlannerRuntimeContext({ sessionKey });
});

test("same-task retry reuses previous action and avoids fresh planner generation", async () => {
  const sessionKey = "wm-v1-retry";
  resetPlannerRuntimeContext({ sessionKey });
  applyPlannerWorkingMemoryPatch({
    sessionKey,
    source: "test_seed",
    patch: {
      current_goal: "找出交付 SOP",
      inferred_task_type: "document_lookup",
      last_selected_agent: "doc_agent",
      last_selected_skill: null,
      last_tool_result_summary: "上輪已命中文件候選",
      unresolved_slots: [],
      next_best_action: "search_company_brain_docs",
      confidence: 0.84,
    },
  });

  let plannerRequested = false;
  let forcedAction = null;

  const result = await executePlannedUserInput({
    text: "再試一次",
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
            answer: "已重試同一路徑。",
            sources: ["working memory retry"],
            limitations: [],
          },
        },
        trace_id: "trace-wm-retry",
      };
    },
  });

  assert.equal(plannerRequested, false);
  assert.equal(forcedAction, "search_company_brain_docs");
  assert.equal(result.action, "search_company_brain_docs");
  assert.equal(result.ok, true);
  resetPlannerRuntimeContext({ sessionKey });
});

test("clear topic switch does not get polluted by old working memory", async () => {
  const sessionKey = "wm-v1-topic-switch";
  resetPlannerRuntimeContext({ sessionKey });
  applyPlannerWorkingMemoryPatch({
    sessionKey,
    source: "test_seed",
    patch: {
      current_goal: "整理文件內容",
      inferred_task_type: "document_lookup",
      last_selected_agent: "doc_agent",
      last_selected_skill: "document_summarize",
      last_tool_result_summary: "文件已摘要",
      unresolved_slots: [],
      next_best_action: "document_summarize",
      confidence: 0.92,
    },
  });

  let plannerRequested = false;
  let forcedAction = null;

  const result = await executePlannedUserInput({
    text: "改問 runtime pid 是多少",
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
            answer: "PID 目前可讀取。",
            sources: ["runtime"],
            limitations: [],
          },
        },
        trace_id: "trace-wm-topic-switch",
      };
    },
  });

  assert.equal(plannerRequested, true);
  assert.equal(forcedAction, "get_runtime_info");
  assert.equal(result.action, "get_runtime_info");
  resetPlannerRuntimeContext({ sessionKey });
});

test("unresolved slots influence next routing before selector fallback", async () => {
  const sessionKey = "wm-v1-unresolved-slots";
  resetPlannerRuntimeContext({ sessionKey });
  applyPlannerWorkingMemoryPatch({
    sessionKey,
    source: "test_seed",
    patch: {
      current_goal: "定位要讀的文件",
      inferred_task_type: "document_lookup",
      last_selected_agent: "doc_agent",
      last_selected_skill: null,
      last_tool_result_summary: "候選文件超過一份",
      unresolved_slots: ["candidate_selection_required"],
      next_best_action: "get_company_brain_doc_detail",
      confidence: 0.74,
    },
  });

  let dispatchAction = null;

  const result = await runPlannerToolFlow({
    userIntent: "繼續",
    payload: {},
    sessionKey,
    logger: console,
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
        trace_id: "trace-wm-unresolved",
      };
    },
  });

  assert.equal(dispatchAction, "search_company_brain_docs");
  assert.equal(result.selected_action, "search_company_brain_docs");
  resetPlannerRuntimeContext({ sessionKey });
});

test("missing or malformed working memory fails closed", async () => {
  const missingSessionKey = "wm-v1-missing";
  resetPlannerRuntimeContext({ sessionKey: missingSessionKey });

  let dispatcherCalled = false;
  const missingResult = await runPlannerToolFlow({
    userIntent: "繼續",
    payload: {},
    sessionKey: missingSessionKey,
    logger: console,
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
  assert.equal(missingResult.selected_action, null);
  assert.equal(missingResult.execution_result?.ok, false);

  const originalPath = process.env.PLANNER_CONVERSATION_MEMORY_PATH;
  const tempDir = mkdtempSync(join(tmpdir(), "planner-memory-v1-"));
  const tempStorePath = join(tempDir, "planner-conversation-memory.json");

  try {
    process.env.PLANNER_CONVERSATION_MEMORY_PATH = tempStorePath;
    writeFileSync(tempStorePath, JSON.stringify({
      latest_session_key: "wm-v1-malformed",
      sessions: {
        "wm-v1-malformed": {
          recent_messages: [],
          latest_summary: null,
          turns_since_summary: 0,
          chars_since_summary: 0,
          total_turns: 0,
          last_compacted_at: null,
          working_memory: {
            current_goal: 123,
            inferred_task_type: "document_lookup",
            last_selected_agent: "doc_agent",
            last_selected_skill: null,
            last_tool_result_summary: "invalid memory",
            unresolved_slots: [],
            next_best_action: "search_company_brain_docs",
            confidence: 0.9,
            updated_at: "2026-04-09T00:00:00.000Z",
          },
        },
      },
    }, null, 2));

    reloadPlannerConversationMemory();

    dispatcherCalled = false;
    const malformedResult = await runPlannerToolFlow({
      userIntent: "繼續",
      payload: {},
      sessionKey: "wm-v1-malformed",
      logger: console,
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
    assert.equal(malformedResult.selected_action, null);
    assert.equal(malformedResult.execution_result?.ok, false);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PLANNER_CONVERSATION_MEMORY_PATH;
    } else {
      process.env.PLANNER_CONVERSATION_MEMORY_PATH = originalPath;
    }
    reloadPlannerConversationMemory();
    rmSync(tempDir, { recursive: true, force: true });
    resetPlannerConversationMemory({ sessionKey: missingSessionKey });
  }
});
