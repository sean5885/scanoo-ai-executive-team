import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLarkPluginDispatchSessionKey,
  executeLarkPluginDispatch,
  normalizeLarkPluginDispatchRequest,
  resolveDirectIngressSourceState,
  resolveLarkPluginDispatchDecision,
  resolveRequestedCapabilityLaneMapping,
} from "../src/lark-plugin-dispatch-adapter.mjs";

test("plugin-native request does not enter internal knowledge or lane backends", async () => {
  let knowledgeCalls = 0;
  let laneCalls = 0;

  const result = await executeLarkPluginDispatch({
    rawRequest: {
      tool_name: "lark_doc_read",
      requested_capability: "lark_doc_read",
      route_request: {
        path: "/api/doc/read?document_id=doc_123",
        method: "GET",
      },
      source: "official_lark_plugin",
    },
    async runKnowledgeAnswer() {
      knowledgeCalls += 1;
      return { status: 200, data: { ok: true } };
    },
    async runLaneBackend() {
      laneCalls += 1;
      return { status: 200, data: { ok: true } };
    },
  });

  assert.equal(result.route_target, "plugin_native");
  assert.equal(result.final_status, "plugin_native_forward");
  assert.equal(result.fallback_reason, "plugin_native_capability");
  assert.equal(knowledgeCalls, 0);
  assert.equal(laneCalls, 0);
});

test("Scanoo-style request routes into the existing lane backend", async () => {
  let knowledgeCalls = 0;
  let laneCalls = 0;

  const result = await executeLarkPluginDispatch({
    rawRequest: {
      tool_name: "lark_kb_answer",
      requested_capability: "lane_style_capability",
      request_text: "幫我分析 Scanoo onboarding funnel 的問題點",
      route_request: {
        path: "/answer?q=%E5%B9%AB%E6%88%91%E5%88%86%E6%9E%90%20Scanoo",
        method: "GET",
      },
      source: "official_lark_plugin",
    },
    async runKnowledgeAnswer() {
      knowledgeCalls += 1;
      return { status: 200, data: { ok: true } };
    },
    async runLaneBackend({ decision }) {
      laneCalls += 1;
      return {
        status: 200,
        data: {
          ok: true,
          answer: "lane backend reached",
          chosen_lane: decision.chosen_lane,
        },
      };
    },
  });

  assert.equal(result.route_target, "lane_backend");
  assert.equal(result.final_status, "completed");
  assert.equal(result.chosen_skill, "lane_style_capability");
  assert.equal(knowledgeCalls, 0);
  assert.equal(laneCalls, 1);
});

test("explicit requested capability wins over text heuristics and records explicit source", async () => {
  let knowledgeCalls = 0;
  let laneCalls = 0;
  const logs = [];
  const logger = {
    info(event, payload) {
      logs.push([event, payload]);
    },
    warn() {},
    error() {},
    compactError(error) {
      return error;
    },
  };

  const result = await executeLarkPluginDispatch({
    rawRequest: {
      tool_name: "lark_kb_answer",
      requested_capability: "knowledge_answer",
      capability_source: "explicit",
      request_text: "幫我比較 Scanoo onboarding funnel 差異",
      route_request: {
        path: "/answer?q=Scanoo",
        method: "GET",
      },
      source: "official_lark_plugin",
    },
    logger,
    async runKnowledgeAnswer() {
      knowledgeCalls += 1;
      return { status: 200, data: { ok: true } };
    },
    async runLaneBackend() {
      laneCalls += 1;
      return { status: 200, data: { ok: true } };
    },
  });

  assert.equal(result.route_target, "knowledge_answer");
  assert.equal(result.capability_source, "explicit");
  assert.equal(knowledgeCalls, 1);
  assert.equal(laneCalls, 0);
  assert.equal(
    logs.some(([event, payload]) => (
      event === "lark_plugin_dispatch_started"
      && payload?.requested_capability === "knowledge_answer"
      && payload?.capability_source === "explicit"
    )),
    true,
  );
});

test("scanoo_diagnose maps to the dedicated scanoo-diagnose lane", () => {
  const mapping = resolveRequestedCapabilityLaneMapping({
    requestedCapability: "scanoo_diagnose",
  });

  assert.equal(mapping.route_target, "lane_backend");
  assert.equal(mapping.mapped_lane, "scanoo-diagnose");
  assert.equal(mapping.chosen_lane, "scanoo-diagnose");
  assert.equal(mapping.lane_mapping_source, "explicit");
  assert.equal(mapping.fallback_reason, null);
});

test("scanoo_diagnose falls back to knowledge-assistant only when the dedicated lane is unavailable", () => {
  const mapping = resolveRequestedCapabilityLaneMapping({
    requestedCapability: "scanoo_diagnose",
    supportedPluginDispatchLanes: new Set([
      "knowledge-assistant",
      "doc-editor",
      "group-shared-assistant",
      "personal-assistant",
    ]),
  });

  assert.equal(mapping.route_target, "lane_backend");
  assert.equal(mapping.mapped_lane, "knowledge-assistant");
  assert.equal(mapping.chosen_lane, "knowledge-assistant");
  assert.equal(mapping.lane_mapping_source, "fallback");
  assert.equal(mapping.fallback_reason, "missing_exact_scanoo_diagnose_lane_fallback_to_knowledge_assistant");
});

test("explicit scanoo_compare capability routes to mapped knowledge lane even without scanoo wording", async () => {
  let knowledgeCalls = 0;
  let laneCalls = 0;

  const result = await executeLarkPluginDispatch({
    rawRequest: {
      tool_name: "lark_kb_answer",
      requested_capability: "scanoo_compare",
      capability_source: "explicit",
      request_text: "公司 SOP 在哪裡？",
      route_request: {
        path: "/answer?q=%E5%85%AC%E5%8F%B8%20SOP",
        method: "GET",
      },
      source: "official_lark_plugin",
    },
    async runKnowledgeAnswer() {
      knowledgeCalls += 1;
      return { status: 200, data: { ok: true } };
    },
    async runLaneBackend() {
      laneCalls += 1;
      return { status: 200, data: { ok: true } };
    },
  });

  assert.equal(result.route_target, "lane_backend");
  assert.equal(result.mapped_lane, "knowledge-assistant");
  assert.equal(result.chosen_lane, "knowledge-assistant");
  assert.equal(result.lane_mapping_source, "fallback");
  assert.equal(result.chosen_skill, "scanoo_compare");
  assert.equal(result.fallback_reason, "missing_exact_scanoo_compare_lane_fallback_to_knowledge_assistant");
  assert.equal(knowledgeCalls, 0);
  assert.equal(laneCalls, 1);
});

test("scanoo_optimize maps to the fallback knowledge lane", () => {
  const mapping = resolveRequestedCapabilityLaneMapping({
    requestedCapability: "scanoo_optimize",
  });

  assert.equal(mapping.route_target, "lane_backend");
  assert.equal(mapping.mapped_lane, "knowledge-assistant");
  assert.equal(mapping.chosen_lane, "knowledge-assistant");
  assert.equal(mapping.lane_mapping_source, "fallback");
  assert.equal(mapping.fallback_reason, "missing_exact_scanoo_optimize_lane_fallback_to_knowledge_assistant");
});

test("missing requested capability falls back to legacy heuristics", () => {
  const normalized = normalizeLarkPluginDispatchRequest({
    tool_name: "lark_kb_answer",
    request_text: "幫我分析 Scanoo onboarding funnel 的問題點",
    route_request: {
      path: "/answer?q=Scanoo",
      method: "GET",
    },
    source: "official_lark_plugin",
  });

  const decision = resolveLarkPluginDispatchDecision(normalized);

  assert.equal(normalized.requested_capability, null);
  assert.equal(normalized.capability_source, null);
  assert.equal(decision.route_target, "lane_backend");
  assert.equal(decision.fallback_reason, "lane_style_capability");
});

test("thread_id takes precedence when building plugin dispatch session keys", () => {
  const normalized = normalizeLarkPluginDispatchRequest({
    thread_id: "thr_001",
    chat_id: "chat_001",
    session_id: "sess_001",
    route_request: {
      path: "/answer?q=test",
      method: "GET",
    },
  });

  assert.equal(buildLarkPluginDispatchSessionKey({
    thread_id: "thr_001",
    chat_id: "chat_001",
    session_id: "sess_001",
  }), "thread:thr_001");
  assert.equal(normalized.resolved_session_key, "thread:thr_001");
});

test("unknown capability fallback keeps an explicit reason", async () => {
  const result = await executeLarkPluginDispatch({
    rawRequest: {
      tool_name: "mystery_tool",
      requested_capability: "mystery_capability",
      route_request: {
        path: "/api/mystery",
        method: "POST",
        body: { ok: true },
      },
      source: "official_lark_plugin",
    },
  });

  assert.equal(result.route_target, "plugin_native");
  assert.equal(result.final_status, "plugin_native_forward");
  assert.equal(result.fallback_reason, "unknown_capability_fallback_plugin_native");
});

test("missing mapped lane falls back with an explicit fallback reason", () => {
  const mapping = resolveRequestedCapabilityLaneMapping({
    requestedCapability: "scanoo_compare",
    capabilityRouteMap: {
      scanoo_compare: {
        route_target: "lane_backend",
        mapped_lane: "compare-assistant",
        lane_mapping_source: "explicit",
        chosen_skill: "scanoo_compare",
      },
    },
  });

  assert.equal(mapping.route_target, "lane_backend");
  assert.equal(mapping.mapped_lane, "personal-assistant");
  assert.equal(mapping.chosen_lane, "personal-assistant");
  assert.equal(mapping.lane_mapping_source, "fallback");
  assert.equal(mapping.fallback_reason, "mapped_lane_missing_or_unsupported_fallback_to_personal_assistant");
});

test("direct ingress policy is marked non-primary when gated by flag", () => {
  const state = resolveDirectIngressSourceState({
    source: "direct_http_answer",
    directIngressPrimaryEnabled: false,
  });

  assert.equal(state.is_direct_ingress, true);
  assert.equal(state.is_primary_entry, false);
  assert.equal(state.fallback_reason, "direct_ingress_not_primary");
});
