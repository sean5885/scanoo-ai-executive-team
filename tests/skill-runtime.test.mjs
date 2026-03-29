import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  buildPlannerSkillEnvelope,
  createPlannerSkillActionRegistry,
  listPlannerSkillActions,
  runPlannerSkillBridge,
  selectPlannerSkillActionForTaskType,
} from "../src/planner/skill-bridge.mjs";
import { createSkillDefinition } from "../src/skill-contract.mjs";
import { defaultSkillRegistry } from "../src/skill-registry.mjs";
import {
  createSkillRegistry,
  listSkillContracts,
  runSkill,
} from "../src/skill-runtime.mjs";

const SKILL_FILE_URLS = [
  new URL("../src/skills/search-and-summarize-skill.mjs", import.meta.url),
];

test("search_and_summarize runs through read-runtime and returns planner-usable output", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "search_and_summarize",
    input: {
      account_id: "acct_skill_runtime",
      query: "launch checklist",
      limit: 5,
      reader_overrides: {
        index: {
          search_knowledge_base: {
            success: true,
            data: {
              account: { id: "acct_skill_runtime" },
              items: [
                {
                  id: "doc_launch_1:0",
                  snippet: "launch checklist owner timeline and review cadence",
                  metadata: {
                    title: "Launch Runbook",
                    url: "https://example.com/doc_launch_1",
                  },
                },
                {
                  id: "doc_launch_2:0",
                  snippet: "rollout checklist with stage owners and deadline guardrails",
                  metadata: {
                    title: "Rollout Checklist",
                    url: "https://example.com/doc_launch_2",
                  },
                },
              ],
            },
            error: null,
          },
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.skill, "search_and_summarize");
  assert.equal(result.failure_mode, "fail_closed");
  assert.deepEqual(result.side_effects, [
    {
      mode: "read",
      action: "search_knowledge_base",
      runtime: "read-runtime",
      authority: "index",
    },
  ]);
  assert.equal(result.output.found, true);
  assert.equal(result.output.hits, 2);
  assert.match(result.output.summary, /launch checklist/i);
  assert.equal(result.output.sources[0].title, "Launch Runbook");
  assert.equal(result.output.limitations.length, 0);

  const plannerEnvelope = buildPlannerSkillEnvelope(result);
  assert.deepEqual(plannerEnvelope, {
    ok: true,
    action: "skill:search_and_summarize",
    data: {
      skill: "search_and_summarize",
      query: "launch checklist",
      summary: result.output.summary,
      hits: 2,
      found: true,
      sources: [
        {
          id: "doc_launch_1:0",
          title: "Launch Runbook",
          url: "https://example.com/doc_launch_1",
          snippet: "launch checklist owner timeline and review cadence",
        },
        {
          id: "doc_launch_2:0",
          title: "Rollout Checklist",
          url: "https://example.com/doc_launch_2",
          snippet: "rollout checklist with stage owners and deadline guardrails",
        },
      ],
      limitations: [],
      side_effects: [
        {
          mode: "read",
          action: "search_knowledge_base",
          runtime: "read-runtime",
          authority: "index",
        },
      ],
    },
    trace_id: null,
  });
});

test("search_and_summarize fail-closes on empty query", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "search_and_summarize",
    input: {
      account_id: "acct_skill_runtime",
      query: "   ",
    },
  });

  assert.deepEqual(result, {
    ok: false,
    skill: "search_and_summarize",
    failure_mode: "fail_closed",
    error: "contract_violation",
    output: null,
    side_effects: [],
    trace_id: null,
    details: {
      phase: "input_validation",
      violations: [
        {
          type: "required",
          code: "missing_required",
          path: "$input.query",
          expected: "non_empty_string",
          actual: "empty",
          message: "Missing required field $input.query.",
        },
      ],
    },
  });
});

test("search_and_summarize returns deterministic runtime failure without bypassing read-runtime", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "search_and_summarize",
    input: {
      account_id: "acct_skill_runtime_failure",
      query: "launch checklist",
      reader_overrides: {
        index: {
          search_knowledge_base: {
            success: false,
            error: "runtime_exception",
            data: null,
          },
        },
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    skill: "search_and_summarize",
    failure_mode: "fail_closed",
    error: "runtime_exception",
    output: null,
    side_effects: [
      {
        mode: "read",
        action: "search_knowledge_base",
        runtime: "read-runtime",
        authority: "index",
      },
    ],
    trace_id: null,
    details: {
      phase: "read_runtime",
      authorities_attempted: ["index"],
    },
  });
});

test("skill runtime fail-closes when side effects exceed contract", async () => {
  const unsafeSkill = createSkillDefinition({
    name: "unsafe_skill",
    input_schema: {
      type: "object",
    },
    output_schema: {
      type: "object",
      required: ["summary"],
      properties: {
        summary: { type: "string" },
      },
    },
    allowed_side_effects: {
      read: ["search_knowledge_base"],
      write: [],
    },
    skill_class: "read_only",
    runtime_access: ["read_runtime"],
    failure_mode: "fail_closed",
    async run() {
      return {
        ok: true,
        output: {
          summary: "should not be accepted",
        },
        side_effects: [
          {
            mode: "write",
            action: "update_doc",
            runtime: "mutation-runtime",
            authority: "live",
          },
        ],
      };
    },
  });

  const result = await runSkill({
    registry: createSkillRegistry([unsafeSkill]),
    skillName: "unsafe_skill",
    input: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "contract_violation");
  assert.equal(result.details.phase, "side_effect_validation");
  assert.deepEqual(result.details.violations, [
    {
      type: "side_effect",
      code: "side_effect_not_allowed",
      path: "side_effects[0]",
      expected: "none",
      actual: "write:update_doc",
      message: "Side effect write:update_doc is not allowed by the skill contract.",
    },
  ]);
});

test("listSkillContracts exposes the checked-in minimal skill contract", () => {
  const contracts = listSkillContracts({
    registry: defaultSkillRegistry,
  });

  assert.deepEqual(contracts, [
    {
      name: "search_and_summarize",
      input_schema: {
        type: "object",
        required: ["account_id", "query"],
        properties: {
          account_id: { type: "string" },
          query: { type: "string" },
          limit: { type: ["number", "null"] },
          pathname: { type: ["string", "null"] },
          reader_overrides: { type: ["object", "null"] },
        },
      },
      output_schema: {
        type: "object",
        required: ["query", "summary", "hits", "found", "sources", "limitations"],
        properties: {
          query: { type: "string" },
          summary: { type: "string" },
          hits: { type: "number" },
          found: { type: "boolean" },
          limitations: {
            type: "array",
            items: { type: "string" },
          },
          sources: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "title", "url", "snippet"],
              properties: {
                id: { type: ["string", "null"] },
                title: { type: "string" },
                url: { type: ["string", "null"] },
                snippet: { type: "string" },
              },
            },
          },
        },
      },
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
      failure_mode: "fail_closed",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      governance: {
        skill_class: "read_only",
        runtime_access: ["read_runtime"],
        max_skills_per_run: 1,
        allow_skill_chain: false,
        input_must_be_serializable: true,
        output_must_be_serializable: true,
        disallow_side_channel_repo_db_access: true,
      },
    },
  ]);
});

test("createSkillDefinition requires explicit governance metadata", () => {
  assert.throws(() => createSkillDefinition({
    name: "missing_governance",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    allowed_side_effects: {
      read: ["search_knowledge_base"],
      write: [],
    },
    failure_mode: "fail_closed",
    async run() {
      return { ok: true, output: {} };
    },
  }), /invalid_skill_definition/);
});

test("skill runtime fail-closes when input is not JSON-serializable", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "search_and_summarize",
    input: {
      account_id: "acct_non_serializable",
      query: "launch checklist",
      reader_overrides: {
        index: {
          search_knowledge_base() {
            return {
              success: true,
              data: { items: [] },
            };
          },
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "contract_violation");
  assert.equal(result.details.phase, "input_serialization");
  assert.deepEqual(result.details.violations, [
    {
      code: "non_serializable_value",
      path: "$input.reader_overrides.index.search_knowledge_base",
      message: "$input.reader_overrides.index.search_knowledge_base must be JSON-serializable plain data.",
    },
  ]);
});

test("skill runtime rejects skill chaining and keeps max_skills_per_run at one", async () => {
  const nestedSkill = createSkillDefinition({
    name: "nested_skill",
    input_schema: {
      type: "object",
    },
    output_schema: {
      type: "object",
      required: ["summary"],
      properties: {
        summary: { type: "string" },
      },
    },
    allowed_side_effects: {
      read: ["search_knowledge_base"],
      write: [],
    },
    skill_class: "read_only",
    runtime_access: ["read_runtime"],
    failure_mode: "fail_closed",
    async run() {
      const nestedResult = await runSkill({
        registry: defaultSkillRegistry,
        skillName: "search_and_summarize",
        input: {
          account_id: "acct_nested_skill",
          query: "launch checklist",
        },
      });
      return {
        ok: false,
        error: nestedResult.error,
        details: nestedResult.details,
      };
    },
  });

  const result = await runSkill({
    registry: createSkillRegistry([nestedSkill, ...defaultSkillRegistry.values()]),
    skillName: "nested_skill",
    input: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "contract_violation");
  assert.equal(result.details.phase, "governance");
  assert.deepEqual(result.details, {
    phase: "governance",
    message: "skill_chain_not_allowed",
    active_skill: "nested_skill",
    requested_skill: "search_and_summarize",
    max_skills_per_run: 1,
    allow_skill_chain: false,
  });
});

test("planner skill bridge exposes a single read-only skill action and adapts runtime output", async () => {
  const bridgeResult = await runPlannerSkillBridge({
    action: "search_and_summarize",
    payload: {
      account_id: "acct_bridge_runtime",
      q: "launch checklist",
      reader_overrides: {
        index: {
          search_knowledge_base: {
            success: true,
            data: {
              items: [
                {
                  id: "doc_bridge_1:0",
                  snippet: "launch checklist owner timeline and review cadence",
                  metadata: {
                    title: "Launch Runbook",
                    url: "https://example.com/doc_bridge_1",
                  },
                },
              ],
            },
            error: null,
          },
        },
      },
    },
  });

  assert.equal(bridgeResult.ok, true);
  assert.equal(bridgeResult.action, "search_and_summarize");
  assert.equal(bridgeResult.data.skill, "search_and_summarize");
  assert.equal(bridgeResult.data.bridge, "skill_bridge");
  assert.equal(bridgeResult.data.allow_skill_chain, false);
  assert.equal(bridgeResult.data.max_skills_per_run, 1);
  assert.equal(bridgeResult.data.hits, 1);
  assert.deepEqual(listPlannerSkillActions(), [
    {
      action: "search_and_summarize",
      skill_name: "search_and_summarize",
      max_skills_per_run: 1,
      allow_skill_chain: false,
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_task_types: ["knowledge_read_skill", "skill_read"],
      routing_reason: "selector_search_and_summarize_skill",
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
    },
  ]);
});

test("deterministic skill selector keeps existing routing stable when a new non-overlapping skill is added", () => {
  const registry = createPlannerSkillActionRegistry([
    {
      action: "search_and_summarize",
      skill_name: "search_and_summarize",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_task_types: ["skill_read"],
      routing_reason: "selector_search_and_summarize_skill",
      selection_reason: "read-only skill path",
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
    },
    {
      action: "compile_delivery_notes",
      skill_name: "compile_delivery_notes",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_task_types: ["delivery_skill_read"],
      routing_reason: "selector_compile_delivery_notes_skill",
      selection_reason: "delivery skill path",
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
    },
  ]);

  assert.deepEqual(selectPlannerSkillActionForTaskType({
    taskType: "skill_read",
    registry,
  }), {
    ok: true,
    action: "search_and_summarize",
    skill_name: "search_and_summarize",
    routing_reason: "selector_search_and_summarize_skill",
    reason: "read-only skill path",
  });
});

test("deterministic skill selector fail-closes when multiple skills compete for the same task type", () => {
  const registry = createPlannerSkillActionRegistry([
    {
      action: "search_and_summarize",
      skill_name: "search_and_summarize",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_task_types: ["skill_read"],
      routing_reason: "selector_search_and_summarize_skill",
      selection_reason: "read-only skill path",
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
    },
    {
      action: "competing_skill",
      skill_name: "competing_skill",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_task_types: ["skill_read"],
      routing_reason: "selector_competing_skill",
      selection_reason: "competing path",
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
    },
  ]);

  assert.deepEqual(selectPlannerSkillActionForTaskType({
    taskType: "skill_read",
    registry,
  }), {
    ok: false,
    action: null,
    routing_reason: "selector_skill_conflict",
    reason: "",
    error: "selector_conflict",
  });
});

test("checked-in skills do not import repo or DB side-channel dependencies", async () => {
  const disallowedPatterns = [
    /from\s+["']node:fs["']/,
    /from\s+["']fs["']/,
    /from\s+["']better-sqlite3["']/,
    /from\s+["'][^"']*\/db\.mjs["']/,
    /from\s+["']node:path["']/,
  ];

  for (const fileUrl of SKILL_FILE_URLS) {
    const source = await readFile(fileURLToPath(fileUrl), "utf8");
    for (const pattern of disallowedPatterns) {
      assert.equal(pattern.test(source), false, `${fileURLToPath(fileUrl)} matched ${pattern}`);
    }
  }
});
