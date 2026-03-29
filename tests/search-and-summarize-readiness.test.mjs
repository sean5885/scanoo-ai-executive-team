import test from "node:test";
import assert from "node:assert/strict";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const {
  listPlannerDecisionCatalogEntries,
  renderPlannerUserFacingReplyText,
  runPlannerToolFlow,
  selectPlannerTool,
} = await import("../src/executive-planner.mjs");
const {
  createPlannerSkillActionRegistry,
  getPlannerSkillAction,
} = await import("../src/planner/skill-bridge.mjs");
const { normalizeUserResponse } = await import("../src/user-response-normalizer.mjs");

function createEventLogger() {
  const events = [];

  function record(level, event, payload = {}) {
    events.push({
      level,
      event,
      payload,
    });
  }

  return {
    events,
    logger: {
      info(event, payload = {}) {
        record("info", event, payload);
      },
      warn(event, payload = {}) {
        record("warn", event, payload);
      },
      error(event, payload = {}) {
        record("error", event, payload);
      },
      debug(event, payload = {}) {
        record("debug", event, payload);
      },
    },
  };
}

function findLatestEvent(events = [], eventName = "") {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.event === eventName) {
      return events[index];
    }
  }
  return null;
}

test.after(() => {
  testDb.close();
});

test("search_and_summarize selector stays disjoint from document_summarize", () => {
  const searchEntry = getPlannerSkillAction("search_and_summarize");
  const documentEntry = getPlannerSkillAction("document_summarize");
  const overlappingTaskTypes = searchEntry.selector_task_types
    .filter((taskType) => documentEntry.selector_task_types.includes(taskType));

  assert.equal(searchEntry.selector_key, "skill.search_and_summarize.read");
  assert.equal(documentEntry.selector_key, "skill.document_summarize.read");
  assert.deepEqual(overlappingTaskTypes, []);
  assert.equal(searchEntry.surface_layer, "internal_only");
  assert.equal(searchEntry.promotion_stage, "readiness_check");
  assert.equal(searchEntry.previous_promotion_stage, "internal_only");
  assert.equal(searchEntry.planner_catalog_eligible, false);
  assert.equal(documentEntry.surface_layer, "planner_visible");
});

test("search_and_summarize readiness_check status does not enter the strict planner catalog", () => {
  const catalogNames = listPlannerDecisionCatalogEntries().map((entry) => entry.name);
  const searchEntry = getPlannerSkillAction("search_and_summarize");

  assert.equal(searchEntry?.surface_layer, "internal_only");
  assert.equal(searchEntry?.promotion_stage, "readiness_check");
  assert.equal(searchEntry?.previous_promotion_stage, "internal_only");
  assert.equal(searchEntry?.planner_catalog_eligible, false);
  assert.equal(catalogNames.includes("search_and_summarize"), false);
});

test("search_and_summarize promotion candidate fails closed when it overlaps document_summarize selector task types", () => {
  assert.throws(() => createPlannerSkillActionRegistry([
    {
      action: "search_and_summarize",
      skill_name: "search_and_summarize",
      surface_layer: "planner_visible",
      promotion_stage: "planner_visible",
      previous_promotion_stage: "readiness_check",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.search_and_summarize.read",
      selector_task_types: ["document_summary_skill"],
      routing_reason: "selector_search_and_summarize_skill",
      selection_reason: "search summary skill path",
      readiness_gate: {
        regression_suite_passed: true,
        answer_pipeline_enforced: true,
        observability_evidence_verified: true,
        raw_skill_output_blocked: true,
        output_shape_stable: true,
        side_effect_boundary_locked: true,
      },
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
    },
    {
      action: "document_summarize",
      skill_name: "document_summarize",
      surface_layer: "planner_visible",
      promotion_stage: "planner_visible",
      previous_promotion_stage: "readiness_check",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.document_summarize.read",
      selector_task_types: ["document_summary_skill"],
      routing_reason: "selector_document_summarize_skill",
      selection_reason: "document summary skill path",
      readiness_gate: {
        regression_suite_passed: true,
        answer_pipeline_enforced: true,
        observability_evidence_verified: true,
        raw_skill_output_blocked: true,
        output_shape_stable: true,
        side_effect_boundary_locked: true,
      },
      allowed_side_effects: {
        read: ["get_company_brain_doc_detail"],
        write: [],
      },
    },
  ]), /invalid_planner_skill_surface_policy/);
});

test("planner does not mis-select document_summarize for mixed search-and-summarize skill queries", () => {
  const { events, logger } = createEventLogger();
  const result = selectPlannerTool({
    userIntent: "幫我搜尋 launch checklist 並整理重點",
    taskType: "skill_read",
    logger,
  });
  const event = findLatestEvent(events, "planner_tool_select");

  assert.equal(result.selected_action, "search_and_summarize");
  assert.equal(result.routing_reason, "selector_search_and_summarize_skill");
  assert.equal(event?.payload?.skill_selector_attempted, true);
  assert.equal(event?.payload?.skill_selector_key, "skill.search_and_summarize.read");
  assert.equal(event?.payload?.skill_surface_layer, "internal_only");
});

test("mixed search-and-summarize user intents keep the existing search path when no skill task type is provided", () => {
  const { events, logger } = createEventLogger();
  const result = selectPlannerTool({
    userIntent: "幫我搜尋 launch checklist 並整理重點",
    taskType: "",
    logger,
  });
  const event = findLatestEvent(events, "planner_tool_select");

  assert.equal(result.selected_action, "search_company_brain_docs");
  assert.equal(result.routing_reason, "selector_search_company_brain_docs");
  assert.equal(event?.payload?.skill_selector_attempted, false);
  assert.equal(event?.payload?.skill_selector_key, null);
});

test("search_and_summarize stays observable and read-only while noisy search snippets are cleaned before final answer rendering", async () => {
  const { events, logger } = createEventLogger();
  const result = await runPlannerToolFlow({
    userIntent: "幫我搜尋 launch checklist 並整理重點",
    taskType: "skill_read",
    payload: {
      account_id: "acct_search_readiness",
      q: "launch checklist",
      reader_overrides: {
        index: {
          search_knowledge_base: {
            success: true,
            data: {
              items: [
                {
                  id: "doc_readiness_1:0",
                  snippet: "Back to [README.md](/Users/seanhan/Documents/Playground/README.md)\n- [Ship checklist](https://example.com/checklist)\n- owner: ops",
                  metadata: {
                    title: "Noisy Launch Notes",
                    url: "https://example.com/noisy-launch-notes",
                  },
                },
                {
                  id: "doc_readiness_2:0",
                  snippet: "混合語言摘要片段 mixed-language snippet 與负责人 owner",
                  metadata: {
                    title: "跨語 Launch Plan",
                    url: "https://example.com/multilingual-launch-plan",
                  },
                },
                {
                  id: "doc_readiness_3:0",
                  snippet: "launch guardrail ".repeat(20),
                  metadata: {
                    title: "Long Guardrail Note",
                    url: "https://example.com/long-guardrail-note",
                  },
                },
                {
                  id: "doc_readiness_4:0",
                  snippet: "extra overflow result",
                  metadata: {
                    title: "Overflow Result",
                    url: "https://example.com/overflow-result",
                  },
                },
              ],
            },
            error: null,
          },
        },
      },
    },
    logger,
  });

  const plannerEnvelope = {
    ok: result?.execution_result?.ok === true,
    action: result?.selected_action || null,
    execution_result: result?.execution_result || null,
    trace_id: result?.trace_id || null,
  };
  const userResponse = normalizeUserResponse({
    plannerEnvelope,
    logger,
  });
  const text = renderPlannerUserFacingReplyText(userResponse);
  const selectionEvent = findLatestEvent(events, "planner_tool_select");
  const toolEvent = findLatestEvent(events, "lobster_tool_execution");
  const boundaryEvent = findLatestEvent(events, "chat_output_boundary");

  assert.equal(result.selected_action, "search_and_summarize");
  assert.equal(result.execution_result?.ok, true);
  assert.equal(selectionEvent?.payload?.skill_selector_key, "skill.search_and_summarize.read");
  assert.equal(toolEvent?.payload?.skill_surface_layer, "internal_only");
  assert.equal(toolEvent?.payload?.skill_fail_closed, false);
  assert.equal(boundaryEvent?.payload?.planner_skill_boundary, "answer_pipeline");
  assert.equal(boundaryEvent?.payload?.planner_skill_surface_layer, "internal_only");
  assert.equal(boundaryEvent?.payload?.planner_skill_answer_pipeline_enforced, true);
  assert.equal(boundaryEvent?.payload?.planner_skill_raw_payload_blocked, true);
  assert.equal(userResponse.ok, true);
  assert.equal(userResponse.sources.length >= 2, true);
  assert.match(userResponse.answer || "", /launch checklist/i);
  assert.match(userResponse.answer || "", /Ship checklist owner: ops/i);
  assert.match(userResponse.sources.join(" "), /Noisy Launch Notes|跨語 Launch Plan|Long Guardrail Note/);
  assert.match(userResponse.limitations.join(" "), /僅摘要前 3 筆來源/);
  assert.doesNotMatch(text, /skill_bridge|search_and_summarize|side_effects|read-runtime|authority/);
  assert.doesNotMatch(text, /\/Users\/|Back to \[?README|https:\/\/example\.com\/checklist/);
});
