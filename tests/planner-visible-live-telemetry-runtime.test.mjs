import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
import {
  createInMemoryTelemetryAdapter,
  createStructuredLogTelemetryAdapter,
} from "../src/planner-visible-live-telemetry-adapter.mjs";

const testDb = await createTestDbHarness();
const [
  {
    buildPlannedUserInputEnvelope,
    executePlannedUserInput,
    runPlannerToolFlow,
  },
  { normalizeUserResponse },
  {
    attachPlannerVisibleTelemetryContext,
    copyPlannerVisibleTelemetryContext,
    listPlannerVisibleTelemetryCollectorEvents,
    resetPlannerVisibleTelemetryCollector,
  },
  { PLANNER_VISIBLE_TELEMETRY_EVENT_CATALOG },
] = await Promise.all([
  import("../src/executive-planner.mjs"),
  import("../src/user-response-normalizer.mjs"),
  import("../src/planner-visible-live-telemetry-runtime.mjs"),
  import("../src/planner-visible-live-telemetry-spec.mjs"),
]);

test.after(() => {
  testDb.close();
});

test.beforeEach(() => {
  resetPlannerVisibleTelemetryCollector();
});

function buildExecuteLikeResult(runtimeResult = {}, {
  action = "",
  params = {},
  why = "",
  executionData = {},
} = {}) {
  const output = {
    ok: runtimeResult?.execution_result?.ok === true,
    action: action || runtimeResult?.selected_action || null,
    params,
    error: runtimeResult?.execution_result?.ok === false
      ? runtimeResult?.execution_result?.error || null
      : null,
    execution_result: {
      ...(runtimeResult?.execution_result && typeof runtimeResult.execution_result === "object" ? runtimeResult.execution_result : {}),
      data: {
        ...(runtimeResult?.execution_result?.data && typeof runtimeResult.execution_result.data === "object" ? runtimeResult.execution_result.data : {}),
        ...(executionData && typeof executionData === "object" && !Array.isArray(executionData) ? executionData : {}),
      },
    },
    trace_id: runtimeResult?.trace_id || null,
    why: why || null,
    alternative: null,
  };
  copyPlannerVisibleTelemetryContext(runtimeResult, output);
  return output;
}

function assertTelemetrySchema(events = []) {
  for (const event of events) {
    const catalogEntry = PLANNER_VISIBLE_TELEMETRY_EVENT_CATALOG[event.event];
    assert.ok(catalogEntry, `unknown event catalog entry: ${event.event}`);
    const allowedKeys = new Set([
      "event",
      ...catalogEntry.required_fields,
      ...catalogEntry.optional_fields,
    ]);
    for (const key of Object.keys(event)) {
      assert.equal(allowedKeys.has(key), true, `unexpected field ${key} on ${event.event}`);
    }
    for (const field of catalogEntry.required_fields) {
      assert.equal(Object.prototype.hasOwnProperty.call(event, field), true, `missing ${field} on ${event.event}`);
    }
  }
}

test("runtime skill success path emits planner-visible selection and answer telemetry", async () => {
  const runtimeResult = await runPlannerToolFlow({
    userIntent: "幫我整理 launch checklist",
    taskType: "skill_read",
    requestId: "req_runtime_skill_success",
    payload: {
      account_id: "acct_runtime_skill_success",
      reader_overrides: {
        index: {
          search_knowledge_base: {
            success: true,
            data: {
              items: [
                {
                  id: "doc_skill_1:0",
                  snippet: "launch checklist rollout with review gate and rollback watch",
                  metadata: {
                    title: "Launch Checklist Summary",
                    url: "https://example.com/launch-checklist-summary",
                  },
                },
              ],
            },
            error: null,
          },
        },
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  });

  const envelope = buildPlannedUserInputEnvelope(buildExecuteLikeResult(runtimeResult, {
    action: runtimeResult.selected_action,
    params: {
      account_id: "acct_runtime_skill_success",
    },
    why: "skill runtime success",
    executionData: {
      answer: "launch checklist rollout with review gate and rollback watch",
      sources: [
        {
          title: "Launch Checklist Summary",
          url: "https://example.com/launch-checklist-summary",
          snippet: "launch checklist rollout with review gate and rollback watch",
        },
      ],
      limitations: ["如果你要，我可以再整理成 checklist。"],
    },
  }));
  normalizeUserResponse({ plannerEnvelope: envelope });

  const events = listPlannerVisibleTelemetryCollectorEvents({
    request_id: "req_runtime_skill_success",
  });
  assert.deepEqual(events.map((event) => event.event), [
    "planner_visible_skill_selected",
    "planner_visible_answer_generated",
  ]);
  assert.equal(events[0].query_type, "search");
  assert.deepEqual(events[0].candidate_skills, ["search_and_summarize", "document_summarize"]);
  assert.equal(events[0].selected_skill, "search_and_summarize");
  assert.equal(events[0].routing_family, "planner_visible_search");
  assert.equal(events[0].admission_outcome, "admitted");
  assert.equal(events[1].answer_pipeline_enforced, true);
  assert.equal(events[1].raw_payload_blocked, true);
  assert.equal(events[1].answer_contract_ok, true);
  assert.equal(events[1].answer_consistency_proxy_ok, true);
  assert.equal(events[1].answer_skill_action, "search_and_summarize");
  assert.equal(events.every((event) => event.request_id === "req_runtime_skill_success"), true);
  assertTelemetrySchema(events);
});

test("runtime can inject a non-default in-memory telemetry adapter", async () => {
  const telemetryAdapter = createInMemoryTelemetryAdapter();
  const runtimeResult = await runPlannerToolFlow({
    userIntent: "幫我整理 launch checklist",
    taskType: "skill_read",
    requestId: "req_runtime_custom_in_memory_adapter",
    telemetryAdapter,
    payload: {
      account_id: "acct_runtime_custom_in_memory_adapter",
      reader_overrides: {
        index: {
          search_knowledge_base: {
            success: true,
            data: {
              items: [
                {
                  id: "doc_skill_custom_adapter:0",
                  snippet: "launch checklist rollout with review gate and rollback watch",
                  metadata: {
                    title: "Launch Checklist Summary",
                    url: "https://example.com/launch-checklist-summary",
                  },
                },
              ],
            },
            error: null,
          },
        },
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  });

  const envelope = buildPlannedUserInputEnvelope(buildExecuteLikeResult(runtimeResult, {
    action: runtimeResult.selected_action,
    params: {
      account_id: "acct_runtime_custom_in_memory_adapter",
    },
    why: "skill runtime success with custom in-memory telemetry adapter",
    executionData: {
      answer: "launch checklist rollout with review gate and rollback watch",
      sources: [
        {
          title: "Launch Checklist Summary",
          url: "https://example.com/launch-checklist-summary",
          snippet: "launch checklist rollout with review gate and rollback watch",
        },
      ],
      limitations: ["如果你要，我可以再整理成 checklist。"],
    },
  }));
  normalizeUserResponse({ plannerEnvelope: envelope });

  const adapterEvents = telemetryAdapter.getBuffer({
    request_id: "req_runtime_custom_in_memory_adapter",
  });
  const defaultCollectorEvents = listPlannerVisibleTelemetryCollectorEvents({
    request_id: "req_runtime_custom_in_memory_adapter",
  });

  assert.deepEqual(adapterEvents.map((event) => event.event), [
    "planner_visible_skill_selected",
    "planner_visible_answer_generated",
  ]);
  assert.deepEqual(defaultCollectorEvents, []);
  assertTelemetrySchema(adapterEvents);
});

test("mixed planner-visible fail-closed path emits fail_closed, ambiguity, fallback, and answer telemetry", async () => {
  const result = await executePlannedUserInput({
    text: "幫我搜尋這份 launch checklist 文件並整理重點",
    requestId: "req_runtime_mixed_fail_closed",
    plannedDecision: {
      action: "search_company_brain_docs",
      params: {
        q: "launch checklist",
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    async toolFlowRunner({
      forcedSelection,
      telemetryContext,
    }) {
      const runtimeResult = {
        selected_action: forcedSelection?.selected_action || null,
        execution_result: {
          ok: true,
          action: forcedSelection?.selected_action || null,
          data: {
            answer: "我已先按目前已索引的文件，標出和「launch checklist」最相關的 1 份文件。",
            sources: [
              {
                title: "Launch Checklist",
                url: "https://example.com/launch-checklist",
                snippet: "文件內容直接命中 launch checklist。",
              },
            ],
            limitations: ["如果你要，我可以再沿著這份文件補更多原文依據。"],
          },
          trace_id: "trace_runtime_mixed_fail_closed",
        },
        trace_id: "trace_runtime_mixed_fail_closed",
      };
      attachPlannerVisibleTelemetryContext(runtimeResult, telemetryContext);
      return runtimeResult;
    },
  });

  const envelope = buildPlannedUserInputEnvelope(result);
  normalizeUserResponse({ plannerEnvelope: envelope });

  const events = listPlannerVisibleTelemetryCollectorEvents({
    request_id: "req_runtime_mixed_fail_closed",
  });
  assert.deepEqual(events.map((event) => event.event), [
    "planner_visible_fail_closed",
    "planner_visible_ambiguity",
    "planner_visible_fallback",
    "planner_visible_answer_generated",
  ]);
  assert.equal(events.every((event) => event.query_type === "mixed"), true);
  assert.equal(events.every((event) => event.selected_skill === null), true);
  assert.equal(events.every((event) => event.routing_family === "search_company_brain_docs"), true);
  assert.equal(events[0].fail_closed_stage, "admission");
  assert.equal(events[0].ambiguity_detected, true);
  assert.deepEqual(events[0].rejected_skills, ["search_and_summarize", "document_summarize"]);
  assert.deepEqual(events[1].ambiguity_signals, ["multiple_planner_visible_candidates"]);
  assert.equal(events[2].fallback_action, "search_company_brain_docs");
  assert.equal(events[3].answer_contract_ok, true);
  assert.equal(events[3].answer_consistency_proxy_ok, true);
  assertTelemetrySchema(events);
});

test("follow-up fail-closed path keeps fallback and answer telemetry without ambiguity leakage", async () => {
  const result = await executePlannedUserInput({
    text: "這份文件幫我整理重點",
    requestId: "req_runtime_follow_up_fail_closed",
    plannedDecision: {
      action: "search_and_detail_doc",
      params: {
        q: "這份文件",
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    async toolFlowRunner({
      forcedSelection,
      telemetryContext,
    }) {
      const runtimeResult = {
        selected_action: forcedSelection?.selected_action || null,
        execution_result: {
          ok: true,
          action: forcedSelection?.selected_action || null,
          data: {
            answer: "我先以「Launch Checklist」作為這輪最直接的對應文件。 這份文件整理 launch checklist 的 rollout 與 review gate。",
            sources: [
              {
                title: "Launch Checklist",
                url: "https://example.com/launch-checklist",
                snippet: "目前先沿著既有文件脈絡補摘要。",
              },
            ],
            limitations: ["如果你要，我可以再把這份文件整理成 checklist。"],
          },
          trace_id: "trace_runtime_follow_up_fail_closed",
        },
        trace_id: "trace_runtime_follow_up_fail_closed",
      };
      attachPlannerVisibleTelemetryContext(runtimeResult, telemetryContext);
      return runtimeResult;
    },
  });

  const envelope = buildPlannedUserInputEnvelope(result);
  normalizeUserResponse({ plannerEnvelope: envelope });

  const events = listPlannerVisibleTelemetryCollectorEvents({
    request_id: "req_runtime_follow_up_fail_closed",
  });
  assert.deepEqual(events.map((event) => event.event), [
    "planner_visible_fail_closed",
    "planner_visible_fallback",
    "planner_visible_answer_generated",
  ]);
  assert.equal(events.every((event) => event.query_type === "follow-up"), true);
  assert.equal(events.every((event) => event.routing_family === "search_and_detail_doc"), true);
  assert.equal(events[0].ambiguity_detected, false);
  assert.equal(events[1].fallback_action, "search_and_detail_doc");
  assert.equal(events[2].answer_contract_ok, true);
  assert.equal(events[2].answer_consistency_proxy_ok, true);
  assertTelemetrySchema(events);
});

test("runtime can emit planner-visible telemetry through the structured log adapter", async () => {
  const structuredLines = [];
  const telemetryAdapter = createStructuredLogTelemetryAdapter({
    writer(line) {
      structuredLines.push(line);
    },
  });

  const result = await executePlannedUserInput({
    text: "幫我搜尋這份 launch checklist 文件並整理重點",
    requestId: "req_runtime_structured_log_adapter",
    telemetryAdapter,
    plannedDecision: {
      action: "search_company_brain_docs",
      params: {
        q: "launch checklist",
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    async toolFlowRunner({
      forcedSelection,
      telemetryContext,
    }) {
      const runtimeResult = {
        selected_action: forcedSelection?.selected_action || null,
        execution_result: {
          ok: true,
          action: forcedSelection?.selected_action || null,
          data: {
            answer: "我已先按目前已索引的文件，標出和「launch checklist」最相關的 1 份文件。",
            sources: [
              {
                title: "Launch Checklist",
                url: "https://example.com/launch-checklist",
                snippet: "文件內容直接命中 launch checklist。",
              },
            ],
            limitations: ["如果你要，我可以再沿著這份文件補更多原文依據。"],
          },
          trace_id: "trace_runtime_structured_log_adapter",
        },
        trace_id: "trace_runtime_structured_log_adapter",
      };
      attachPlannerVisibleTelemetryContext(runtimeResult, telemetryContext);
      return runtimeResult;
    },
  });

  const envelope = buildPlannedUserInputEnvelope(result);
  normalizeUserResponse({ plannerEnvelope: envelope });

  const events = telemetryAdapter.getBuffer()
    .filter((event) => event.request_id === "req_runtime_structured_log_adapter");
  const logLines = telemetryAdapter.getLogBuffer();
  const parsedLogEvents = structuredLines.map((line) => JSON.parse(line));
  const defaultCollectorEvents = listPlannerVisibleTelemetryCollectorEvents({
    request_id: "req_runtime_structured_log_adapter",
  });

  assert.deepEqual(events.map((event) => event.event), [
    "planner_visible_fail_closed",
    "planner_visible_ambiguity",
    "planner_visible_fallback",
    "planner_visible_answer_generated",
  ]);
  assert.equal(defaultCollectorEvents.length, 0);
  assert.equal(logLines.length, events.length);
  assert.deepEqual(parsedLogEvents.map((event) => event.event), events.map((event) => event.event));
  assertTelemetrySchema(events);
});
