import test from "node:test";
import assert from "node:assert/strict";

import { filterKnowledgeContextResults } from "../src/knowledge/knowledge-service.mjs";
import { plannerAnswer } from "../src/planner/knowledge-bridge.mjs";

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

test("plannerAnswer strips routing label and metadata prefixes from live docs previews", () => {
  const result = plannerAnswer({ keyword: "routing" });

  assert.match(result.answer, /我查到 \d+ 份與「routing」相關的內容/);
  assert.doesNotMatch(result.answer, /Routing \/ Execution/);
  assert.doesNotMatch(result.answer, /runtime \/ monitoring\s*-\s*Purpose:/i);
});
