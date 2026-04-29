import test from "node:test";
import assert from "node:assert/strict";
import { buildPdfChunks } from "../src/pdf-retriever.mjs";
import { buildPdfAnswer } from "../src/pdf-answer.mjs";

test("pdf retriever chunks by page and preserves page url mapping", () => {
  const chunks = buildPdfChunks({
    extracted: {
      text: "unused fallback",
      pages: [
        { page: 2, text: "Owner: Alice. Deadline: 2026-05-01." },
        { page: 3, text: "Risk: token scope mismatch." },
      ],
    },
    documentId: "doc_pdf_launch",
    title: "Launch Plan PDF",
    sourceUrl: "https://example.com/doc_pdf_launch",
    chunkOptions: {
      targetSize: 120,
      overlap: 12,
    },
  });

  assert.equal(chunks.length >= 2, true);
  assert.equal(chunks[0].metadata.pdf_page, 2);
  assert.equal(chunks[0].metadata.pdf_chunk_url, "https://example.com/doc_pdf_launch#page=2");
});

test("pdf answer renders source lines with page citation", () => {
  const answer = buildPdfAnswer({
    question: "owner and risk?",
    chunks: [
      {
        id: "doc_pdf_launch:p2:c0",
        snippet: "Owner is Alice",
        metadata: {
          title: "Launch Plan PDF",
          source_type: "pdf_chunk",
          pdf_page: 2,
          pdf_chunk_url: "https://example.com/doc_pdf_launch#page=2",
        },
      },
    ],
  });
  assert.match(answer.answer, /第2頁/);
  assert.equal(answer.sources.length, 1);
  assert.match(answer.sources[0], /第2頁/);
  assert.match(answer.sources[0], /#page=2/);
});
