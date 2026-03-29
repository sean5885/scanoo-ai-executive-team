import test from "node:test";
import assert from "node:assert/strict";

import { buildPlannerSkillEnvelope } from "../src/planner/skill-bridge.mjs";
import { createSkillDefinition } from "../src/skill-contract.mjs";
import { defaultSkillRegistry } from "../src/skill-registry.mjs";
import {
  createSkillRegistry,
  listSkillContracts,
  runSkill,
} from "../src/skill-runtime.mjs";

test("search_and_summarize runs through read-runtime and returns planner-usable output", async () => {
  const readerCalls = [];

  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "search_and_summarize",
    input: {
      account_id: "acct_skill_runtime",
      query: "launch checklist",
      limit: 5,
      reader_overrides: {
        index: {
          search_knowledge_base: ({ accountId, payload }) => {
            readerCalls.push({ accountId, payload });
            return {
              success: true,
              data: {
                account: { id: accountId },
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
            };
          },
        },
      },
    },
  });

  assert.equal(readerCalls.length, 1);
  assert.equal(readerCalls[0].accountId, "acct_skill_runtime");
  assert.equal(readerCalls[0].payload.q, "launch checklist");
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
          search_knowledge_base() {
            throw new Error("reader exploded");
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
    },
  ]);
});
