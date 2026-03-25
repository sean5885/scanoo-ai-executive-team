import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
const testDb = await createTestDbHarness();
const [
  {
    buildPlannedUserInputEnvelope,
    executePlannedUserInput,
    resetPlannerRuntimeContext,
    runPlannerToolFlow,
  },
  { resolveDocQueryRoute },
] = await Promise.all([
  import("../src/executive-planner.mjs"),
  import("../src/planner-doc-query-flow.mjs"),
]);
import { route } from "../src/router.js";

const plannerContract = JSON.parse(
  readFileSync(new URL("../docs/system/planner_contract.json", import.meta.url), "utf8"),
);

test.after(() => {
  testDb.close();
});

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function matchesSchemaType(expectedType, value) {
  if (expectedType === "null") {
    return value === null;
  }
  if (expectedType === "boolean") {
    return typeof value === "boolean";
  }
  if (expectedType === "string") {
    return typeof value === "string";
  }
  if (expectedType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (expectedType === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  if (expectedType === "array") {
    return Array.isArray(value);
  }
  return true;
}

function validateAgainstSchema(schema = null, value, path = "$") {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const violations = [];
  const expectedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (expectedTypes.length > 0) {
    const matched = expectedTypes.some((expectedType) => matchesSchemaType(expectedType, value));
    if (!matched) {
      violations.push({
        path,
        type: "type",
        expected: expectedTypes.join("|"),
        actual: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
      });
      return violations;
    }
  }

  if (!Array.isArray(schema.required) || value == null || typeof value !== "object" || Array.isArray(value)) {
    return violations;
  }

  for (const requiredKey of schema.required) {
    if (!(requiredKey in value)) {
      violations.push({
        path: `${path}.${requiredKey}`,
        type: "required",
        expected: "present",
        actual: "missing",
      });
    }
  }

  if (!schema.properties || typeof schema.properties !== "object") {
    return violations;
  }

  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (!(key in value)) {
      continue;
    }
    violations.push(...validateAgainstSchema(propertySchema, value[key], `${path}.${key}`));
  }

  return violations;
}

function assertSchema(contractName, value) {
  const schema = plannerContract?.public_contracts?.[contractName];
  assert.ok(schema, `missing public contract schema: ${contractName}`);
  const violations = validateAgainstSchema(schema, value);
  assert.deepEqual(violations, [], `${contractName} schema drift: ${JSON.stringify(violations)}`);
}

function assertKnownError(errorCode) {
  if (!errorCode) {
    return;
  }
  assert.ok(plannerContract?.errors?.[errorCode], `unknown planner error code: ${errorCode}`);
}

function assertKnownRoutingReason(routingReason) {
  if (!routingReason) {
    return;
  }
  assert.ok(plannerContract?.routing_reason?.[routingReason], `unknown planner routing_reason: ${routingReason}`);
}

function assertKnownTarget(target, targetKind) {
  if (!target) {
    return;
  }
  if (targetKind === "action") {
    assert.ok(plannerContract?.actions?.[target], `unknown planner action target: ${target}`);
    return;
  }
  if (targetKind === "preset") {
    assert.ok(plannerContract?.presets?.[target], `unknown planner preset target: ${target}`);
  }
}

const fixtures = [
  {
    id: "search",
    async run() {
      resetPlannerRuntimeContext();
      const routerDecision = route("幫我找 OKR 文件");
      const docQueryRoute = resolveDocQueryRoute({
        userIntent: "幫我找 OKR 文件",
        payload: { limit: 3 },
        logger: quietLogger,
      });
      return [
        { contractName: "router_decision", value: routerDecision },
        { contractName: "doc_query_route", value: docQueryRoute },
      ];
    },
    assert(records) {
      const [routerDecision, docQueryRoute] = records.map((record) => record.value);

      assert.equal(routerDecision.action, "search_company_brain_docs");
      assert.equal(routerDecision.selected_target, "search_company_brain_docs");
      assert.equal(routerDecision.target_kind, "action");
      assert.equal(routerDecision.routing_reason, "doc_query_search");

      assert.equal(docQueryRoute.action, "search_company_brain_docs");
      assert.equal(docQueryRoute.selected_target, "search_company_brain_docs");
      assert.equal(docQueryRoute.target_kind, "action");
      assert.equal(docQueryRoute.routing_reason, "doc_query_search");
      assert.deepEqual(docQueryRoute.payload, {
        limit: 3,
        q: "幫我找 OKR 文件",
        query: "幫我找 OKR 文件",
      });
    },
  },
  {
    id: "invalid",
    async run() {
      resetPlannerRuntimeContext();
      const result = await executePlannedUserInput({
        text: "直接回答我",
        plannedDecision: {
          action: "free_chat_answer",
          params: {},
        },
      });
      return [{
        contractName: "planned_user_input_envelope",
        value: buildPlannedUserInputEnvelope(result),
      }];
    },
    assert(records) {
      const envelope = records[0].value;
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error, "invalid_action");
      assert.equal(envelope.trace?.fallback_reason, "invalid_action");
    },
  },
  {
    id: "no-match",
    async run() {
      resetPlannerRuntimeContext();
      const result = await runPlannerToolFlow({
        userIntent: "幫我看看",
        taskType: "",
        logger: quietLogger,
      });
      return [{
        contractName: "planner_tool_flow_output",
        value: result,
      }];
    },
    assert(records) {
      const result = records[0].value;
      assert.equal(result.selected_action, null);
      assert.equal(result.routing_reason, "routing_no_match");
      assert.equal(result.execution_result?.error, "business_error");
      assert.equal(result.execution_result?.data?.reason, "routing_no_match");
      assert.equal(result.execution_result?.data?.routing_reason, "routing_no_match");
    },
  },
  {
    id: "fallback",
    async run() {
      resetPlannerRuntimeContext();
      const result = await executePlannedUserInput({
        text: "幫我找 OKR 文件",
        async requester() {
          return '額外說明 {"action":"search_company_brain_docs","params":{"q":"OKR"}}';
        },
      });
      return [{
        contractName: "planned_user_input_envelope",
        value: buildPlannedUserInputEnvelope(result),
      }];
    },
    assert(records) {
      const envelope = records[0].value;
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error, "planner_failed");
      assert.equal(envelope.trace?.fallback_reason, "planner_failed");
    },
  },
];

for (const fixture of fixtures) {
  test(`planner contract regression fixture: ${fixture.id}`, async () => {
    const records = await fixture.run();
    for (const record of records) {
      assertSchema(record.contractName, record.value);
      assertKnownRoutingReason(record.value?.routing_reason);
      assertKnownTarget(record.value?.selected_target, record.value?.target_kind);
      assertKnownError(record.value?.error);
      assertKnownError(record.value?.execution_result?.error);
      assertKnownError(record.value?.trace?.fallback_reason);
      assertKnownError(record.value?.execution_result?.data?.stop_reason);
      assertKnownRoutingReason(record.value?.execution_result?.data?.routing_reason);
      assertKnownRoutingReason(record.value?.execution_result?.data?.reason);
    }
    fixture.assert(records);
  });
}
