import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
import {
  buildPlannerSkillEnvelope,
  createPlannerSkillActionRegistry,
  getPlannerSkillAction,
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
  new URL("../src/skills/document-summarize-skill.mjs", import.meta.url),
  new URL("../src/skills/image-generate-skill.mjs", import.meta.url),
  new URL("../src/skills/search-and-summarize-skill.mjs", import.meta.url),
];

test.after(() => {
  testDb.close();
});

function buildDocumentDetailOverride({
  accountId = "acct_document_skill",
  docId = "doc_default",
  title = "Document Title",
  url = "https://example.com/doc_default",
  summary = {},
} = {}) {
  return {
    mirror: {
      get_company_brain_doc_detail: {
        success: true,
        data: {
          doc: {
            doc_id: docId,
            title,
            url,
            source: "mirror",
            created_at: "2026-03-20T00:00:00.000Z",
            creator: {
              account_id: accountId,
              open_id: `ou_${docId}`,
            },
          },
          summary,
          learning_state: {
            status: "learned",
            structured_summary: {
              overview: "",
              headings: [],
              highlights: [],
              snippet: "",
              content_length: 0,
            },
            key_concepts: [],
            tags: [],
            notes: "",
            learned_at: null,
            updated_at: null,
          },
        },
        error: null,
      },
    },
  };
}

function assertDocumentSummarizeReadOnlyBoundary(result, {
  authority = "mirror",
} = {}) {
  assert.deepEqual(result.side_effects, [
    {
      mode: "read",
      action: "get_company_brain_doc_detail",
      runtime: "read-runtime",
      authority,
    },
  ]);
}

function assertDocumentSummarizeStableShape(result, {
  docId,
  title,
  found,
  hits,
  authority = "mirror",
} = {}) {
  assert.equal(result.ok, true);
  assert.equal(result.skill, "document_summarize");
  assert.equal(result.failure_mode, "fail_closed");
  assertDocumentSummarizeReadOnlyBoundary(result, { authority });
  assert.deepEqual(Object.keys(result.output).sort(), [
    "doc_id",
    "found",
    "hits",
    "limitations",
    "sources",
    "summary",
    "title",
  ]);
  assert.equal(result.output.doc_id, docId);
  assert.equal(result.output.title, title);
  assert.equal(result.output.found, found);
  assert.equal(result.output.hits, hits);
  assert.equal(typeof result.output.summary, "string");
  assert.ok(Array.isArray(result.output.limitations));
  assert.ok(Array.isArray(result.output.sources));
  assert.equal(result.output.sources.length, 1);

  const plannerEnvelope = buildPlannerSkillEnvelope(result);
  assert.deepEqual(Object.keys(plannerEnvelope.data).sort(), [
    "doc_id",
    "found",
    "hits",
    "limitations",
    "side_effects",
    "skill",
    "sources",
    "summary",
    "title",
  ]);
  assert.equal(plannerEnvelope.ok, true);
  assert.equal(plannerEnvelope.action, "skill:document_summarize");
  assert.equal(plannerEnvelope.data.skill, "document_summarize");
  assert.equal(plannerEnvelope.data.doc_id, docId);
  assert.equal(plannerEnvelope.data.title, title);
  assert.equal(plannerEnvelope.data.found, found);
  assert.equal(plannerEnvelope.data.hits, hits);
  assert.equal(typeof plannerEnvelope.data.summary, "string");
  assert.ok(Array.isArray(plannerEnvelope.data.limitations));
  assert.ok(Array.isArray(plannerEnvelope.data.sources));
  assert.deepEqual(plannerEnvelope.data.side_effects, result.side_effects);
}

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

test("image_generate returns a stable placeholder image result through the checked-in skill runtime", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "image_generate",
    input: {
      prompt: "cat astronaut",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.skill, "image_generate");
  assert.equal(result.failure_mode, "fail_closed");
  assert.deepEqual(result.side_effects, []);
  assert.deepEqual(result.output, {
    prompt: "cat astronaut",
    url: "https://dummyimage.com/512x512/000/fff.png&text=cat%20astronaut",
  });

  const plannerEnvelope = buildPlannerSkillEnvelope(result);
  assert.deepEqual(plannerEnvelope.data, {
    skill: "image_generate",
    prompt: "cat astronaut",
    url: "https://dummyimage.com/512x512/000/fff.png&text=cat%20astronaut",
    summary: null,
    hits: 1,
    found: true,
    sources: [],
    limitations: [],
    side_effects: [],
  });
});

test("image_generate fail-closes on empty prompt", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "image_generate",
    input: {
      prompt: "   ",
    },
  });

  assert.deepEqual(result, {
    ok: false,
    skill: "image_generate",
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
          path: "$input.prompt",
          expected: "non_empty_string",
          actual: "empty",
          message: "Missing required field $input.prompt.",
        },
      ],
    },
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

test("search_and_summarize keeps the same output shape when results contain markdown and link noise", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "search_and_summarize",
    input: {
      account_id: "acct_skill_runtime_noise",
      query: "launch checklist",
      reader_overrides: {
        index: {
          search_knowledge_base: {
            success: true,
            data: {
              items: [
                {
                  id: "doc_noise_1:0",
                  snippet: "Back to [README.md](/Users/seanhan/Documents/Playground/README.md)\n- [Ship checklist](https://example.com/checklist)\n- owner: ops",
                  metadata: {
                    title: "Noisy Notes",
                    url: "https://example.com/noisy-notes",
                  },
                },
                {
                  id: "doc_noise_2:0",
                  snippet: "## TODO\n\nowner: eng\n\nstatus: ready",
                  metadata: {
                    title: "Roadmap Draft",
                    url: "https://example.com/roadmap-draft",
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
  assert.deepEqual(Object.keys(result.output).sort(), [
    "found",
    "hits",
    "limitations",
    "query",
    "sources",
    "summary",
  ]);
  assert.equal(result.output.query, "launch checklist");
  assert.equal(result.output.hits, 2);
  assert.equal(result.output.sources.length, 2);
  assert.equal(typeof result.output.summary, "string");
  assert.ok(Array.isArray(result.output.limitations));
  assert.match(result.output.summary, /Noisy Notes/);
  assert.match(result.output.summary, /Roadmap Draft/);
  assert.match(result.output.summary, /Ship checklist owner: ops/i);
  assert.match(result.output.summary, /owner: eng status: ready/i);
  assert.match(result.output.sources[0].snippet, /Ship checklist owner: ops/i);
  assert.match(result.output.sources[1].snippet, /owner: eng status: ready/i);
  assert.doesNotMatch(result.output.summary, /\/Users\/|Back to \[?README|https:\/\/example\.com\/checklist/);
  assert.doesNotMatch(result.output.sources.map((item) => item.snippet).join(" "), /\/Users\/|Back to \[?README|https:\/\/example\.com\/checklist/);
});

test("search_and_summarize trims long result snippets deterministically and keeps preview limits stable", async () => {
  const longSnippet = "launch guardrail ".repeat(20);
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "search_and_summarize",
    input: {
      account_id: "acct_skill_runtime_long",
      query: "launch guardrail",
      reader_overrides: {
        index: {
          search_knowledge_base: {
            success: true,
            data: {
              items: [
                {
                  id: "doc_long_1:0",
                  snippet: longSnippet,
                  metadata: {
                    title: "Long Guardrail Note",
                    url: "https://example.com/long-guardrail-note",
                  },
                },
                {
                  id: "doc_long_2:0",
                  snippet: "owner cadence",
                  metadata: {
                    title: "Owner Cadence",
                    url: "https://example.com/owner-cadence",
                  },
                },
                {
                  id: "doc_long_3:0",
                  snippet: "risk checklist",
                  metadata: {
                    title: "Risk Checklist",
                    url: "https://example.com/risk-checklist",
                  },
                },
                {
                  id: "doc_long_4:0",
                  snippet: "extra fallback note",
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
  });

  assert.equal(result.ok, true);
  assert.equal(result.output.hits, 4);
  assert.equal(result.output.sources.length, 3);
  assert.equal(result.output.sources[0].snippet.endsWith("..."), true);
  assert.match(result.output.summary, /找到 4 筆/);
  assert.deepEqual(result.output.limitations, [
    "僅摘要前 3 筆來源，其餘結果未展開。",
  ]);
});

test("search_and_summarize preserves multilingual search results without changing the stable output contract", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "search_and_summarize",
    input: {
      account_id: "acct_skill_runtime_multilingual",
      query: "跨語系 launch plan",
      reader_overrides: {
        index: {
          search_knowledge_base: {
            success: true,
            data: {
              items: [
                {
                  id: "doc_multi_1:0",
                  snippet: "混合語言摘要片段 mixed-language snippet 與负责人 owner",
                  metadata: {
                    title: "跨語 Launch Plan",
                    url: "https://example.com/multilingual-launch-plan",
                  },
                },
                {
                  id: "doc_multi_2:0",
                  snippet: "日本語メモ release window と依賴項目",
                  metadata: {
                    title: "Release Window JP",
                    url: "https://example.com/release-window-jp",
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
  assert.deepEqual(Object.keys(result.output).sort(), [
    "found",
    "hits",
    "limitations",
    "query",
    "sources",
    "summary",
  ]);
  assert.equal(result.output.query, "跨語系 launch plan");
  assert.equal(result.output.hits, 2);
  assert.equal(result.output.found, true);
  assert.match(result.output.summary, /跨語系 launch plan/);
  assert.equal(result.output.sources[0].title, "跨語 Launch Plan");
  assert.match(result.output.sources[0].snippet, /mixed-language snippet/);
  assert.match(result.output.sources[1].snippet, /日本語メモ release window と依賴項目/);
  assert.equal(result.output.limitations.length, 0);
});

test("document_summarize runs through read-runtime and returns a single-document summary", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "document_summarize",
    input: {
      account_id: "acct_document_skill",
      doc_id: "doc_delivery_1",
      reader_overrides: {
        mirror: {
          get_company_brain_doc_detail: {
            success: true,
            data: {
              doc: {
                doc_id: "doc_delivery_1",
                title: "Delivery SOP",
                url: "https://example.com/doc_delivery_1",
                source: "mirror",
                created_at: "2026-03-20T00:00:00.000Z",
                creator: {
                  account_id: "acct_document_skill",
                  open_id: "ou_delivery",
                },
              },
              summary: {
                overview: "這份文件說明交付 SOP 與驗收節點。",
                headings: ["交付節奏", "驗收條件", "風險處理"],
                highlights: ["每週二同步交付狀態", "驗收需附 owner 與 deadline", "異常情況要在 24 小時內升級"],
                snippet: "交付 SOP 與驗收節點整理",
                content_length: 1200,
              },
              learning_state: {
                status: "learned",
                structured_summary: {
                  overview: "learning summary",
                  headings: [],
                  highlights: [],
                  snippet: "learning snippet",
                  content_length: 320,
                },
                key_concepts: ["delivery", "acceptance"],
                tags: ["ops"],
                notes: "",
                learned_at: "2026-03-21T00:00:00.000Z",
                updated_at: "2026-03-21T00:00:00.000Z",
              },
            },
            error: null,
          },
        },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.skill, "document_summarize");
  assert.deepEqual(result.side_effects, [
    {
      mode: "read",
      action: "get_company_brain_doc_detail",
      runtime: "read-runtime",
      authority: "mirror",
    },
  ]);
  assert.equal(result.output.doc_id, "doc_delivery_1");
  assert.equal(result.output.title, "Delivery SOP");
  assert.equal(result.output.found, true);
  assert.equal(result.output.hits, 1);
  assert.match(result.output.summary, /交付 SOP/i);
  assert.match(result.output.summary, /交付節奏/);
  assert.equal(result.output.sources[0].title, "Delivery SOP");
  assert.equal(result.output.limitations.length, 1);

  const plannerEnvelope = buildPlannerSkillEnvelope(result);
  assert.deepEqual(plannerEnvelope, {
    ok: true,
    action: "skill:document_summarize",
    data: {
      skill: "document_summarize",
      doc_id: "doc_delivery_1",
      title: "Delivery SOP",
      summary: result.output.summary,
      hits: 1,
      found: true,
      sources: [
        {
          id: "doc_delivery_1",
          title: "Delivery SOP",
          url: "https://example.com/doc_delivery_1",
          snippet: "交付 SOP 與驗收節點整理",
        },
      ],
      limitations: ["僅保留前 2 個重點。"],
      side_effects: [
        {
          mode: "read",
          action: "get_company_brain_doc_detail",
          runtime: "read-runtime",
          authority: "mirror",
        },
      ],
    },
    trace_id: null,
  });
});

test("document_summarize keeps a stable shape for an empty document without bypassing the read-only boundary", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "document_summarize",
    input: {
      account_id: "acct_document_skill_empty",
      doc_id: "doc_empty_1",
      reader_overrides: buildDocumentDetailOverride({
        accountId: "acct_document_skill_empty",
        docId: "doc_empty_1",
        title: "Empty Draft",
      }),
    },
  });

  assertDocumentSummarizeStableShape(result, {
    docId: "doc_empty_1",
    title: "Empty Draft",
    found: true,
    hits: 1,
  });
  assert.match(result.output.summary, /文件「Empty Draft」摘要：已整理可用內容。/);
  assert.deepEqual(result.output.limitations, ["文件缺少可用的結構化摘要，只能回傳基本文件資訊。"]);
  assert.equal(result.output.sources[0].snippet, "目前沒有可用的摘要片段。");
});

test("document_summarize remains stable for very long documents and trims heading highlight previews deterministically", async () => {
  const longOverview = "長文件概覽 ".repeat(120);
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "document_summarize",
    input: {
      account_id: "acct_document_skill_long",
      doc_id: "doc_long_1",
      reader_overrides: buildDocumentDetailOverride({
        accountId: "acct_document_skill_long",
        docId: "doc_long_1",
        title: "Long Spec",
        summary: {
          overview: longOverview,
          headings: ["章節一", "章節二", "章節三", "章節四", "章節五"],
          highlights: ["重點一", "重點二", "重點三", "重點四"],
          snippet: "長文件摘要片段",
          content_length: 200000,
        },
      }),
    },
  });

  assertDocumentSummarizeStableShape(result, {
    docId: "doc_long_1",
    title: "Long Spec",
    found: true,
    hits: 1,
  });
  assert.match(result.output.summary, /長文件概覽/);
  assert.match(result.output.summary, /重點段落：章節一、章節二、章節三/);
  assert.doesNotMatch(result.output.summary, /章節四|章節五/);
  assert.match(result.output.summary, /關鍵資訊：重點一；重點二/);
  assert.doesNotMatch(result.output.summary, /重點三|重點四/);
  assert.deepEqual(result.output.limitations, [
    "僅保留前 3 個段落標題。",
    "僅保留前 2 個重點。",
  ]);
});

test("document_summarize keeps the same output shape when document summaries contain markdown list and link noise", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "document_summarize",
    input: {
      account_id: "acct_document_skill_noise",
      doc_id: "doc_noise_1",
      reader_overrides: buildDocumentDetailOverride({
        accountId: "acct_document_skill_noise",
        docId: "doc_noise_1",
        title: "Noisy Notes",
        summary: {
          overview: "# TODO\n- [Ship checklist](https://example.com/checklist)\n- owner: ops",
          headings: ["## Scope", "- Risks"],
          highlights: ["[verify](https://example.com/verify)", "`link + markdown`"],
          snippet: "Back to [README.md](/Users/seanhan/Documents/Playground/README.md)\n- noisy snippet",
          content_length: 300,
        },
      }),
    },
  });

  assertDocumentSummarizeStableShape(result, {
    docId: "doc_noise_1",
    title: "Noisy Notes",
    found: true,
    hits: 1,
  });
  assert.match(result.output.summary, /Ship checklist/);
  assert.match(result.output.summary, /https:\/\/example\.com\/checklist/);
  assert.match(result.output.sources[0].snippet, /Back to \[README\.md\]/);
});

test("document_summarize fail-closes retrieval misses instead of inventing a summary", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "document_summarize",
    input: {
      account_id: "acct_document_skill_missing",
      doc_id: "doc_missing_1",
      reader_overrides: {
        mirror: {
          get_company_brain_doc_detail: {
            success: false,
            error: "not_found",
            data: {},
          },
        },
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    skill: "document_summarize",
    failure_mode: "fail_closed",
    error: "not_found",
    output: null,
    side_effects: [
      {
        mode: "read",
        action: "get_company_brain_doc_detail",
        runtime: "read-runtime",
        authority: "mirror",
      },
    ],
    trace_id: null,
    details: {
      phase: "read_runtime",
      intent_unfulfilled: true,
      criteria_failed: "read_runtime",
      authorities_attempted: ["mirror"],
    },
  });

  const plannerEnvelope = buildPlannerSkillEnvelope(result);
  assert.deepEqual(plannerEnvelope, {
    ok: false,
    action: "skill:document_summarize",
    error: "not_found",
    data: {
      skill: "document_summarize",
      stop_reason: "fail_closed",
      phase: "read_runtime",
      side_effects: [
        {
          mode: "read",
          action: "get_company_brain_doc_detail",
          runtime: "read-runtime",
          authority: "mirror",
        },
      ],
    },
    trace_id: null,
  });
});

test("planner skill bridge emits one process-local reflection record on skill failure", async () => {
  const reflectionLog = [];
  const previousAppendReflectionLog = globalThis.appendReflectionLog;
  globalThis.appendReflectionLog = (entry) => {
    reflectionLog.push(entry);
  };

  try {
    const bridgeResult = await runPlannerSkillBridge({
      action: "document_summarize",
      payload: {
        account_id: "acct_bridge_reflection",
        doc_id: "doc_bridge_reflection_missing",
        reader_overrides: {
          mirror: {
            get_company_brain_doc_detail: {
              success: false,
              error: "not_found",
              data: {},
            },
          },
        },
      },
    });

    assert.equal(bridgeResult.ok, false);
    assert.equal(reflectionLog.length, 1);
    assert.equal(reflectionLog[0].type, "skill_bridge_failure");
    assert.equal(reflectionLog[0].skill, "document_summarize");
    assert.equal(reflectionLog[0].action, "document_summarize");
    assert.equal(reflectionLog[0].error, "not_found");
    assert.equal(reflectionLog[0].failure_mode, "fail_closed");
    assert.equal(reflectionLog[0].phase, "read_runtime");
    assert.equal(reflectionLog[0].intent_unfulfilled, true);
    assert.equal(reflectionLog[0].criteria_failed, "read_runtime");
    assert.deepEqual(reflectionLog[0].side_effects, [
      {
        mode: "read",
        action: "get_company_brain_doc_detail",
        runtime: "read-runtime",
        authority: "mirror",
      },
    ]);
    assert.equal(typeof reflectionLog[0].ts, "number");
  } finally {
    if (previousAppendReflectionLog === undefined) {
      delete globalThis.appendReflectionLog;
    } else {
      globalThis.appendReflectionLog = previousAppendReflectionLog;
    }
  }
});

test("document_summarize stays stable when the document exists but its content is explicitly empty", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "document_summarize",
    input: {
      account_id: "acct_document_skill_blank",
      doc_id: "doc_blank_1",
      reader_overrides: buildDocumentDetailOverride({
        accountId: "acct_document_skill_blank",
        docId: "doc_blank_1",
        title: "Blank Template",
        summary: {
          overview: "   ",
          headings: [],
          highlights: [],
          snippet: "",
          content_length: 0,
        },
      }),
    },
  });

  assertDocumentSummarizeStableShape(result, {
    docId: "doc_blank_1",
    title: "Blank Template",
    found: true,
    hits: 1,
  });
  assert.match(result.output.summary, /文件「Blank Template」摘要：已整理可用內容。/);
  assert.deepEqual(result.output.limitations, ["文件缺少可用的結構化摘要，只能回傳基本文件資訊。"]);
  assert.equal(result.output.sources[0].snippet, "目前沒有可用的摘要片段。");
});

test("document_summarize preserves multilingual summaries without changing the stable output contract", async () => {
  const result = await runSkill({
    registry: defaultSkillRegistry,
    skillName: "document_summarize",
    input: {
      account_id: "acct_document_skill_multi",
      doc_id: "doc_multi_1",
      reader_overrides: buildDocumentDetailOverride({
        accountId: "acct_document_skill_multi",
        docId: "doc_multi_1",
        title: "Global Launch Notes",
        summary: {
          overview: "這份文件整理 launch checklist、担当者、次の一手。",
          headings: ["中文摘要", "English Checklist", "日本語メモ"],
          highlights: ["owner: 小明", "next action: review rollout", "期限: 来週月曜"],
          snippet: "混合語言摘要片段 mixed-language snippet",
          content_length: 640,
        },
      }),
    },
  });

  assertDocumentSummarizeStableShape(result, {
    docId: "doc_multi_1",
    title: "Global Launch Notes",
    found: true,
    hits: 1,
  });
  assert.match(result.output.summary, /launch checklist/);
  assert.match(result.output.summary, /日本語メモ/);
  assert.match(result.output.summary, /owner: 小明/);
  assert.deepEqual(result.output.limitations, ["僅保留前 2 個重點。"]);
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
    {
      name: "document_summarize",
      input_schema: {
        type: "object",
        required: ["account_id", "doc_id"],
        properties: {
          account_id: { type: "string" },
          doc_id: { type: "string" },
          pathname: { type: ["string", "null"] },
          reader_overrides: { type: ["object", "null"] },
        },
      },
      output_schema: {
        type: "object",
        required: ["doc_id", "title", "summary", "hits", "found", "sources", "limitations"],
        properties: {
          doc_id: { type: "string" },
          title: { type: "string" },
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
        read: ["get_company_brain_doc_detail"],
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
    {
      name: "image_generate",
      input_schema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string" },
        },
      },
      output_schema: {
        type: "object",
        required: ["prompt", "url"],
        properties: {
          prompt: { type: "string" },
          url: { type: "string" },
        },
      },
      allowed_side_effects: {
        read: [],
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

test("planner skill bridge exposes checked-in read-only skill actions and adapts runtime output", async () => {
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
      surface_layer: "planner_visible",
      max_skills_per_run: 1,
      allow_skill_chain: false,
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.search_and_summarize.read",
      selector_task_types: ["knowledge_read_skill", "skill_read"],
      routing_reason: "selector_search_and_summarize_skill",
      planner_catalog_eligible: true,
      raw_user_output_allowed: false,
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
    },
    {
      action: "image_generate",
      skill_name: "image_generate",
      surface_layer: "internal_only",
      max_skills_per_run: 1,
      allow_skill_chain: false,
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.image_generate.internal",
      selector_task_types: [],
      routing_reason: "selector_image_generate_skill",
      planner_catalog_eligible: false,
      raw_user_output_allowed: false,
      allowed_side_effects: {
        read: [],
        write: [],
      },
    },
    {
      action: "document_summarize",
      skill_name: "document_summarize",
      surface_layer: "planner_visible",
      max_skills_per_run: 1,
      allow_skill_chain: false,
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.document_summarize.read",
      selector_task_types: ["document_summary_skill"],
      routing_reason: "selector_document_summarize_skill",
      planner_catalog_eligible: true,
      raw_user_output_allowed: false,
      allowed_side_effects: {
        read: ["get_company_brain_doc_detail"],
        write: [],
      },
    },
  ]);
});

test("image_generate bridge action executes through the checked-in planner skill bridge", async () => {
  const bridgeResult = await runPlannerSkillBridge({
    action: "image_generate",
    payload: {
      prompt: "launch poster",
    },
  });

  assert.deepEqual(bridgeResult, {
    ok: true,
    action: "image_generate",
    data: {
      skill: "image_generate",
      bridge: "skill_bridge",
      max_skills_per_run: 1,
      allow_skill_chain: false,
      prompt: "launch poster",
      url: "https://dummyimage.com/512x512/000/fff.png&text=launch%20poster",
      summary: null,
      hits: 1,
      found: true,
      sources: [],
      limitations: [],
      side_effects: [],
    },
    trace_id: null,
  });
});

test("image_generate stays internal_only and out of the planner-visible catalog", () => {
  const entry = getPlannerSkillAction("image_generate");

  assert.equal(entry?.surface_layer, "internal_only");
  assert.equal(entry?.promotion_stage, "internal_only");
  assert.equal(entry?.previous_promotion_stage, null);
  assert.equal(entry?.planner_catalog_eligible, false);
  assert.equal(entry?.selector_key, "skill.image_generate.internal");
  assert.deepEqual(entry?.selector_task_types, []);
});

test("deterministic skill selector keeps existing routing stable when a new non-overlapping skill is added", () => {
  const registry = createPlannerSkillActionRegistry([
    {
      action: "search_and_summarize",
      skill_name: "search_and_summarize",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.search_and_summarize.read",
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
      selector_key: "skill.compile_delivery_notes.read",
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

test("document_summarize planner_visible metadata stays fully gated and catalog-eligible", () => {
  const entry = getPlannerSkillAction("document_summarize");

  assert.equal(entry?.surface_layer, "planner_visible");
  assert.equal(entry?.promotion_stage, "planner_visible");
  assert.equal(entry?.previous_promotion_stage, "readiness_check");
  assert.equal(entry?.planner_catalog_eligible, true);
  assert.equal(entry?.selector_key, "skill.document_summarize.read");
  assert.deepEqual(entry?.selector_task_types, ["document_summary_skill"]);
  assert.deepEqual(entry?.readiness_gate, {
    regression_suite_passed: true,
    answer_pipeline_enforced: true,
    observability_evidence_verified: true,
    raw_skill_output_blocked: true,
    output_shape_stable: true,
    side_effect_boundary_locked: true,
  });
});

test("search_and_summarize planner_visible metadata stays gated behind the admission boundary", () => {
  const entry = getPlannerSkillAction("search_and_summarize");

  assert.equal(entry?.surface_layer, "planner_visible");
  assert.equal(entry?.promotion_stage, "planner_visible");
  assert.equal(entry?.previous_promotion_stage, "readiness_check");
  assert.equal(entry?.planner_catalog_eligible, true);
  assert.equal(entry?.selector_key, "skill.search_and_summarize.read");
  assert.deepEqual(entry?.selector_task_types, ["knowledge_read_skill", "skill_read"]);
  assert.deepEqual(entry?.readiness_gate, {
    regression_suite_passed: true,
    answer_pipeline_enforced: true,
    observability_evidence_verified: true,
    raw_skill_output_blocked: true,
    output_shape_stable: true,
    side_effect_boundary_locked: true,
  });
  assert.deepEqual(entry?.planner_admission_boundary, {
    require_signals: ["wants_document_search", "wants_search_summary"],
    forbid_signals: ["wants_document_detail", "wants_document_list", "explicit_same_task", "wants_scoped_doc_exclusion_search"],
    fail_closed_on_ambiguity: true,
  });
});

test("planner_visible document_summarize admission succeeds when readiness metadata is complete", () => {
  const registry = createPlannerSkillActionRegistry([
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
      selection_reason: "document summary path",
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
  ]);

  assert.equal(registry.get("document_summarize")?.planner_catalog_eligible, true);
});

test("deterministic skill selector fail-closes when multiple skills compete for the same task type", () => {
  const registry = createPlannerSkillActionRegistry([
    {
      action: "search_and_summarize",
      skill_name: "search_and_summarize",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.search_and_summarize.read",
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
      selector_key: "skill.competing.read",
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

test("deterministic skill selector fail-closes when two skills claim the same selector key", () => {
  const registry = createPlannerSkillActionRegistry([
    {
      action: "document_summarize",
      skill_name: "document_summarize",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.document.read",
      selector_task_types: ["document_summary_skill"],
      routing_reason: "selector_document_summarize_skill",
      selection_reason: "document summary path",
      allowed_side_effects: {
        read: ["get_company_brain_doc_detail"],
        write: [],
      },
    },
    {
      action: "duplicate_document_skill",
      skill_name: "duplicate_document_skill",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.document.read",
      selector_task_types: ["document_summary_skill_alt"],
      routing_reason: "selector_duplicate_document_skill",
      selection_reason: "duplicate path",
      allowed_side_effects: {
        read: ["get_company_brain_doc_detail"],
        write: [],
      },
    },
  ]);

  assert.deepEqual(selectPlannerSkillActionForTaskType({
    taskType: "document_summary_skill",
    registry,
  }), {
    ok: false,
    action: null,
    routing_reason: "selector_skill_conflict",
    reason: "",
    error: "selector_conflict",
  });
});

test("readiness_check candidate fails closed when previous stage is not recorded", () => {
  assert.throws(() => createPlannerSkillActionRegistry([
    {
      action: "document_summarize",
      skill_name: "document_summarize",
      surface_layer: "internal_only",
      promotion_stage: "readiness_check",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.document_summarize.read",
      selector_task_types: ["document_summary_skill"],
      routing_reason: "selector_document_summarize_skill",
      selection_reason: "document summary path",
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

test("readiness_check candidate fails closed when readiness evidence is incomplete", () => {
  assert.throws(() => createPlannerSkillActionRegistry([
    {
      action: "document_summarize",
      skill_name: "document_summarize",
      surface_layer: "internal_only",
      promotion_stage: "readiness_check",
      previous_promotion_stage: "internal_only",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.document_summarize.read",
      selector_task_types: ["document_summary_skill"],
      routing_reason: "selector_document_summarize_skill",
      selection_reason: "document summary path",
      readiness_gate: {
        regression_suite_passed: true,
        answer_pipeline_enforced: true,
        observability_evidence_verified: true,
        raw_skill_output_blocked: true,
        output_shape_stable: true,
        side_effect_boundary_locked: false,
      },
      allowed_side_effects: {
        read: ["get_company_brain_doc_detail"],
        write: [],
      },
    },
  ]), /invalid_planner_skill_surface_policy/);
});

test("readiness_check candidate fails closed when observability evidence is missing", () => {
  assert.throws(() => createPlannerSkillActionRegistry([
    {
      action: "search_and_summarize",
      skill_name: "search_and_summarize",
      surface_layer: "internal_only",
      promotion_stage: "readiness_check",
      previous_promotion_stage: "internal_only",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.search_and_summarize.read",
      selector_task_types: ["knowledge_read_skill", "skill_read"],
      routing_reason: "selector_search_and_summarize_skill",
      selection_reason: "search summary path",
      readiness_gate: {
        regression_suite_passed: true,
        answer_pipeline_enforced: true,
        observability_evidence_verified: false,
        raw_skill_output_blocked: true,
        output_shape_stable: true,
        side_effect_boundary_locked: true,
      },
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
    },
  ]), /invalid_planner_skill_surface_policy/);
});

test("planner-visible skill candidate fails closed when it jumps directly from internal_only", () => {
  assert.throws(() => createPlannerSkillActionRegistry([
    {
      action: "jump_visible_skill",
      skill_name: "jump_visible_skill",
      surface_layer: "planner_visible",
      promotion_stage: "planner_visible",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.jump_visible.read",
      selector_task_types: ["jump_visible_skill"],
      routing_reason: "selector_jump_visible_skill",
      selection_reason: "jump visible path",
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
      readiness_gate: {
        regression_suite_passed: true,
        answer_pipeline_enforced: true,
        observability_evidence_verified: true,
        raw_skill_output_blocked: true,
        output_shape_stable: true,
        side_effect_boundary_locked: true,
      },
    },
  ]), /invalid_planner_skill_surface_policy/);
});

test("planner-visible stage metadata fails closed when mixed with internal_only surface", () => {
  assert.throws(() => createPlannerSkillActionRegistry([
    {
      action: "surface_mixed_visible_skill",
      skill_name: "surface_mixed_visible_skill",
      surface_layer: "internal_only",
      promotion_stage: "planner_visible",
      previous_promotion_stage: "readiness_check",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.surface_mixed_visible.read",
      selector_task_types: ["surface_mixed_visible_skill"],
      routing_reason: "selector_surface_mixed_visible_skill",
      selection_reason: "surface mixed visible path",
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
      readiness_gate: {
        regression_suite_passed: true,
        answer_pipeline_enforced: true,
        observability_evidence_verified: true,
        raw_skill_output_blocked: true,
        output_shape_stable: true,
        side_effect_boundary_locked: true,
      },
    },
  ]), /invalid_planner_skill_surface_policy/);
});

test("planner-visible skill candidate fails closed when readiness_check regression gate is not satisfied", () => {
  assert.throws(() => createPlannerSkillActionRegistry([
    {
      action: "regression_unready_visible_skill",
      skill_name: "regression_unready_visible_skill",
      surface_layer: "planner_visible",
      promotion_stage: "planner_visible",
      previous_promotion_stage: "readiness_check",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.regression_unready_visible.read",
      selector_task_types: ["regression_unready_visible_skill"],
      routing_reason: "selector_regression_unready_visible_skill",
      selection_reason: "regression unready visible path",
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
      readiness_gate: {
        regression_suite_passed: false,
        answer_pipeline_enforced: true,
        observability_evidence_verified: true,
        raw_skill_output_blocked: true,
        output_shape_stable: true,
        side_effect_boundary_locked: true,
      },
    },
  ]), /invalid_planner_skill_surface_policy/);
});

test("planner-visible skill candidate fails closed when answer pipeline could be bypassed", () => {
  assert.throws(() => createPlannerSkillActionRegistry([
    {
      action: "answer_bypass_visible_skill",
      skill_name: "answer_bypass_visible_skill",
      surface_layer: "planner_visible",
      promotion_stage: "planner_visible",
      previous_promotion_stage: "readiness_check",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.answer_bypass_visible.read",
      selector_task_types: ["answer_bypass_visible_skill"],
      routing_reason: "selector_answer_bypass_visible_skill",
      selection_reason: "answer bypass visible path",
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
      readiness_gate: {
        regression_suite_passed: true,
        answer_pipeline_enforced: false,
        observability_evidence_verified: true,
        raw_skill_output_blocked: true,
        output_shape_stable: true,
        side_effect_boundary_locked: true,
      },
    },
  ]), /invalid_planner_skill_surface_policy/);
});

test("planner-visible skill candidate fails closed when observability evidence is missing", () => {
  assert.throws(() => createPlannerSkillActionRegistry([
    {
      action: "observability_unready_visible_skill",
      skill_name: "observability_unready_visible_skill",
      surface_layer: "planner_visible",
      promotion_stage: "planner_visible",
      previous_promotion_stage: "readiness_check",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.observability_unready_visible.read",
      selector_task_types: ["observability_unready_visible_skill"],
      routing_reason: "selector_observability_unready_visible_skill",
      selection_reason: "observability unready visible path",
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
      readiness_gate: {
        regression_suite_passed: true,
        answer_pipeline_enforced: true,
        observability_evidence_verified: false,
        raw_skill_output_blocked: true,
        output_shape_stable: true,
        side_effect_boundary_locked: true,
      },
    },
  ]), /invalid_planner_skill_surface_policy/);
});

test("planner-visible skill candidate fails closed on selector drift against an existing deterministic skill", () => {
  assert.throws(() => createPlannerSkillActionRegistry([
    {
      action: "search_and_summarize",
      skill_name: "search_and_summarize",
      surface_layer: "internal_only",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.search_and_summarize.read",
      selector_task_types: ["skill_read"],
      routing_reason: "selector_search_and_summarize_skill",
      selection_reason: "read-only skill path",
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
    },
    {
      action: "drift_visible_skill",
      skill_name: "drift_visible_skill",
      surface_layer: "planner_visible",
      promotion_stage: "planner_visible",
      previous_promotion_stage: "readiness_check",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.drift_visible.read",
      selector_task_types: ["skill_read"],
      routing_reason: "selector_drift_visible_skill",
      selection_reason: "drift visible path",
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: [],
      },
      readiness_gate: {
        regression_suite_passed: true,
        answer_pipeline_enforced: true,
        observability_evidence_verified: true,
        raw_skill_output_blocked: true,
        output_shape_stable: true,
        side_effect_boundary_locked: true,
      },
    },
  ]), /invalid_planner_skill_surface_policy/);
});

test("planner-visible skill candidate fails closed when output shape or side-effect boundary is unstable", () => {
  assert.throws(() => createPlannerSkillActionRegistry([
    {
      action: "unstable_visible_skill",
      skill_name: "unstable_visible_skill",
      surface_layer: "planner_visible",
      promotion_stage: "planner_visible",
      previous_promotion_stage: "readiness_check",
      skill_class: "read_only",
      runtime_access: ["read_runtime"],
      selector_mode: "deterministic_only",
      selector_key: "skill.unstable_visible.read",
      selector_task_types: ["unstable_visible_skill"],
      routing_reason: "selector_unstable_visible_skill",
      selection_reason: "unstable visible path",
      allowed_side_effects: {
        read: ["search_knowledge_base"],
        write: ["create_doc"],
      },
      readiness_gate: {
        regression_suite_passed: true,
        answer_pipeline_enforced: true,
        observability_evidence_verified: true,
        raw_skill_output_blocked: true,
        output_shape_stable: false,
        side_effect_boundary_locked: false,
      },
    },
  ]), /invalid_planner_skill_surface_policy/);
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
