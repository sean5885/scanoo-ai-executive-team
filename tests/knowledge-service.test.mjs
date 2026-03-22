import test from "node:test";
import assert from "node:assert/strict";

import { filterKnowledgeContextResults } from "../src/knowledge/knowledge-service.mjs";
import { plannerAnswer } from "../src/planner/knowledge-bridge.mjs";
import { summarizeWithMinimax } from "../src/planner/llm-summary.mjs";

test("filterKnowledgeContextResults drops label-like and metadata-like snippets", () => {
  const results = [
    { id: "a", snippet: "Routing" },
    { id: "b", snippet: "Execution / Runtime" },
    { id: "c", snippet: "API" },
    { id: "c2", snippet: "Planner verifies evidence quickly" },
    {
      id: "d",
      snippet: "The runtime verifier checks evidence completeness before a task can move into completed.",
    },
    {
      id: "e",
      snippet: "Planner lifecycle requires verification evidence and a bounded retry policy before completion.",
    },
  ];

  assert.deepEqual(filterKnowledgeContextResults(results), [
    { id: "c2", snippet: "Planner verifies evidence quickly" },
    {
      id: "d",
      snippet: "The runtime verifier checks evidence completeness before a task can move into completed.",
    },
    {
      id: "e",
      snippet: "Planner lifecycle requires verification evidence and a bounded retry policy before completion.",
    },
  ]);
});

test("filterKnowledgeContextResults keeps at most three non-label snippets", () => {
  const results = [
    { id: "a", snippet: "Routing / Execution" },
    { id: "b", snippet: "This knowledge preview contains enough context to remain useful for planner-side summaries." },
    { id: "c", snippet: "This second preview also contains a complete sentence with enough detail to survive filtering." },
    { id: "d", snippet: "This third preview stays because it is descriptive and not just a short metadata label." },
    { id: "e", snippet: "This fourth preview should be trimmed by the top-three cap after filtering is applied." },
  ];

  assert.deepEqual(filterKnowledgeContextResults(results), [
    { id: "b", snippet: "This knowledge preview contains enough context to remain useful for planner-side summaries." },
    { id: "c", snippet: "This second preview also contains a complete sentence with enough detail to survive filtering." },
    { id: "d", snippet: "This third preview stays because it is descriptive and not just a short metadata label." },
  ]);
});

test("plannerAnswer uses injected summarizer and passes filtered live previews", async () => {
  const result = await plannerAnswer(
    { keyword: "routing" },
    {
      summarize: async ({ keyword, results }) => {
        assert.equal(keyword, "routing");
        assert.ok(results.length > 0);
        assert.ok(results.every((item) => !/Routing \/ Execution/.test(item.snippet)));
        assert.ok(results.every((item) => !/runtime \/ monitoring\s*-\s*Purpose:/i.test(item.snippet)));
        return "這是整理後的摘要。";
      },
    },
  );

  assert.equal(result.answer, "這是整理後的摘要。");
  assert.ok(result.count > 0);
});

test("plannerAnswer falls back to deterministic summary when summarizer fails", async () => {
  const result = await plannerAnswer(
    { keyword: "routing" },
    {
      summarize: async () => {
        throw new Error("summary_failed");
      },
    },
  );

  assert.match(result.answer, /我查到 \d+ 份與「routing」相關的內容/);
  assert.doesNotMatch(result.answer, /Routing \/ Execution/);
  assert.doesNotMatch(result.answer, /runtime \/ monitoring\s*-\s*Purpose:/i);
});

test("plannerAnswer returns fail-soft prompt when keyword is missing", async () => {
  const result = await plannerAnswer({});

  assert.deepEqual(result, {
    answer: "請提供查詢關鍵字",
    count: 0,
  });
});

test("summarizeWithMinimax returns deterministic fallback when generator fails", async () => {
  const result = await summarizeWithMinimax({
    keyword: "驗證",
    results: [
      {
        id: "docs/system/planner_agent_alignment.md",
        snippet: "Planner lifecycle requires verification evidence and a bounded retry policy before completion.",
      },
    ],
    generateText: async () => {
      throw new Error("llm_unavailable");
    },
  });

  assert.match(result, /我查到 1 份與「驗證」相關的內容/);
  assert.match(result, /verification evidence and a bounded retry policy/i);
});

test("summarizeWithMinimax returns no-result message without calling generator", async () => {
  let called = false;
  const result = await summarizeWithMinimax({
    keyword: "不存在",
    results: [],
    generateText: async () => {
      called = true;
      return "should not run";
    },
  });

  assert.equal(result, "目前沒有找到與「不存在」直接相關的資料。");
  assert.equal(called, false);
});
