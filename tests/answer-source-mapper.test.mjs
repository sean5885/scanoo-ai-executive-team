import test from "node:test";
import assert from "node:assert/strict";

const {
  buildCanonicalAnswerSources,
  normalizeUserFacingAnswerSources,
} = await import("../src/answer-source-mapper.mjs");

test("planner document items must pass through canonical answer sources before rendering", () => {
  const canonicalSources = buildCanonicalAnswerSources([
    {
      title: "Delivery SOP",
      doc_id: "doc_delivery_sop",
      url: "https://larksuite.com/docx/doc_delivery_sop",
      reason: "Back to [README.md](/Users/seanhan/Documents/Playground/README.md)\n\n- delivery owner checklist stays explicit before completion.",
    },
  ], {
    query: "delivery owner",
  });

  assert.equal(canonicalSources.length, 1);
  assert.deepEqual(Object.keys(canonicalSources[0]).sort(), ["id", "metadata", "snippet"]);
  assert.equal(canonicalSources[0].id, "doc_delivery_sop");
  assert.equal(canonicalSources[0].metadata.title, "Delivery SOP");
  assert.equal(canonicalSources[0].metadata.source_type, "company_brain_doc");
  assert.doesNotMatch(canonicalSources[0].snippet, /\/Users\/|Back to \[?README|`/);
});

test("user-facing answer sources fail closed when no canonical snippet can be built", () => {
  const renderedSources = normalizeUserFacingAnswerSources([
    {
      title: "Title Only",
      url: "https://example.com/title-only",
      source_type: "docx",
    },
  ]);

  assert.deepEqual(renderedSources, []);
});

test("user-facing answer sources render canonical items without leaking snippet noise", () => {
  const renderedSources = normalizeUserFacingAnswerSources([
    {
      id: "runtime_source_1",
      snippet: "Back to [README.md](/Users/seanhan/Documents/Playground/README.md)\n\n- runtime boundary keeps evidence explicit and deterministic.",
      metadata: {
        title: "Runtime Boundary",
        url: "https://example.com/runtime-boundary",
        source_type: "docx",
        document_id: "runtime_doc_1",
      },
    },
  ], {
    query: "runtime boundary",
  });

  assert.equal(renderedSources.length, 1);
  assert.match(renderedSources[0], /Runtime Boundary：runtime boundary keeps evidence explicit and deterministic\./i);
  assert.match(renderedSources[0], /https:\/\/example\.com\/runtime-boundary/);
  assert.doesNotMatch(renderedSources[0], /\/Users\/|Back to \[?README|`/);
});
