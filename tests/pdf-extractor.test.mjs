import test from "node:test";
import assert from "node:assert/strict";
import { extract } from "../src/pdf-extractor.mjs";

function buildSimplePdfBytes(text = "") {
  const payload = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "2 0 obj",
    "<< /Type /Page >>",
    "endobj",
    "10 0 obj",
    "<< /Length 32 >>",
    "stream",
    "BT",
    `/F1 12 Tf 72 720 Td (${text}) Tj`,
    "ET",
    "endstream",
    "endobj",
    "trailer",
    "<< /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  return Buffer.from(payload, "latin1");
}

test("pdf extractor reads text stream from textual pdf bytes", async () => {
  const result = await extract({
    bytes: buildSimplePdfBytes("Launch checklist owner list"),
    fileName: "launch.pdf",
    mimeType: "application/pdf",
  });
  assert.equal(result.ok, true);
  assert.match(result.text, /Launch checklist owner list/);
  assert.equal(result.extraction_mode, "text");
  assert.equal(Array.isArray(result.pages), true);
});

test("pdf extractor uses OCR fallback when text stream is empty", async () => {
  const result = await extract({
    bytes: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF", "latin1"),
    fileName: "scan.pdf",
    mimeType: "application/pdf",
    async ocrRunner() {
      return {
        text: "OCR recognized text",
        pages: [{ page: 1, text: "OCR recognized text" }],
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.extraction_mode, "ocr_fallback");
  assert.equal(result.text, "OCR recognized text");
});

test("pdf extractor fail-softs non-pdf bytes", async () => {
  const result = await extract({
    bytes: Buffer.from("not a pdf"),
    fileName: "note.txt",
    mimeType: "text/plain",
  });
  assert.equal(result.ok, false);
  assert.equal(result.text, "");
  assert.equal(result.extraction_mode, "none");
});
