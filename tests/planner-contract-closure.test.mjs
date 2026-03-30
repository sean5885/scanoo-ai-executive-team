import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const [
  { buildPlannedUserInputEnvelope },
  { normalizeUserResponse, renderUserResponseText },
  { executeRegisteredAgent },
  { getRegisteredAgent },
] = await Promise.all([
  import("../src/executive-planner.mjs"),
  import("../src/user-response-normalizer.mjs"),
  import("../src/agent-dispatcher.mjs"),
  import("../src/agent-registry.mjs"),
]);

const plannerContract = JSON.parse(
  readFileSync(new URL("../docs/system/planner_contract.json", import.meta.url), "utf8"),
);
const routerSource = readFileSync(new URL("../src/router.js", import.meta.url), "utf8");

test.after(() => {
  testDb.close();
});

function scanLiteralFieldValues(sourceText = "", fieldName = "") {
  const pattern = new RegExp(`${fieldName}:\\s*["'\`]([^"'\\\`]+)["'\`]`, "g");
  const values = new Set();
  let match = pattern.exec(sourceText);
  while (match) {
    values.add(String(match[1] || "").trim());
    match = pattern.exec(sourceText);
  }
  return [...values];
}

function collectValuesByKey(value, keys = [], output = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectValuesByKey(item, keys, output);
    }
    return output;
  }

  if (!value || typeof value !== "object") {
    return output;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (keys.includes(key) && typeof nestedValue === "string") {
      output.push(nestedValue);
    }
    collectValuesByKey(nestedValue, keys, output);
  }
  return output;
}

function makeSourceItem(title, url, snippet) {
  return {
    id: `${title}-${url}`.replace(/\s+/g, "_"),
    snippet,
    metadata: {
      title,
      url,
    },
  };
}

test("planner contract closure keeps every router literal target and routing reason declared", () => {
  const routingReasons = scanLiteralFieldValues(routerSource, "routingReason");
  const actions = scanLiteralFieldValues(routerSource, "action");
  const presets = scanLiteralFieldValues(routerSource, "preset");

  const missingRoutingReasons = routingReasons.filter((value) => !plannerContract?.routing_reason?.[value]);
  const missingActions = actions.filter((value) => !plannerContract?.actions?.[value]);
  const missingPresets = presets.filter((value) => !plannerContract?.presets?.[value]);

  assert.deepEqual(missingRoutingReasons, []);
  assert.deepEqual(missingActions, []);
  assert.deepEqual(missingPresets, []);
});

test("runtime-info naming stays canonical across planner envelope and answer boundary", () => {
  const plannerEnvelope = buildPlannedUserInputEnvelope({
    ok: true,
    action: "get_runtime_info",
    params: {},
    execution_result: {
      ok: true,
      kind: "get_runtime_info",
      db_path: "/tmp/runtime-closure.sqlite",
      node_pid: 4321,
      cwd: "/tmp/runtime-closure",
      service_start_time: "2026-03-27T15:00:00.000Z",
    },
    why: "需求在查 runtime 狀態。",
    alternative: {
      action: null,
      summary: "沒有更簡單且同樣安全的替代 action。",
    },
    trace_id: "trace_runtime_closure",
  });

  const actionSlots = collectValuesByKey(plannerEnvelope, [
    "action",
    "selected_action",
    "chosen_action",
  ]);
  const userResponse = normalizeUserResponse({ plannerEnvelope });
  const text = renderUserResponseText(userResponse);

  assert.equal(plannerEnvelope.action, "get_runtime_info");
  assert.equal(plannerEnvelope.execution_result?.kind, "get_runtime_info");
  assert.ok(actionSlots.includes("get_runtime_info"));
  assert.equal(actionSlots.includes("runtime_info"), false);
  assert.equal(JSON.stringify(userResponse).includes("get_runtime_info"), false);
  assert.equal(JSON.stringify(userResponse).includes("runtime_info"), false);
  assert.match(text, /runtime|PID|工作目錄|資料庫路徑/);
  assert.doesNotMatch(text, /get_runtime_info|runtime_info/);
});

test("canonical planner envelope survives planner -> answer -> registered-agent boundaries", async () => {
  const plannerEnvelope = buildPlannedUserInputEnvelope({
    ok: true,
    action: "search_company_brain_docs",
    params: {
      q: "launch checklist",
    },
    execution_result: {
      ok: true,
      kind: "search",
      match_reason: "launch checklist",
      items: [
        {
          title: "Launch Checklist",
          doc_id: "doc_launch_checklist",
          url: "https://example.com/launch-checklist",
          reason: "文件內容直接命中「launch checklist」，且 owner / deadline 欄位都有明確列出。",
        },
      ],
    },
    why: "需求偏向查資料或找文件，先 search 才能定位候選來源。",
    alternative: {
      action: "get_company_brain_doc_detail",
      summary: "若已經有明確 doc_id，也可直接 detail；這輪先 search 是因為尚未鎖定單一文件。",
    },
    trace_id: "trace_search_closure",
  });
  const userResponse = normalizeUserResponse({ plannerEnvelope });
  const agent = getRegisteredAgent("cmo");
  const result = await executeRegisteredAgent({
    accountId: "acct-1",
    agent,
    requestText: "請整理 launch checklist 缺什麼",
    scope: { session_key: "session-planner-contract-closure" },
    searchFn() {
      return {
        items: [
          makeSourceItem(
            "Launch Checklist",
            "https://example.com/launch-checklist",
            "owner / deadline / risks 都需要保持明確。",
          ),
        ],
      };
    },
    async textGenerator() {
      return JSON.stringify(userResponse);
    },
  });

  assert.equal(plannerEnvelope.action, "search_company_brain_docs");
  assert.equal(plannerEnvelope.execution_result?.kind, "search");
  assert.equal(userResponse.ok, true);
  assert.equal(Array.isArray(userResponse.sources), true);
  assert.equal(Array.isArray(userResponse.limitations), true);
  assert.match(result.text, /^結論/m);
  assert.match(result.text, /^重點/m);
  assert.match(result.text, /^下一步/m);
  assert.match(result.text, /Launch Checklist/);
  assert.doesNotMatch(result.text, /"action"|"execution_result"|"kind"|search_company_brain_docs/);
});
