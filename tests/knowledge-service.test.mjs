import test from "node:test";
import assert from "node:assert/strict";

import { cleanSnippet as cleanKnowledgeSnippet } from "../src/knowledge/snippet-cleaner.mjs";
import { filterKnowledgeContextResults } from "../src/knowledge/knowledge-service.mjs";
import { plannerAnswer } from "../src/planner/knowledge-bridge.mjs";
import { parseIntent } from "../src/planner/intent-parser.mjs";
import { buildSummaryPrompt, summarizeWithMinimax } from "../src/planner/llm-summary.mjs";
import { pickTechTerm } from "../src/utils/pick-tech-term.mjs";

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

test("cleanSnippet strips navigation artifacts at the start of previews", () => {
  assert.equal(
    cleanKnowledgeSnippet("Back to README.md\nLoop Runbook: planner verification keeps evidence requirements explicit.", "verification"),
    "planner verification keeps evidence requirements explicit.",
  );
  assert.equal(
    cleanKnowledgeSnippet("Delivery Guide - owner and deadline are required for action items.", "deadline"),
    "owner and deadline are required for action items.",
  );
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
  assert.equal(result.sources.length, result.count);
  assert.deepEqual(result.sources[0], {
    id: result.sources[0].id,
    index: 1,
    snippet: result.sources[0].snippet,
  });
});

test("parseIntent returns the first normalized keyword from generator output when no allowlisted term matches", async () => {
  const result = await parseIntent("文件審核流程在哪裡？", {
    generateText: async (request) => {
      assert.match(request.prompt, /文件審核流程在哪裡/);
      assert.equal(request.temperature, 0);
      return "「審核流程」, 文件";
    },
  });

  assert.equal(result, "審核流程");
});

test("parseIntent prefers known technical terms before calling generator", async () => {
  let called = false;

  const result = await parseIntent("Scanoo 的 routing 是怎麼運作的？", {
    generateText: async () => {
      called = true;
      return "scanoo";
    },
  });

  assert.equal(result, "routing");
  assert.equal(called, false);
});

test("pickTechTerm prefers the longest matching registry term", () => {
  assert.equal(
    pickTechTerm("請問 Scanoo Entry OS 的 onboarding workflow 在哪裡？"),
    "scanoo entry os",
  );
  assert.equal(
    pickTechTerm("entry os 的 routing 在哪裡？"),
    "entry os",
  );
});

test("plannerAnswer parses question when keyword is missing", async () => {
  const result = await plannerAnswer(
    { question: "planner 的 verification 在哪裡？" },
    {
      parse: async (question) => {
        assert.match(question, /verification/);
        return "verification";
      },
      summarize: async ({ keyword, results }) => {
        assert.equal(keyword, "verification");
        assert.ok(results.length > 0);
        return "這是從問題解析後整理的摘要。";
      },
    },
  );

  assert.equal(result.answer, "這是從問題解析後整理的摘要。");
  assert.ok(result.count > 0);
  assert.equal(result.sources.length, result.count);
});

test("plannerAnswer prefers technical term parsing over brand-like question terms", async () => {
  const result = await plannerAnswer(
    { question: "Scanoo 的 routing 是怎麼運作的？" },
    {
      summarize: async ({ keyword }) => {
        assert.equal(keyword, "routing");
        return "routing 摘要";
      },
    },
  );

  assert.equal(result.answer, "routing 摘要");
  assert.ok(result.count > 0);
  assert.equal(result.sources.length, result.count);
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
  assert.equal(result.sources.length, result.count);
});

test("plannerAnswer returns fail-soft prompt when keyword is missing", async () => {
  const result = await plannerAnswer({});

  assert.deepEqual(result, {
    answer: "請提供查詢關鍵字",
    count: 0,
    sources: [],
  });
});

test("plannerAnswer keeps fail-soft prompt when question parsing returns nothing", async () => {
  const result = await plannerAnswer(
    { question: "這是什麼？" },
    {
      parse: async () => null,
    },
  );

  assert.deepEqual(result, {
    answer: "請提供查詢關鍵字",
    count: 0,
    sources: [],
  });
});

test("plannerAnswer returns deduped numbered sources", async () => {
  const result = await plannerAnswer(
    { keyword: "planner" },
    {
      rewrite: () => ["planner", "routing"],
      summarize: async () => "整理後摘要 [1][2]",
    },
  );

  assert.equal(result.answer, "整理後摘要 [1][2]");
  assert.equal(result.sources.length, result.count);
  assert.ok(result.sources.length > 0);
  assert.equal(result.sources[0].index, 1);
  assert.equal(result.sources[result.sources.length - 1].index, result.sources.length);
  assert.equal(
    new Set(result.sources.map((item) => item.id)).size,
    result.sources.length,
  );
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

test("summarizeWithMinimax requests citation-style summary with zero temperature", async () => {
  let capturedRequest = null;

  const result = await summarizeWithMinimax({
    keyword: "routing",
    results: [
      {
        id: "docs/system/planner_agent_alignment.md",
        snippet: "Routing decisions are validated before the planner can complete a task.",
      },
      {
        id: "docs/system/knowledge_pipeline.md",
        snippet: "Planner-side helpers reuse shared text generation and fail-soft fallback behavior.",
      },
    ],
    generateText: async (request) => {
      capturedRequest = request;
      return "Planner 會先驗證 routing 決策，再進入後續處理 [1][2]";
    },
  });

  assert.equal(result, "Planner 會先驗證 routing 決策，再進入後續處理 [1][2]");
  assert.equal(capturedRequest.temperature, 0);
  assert.match(capturedRequest.systemPrompt, /句尾都要標註來源編號/);
  assert.match(capturedRequest.prompt, /句尾標註來源編號/);
  assert.match(capturedRequest.prompt, /\[1\] Routing decisions are validated before the planner can complete a task\./);
  assert.match(capturedRequest.prompt, /\[2\] Planner-side helpers reuse shared text generation and fail-soft fallback behavior\./);
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

test("buildSummaryPrompt asks for concise cited answer", () => {
  const prompt = buildSummaryPrompt({
    keyword: "planner",
    results: [
      {
        id: "docs/system/planner_agent_alignment.md",
        snippet: "Planner lifecycle requires verification evidence before completion.",
      },
    ],
  });

  assert.match(prompt, /查詢主題：planner/);
  assert.match(prompt, /簡潔回答/);
  assert.match(prompt, /每個重點句後加 \[編號\]/);
  assert.match(prompt, /\[1\] Planner lifecycle requires verification evidence before completion\./);
});
