import test from "node:test";
import assert from "node:assert/strict";
import { classifyInputModality } from "../src/modality-router.mjs";

function buildSimplePdfBytes(text = "", { pageCount = 1 } = {}) {
  const pages = Array.from({ length: Math.max(1, pageCount) }, (_, index) => (
    `${index + 2} 0 obj\n<< /Type /Page >>\nendobj`
  )).join("\n");

  const payload = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    pages,
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

function buildSyntheticPdfCases(total = 50) {
  const cases = [];
  for (let index = 0; index < total; index += 1) {
    cases.push({
      id: `pdf-case-${String(index + 1).padStart(2, "0")}`,
      bytes: buildSimplePdfBytes(`PDF baseline content ${index + 1}`),
      expectSuccess: true,
    });
  }

  cases.push({
    id: "pdf-case-empty-bytes",
    bytes: Buffer.alloc(0),
    expectSuccess: false,
  });
  cases.push({
    id: "pdf-case-non-text-like",
    bytes: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF", "latin1"),
    expectSuccess: false,
  });

  return cases;
}

test("pdf baseline fixture keeps 50+ deterministic cases", () => {
  const cases = buildSyntheticPdfCases();
  assert.ok(cases.length >= 50);
});

test("pdf e2e baseline computes a stable extraction success rate when extractor is available", async () => {
  let extractPdf = null;
  try {
    const extractorModule = await import("../src/pdf-extractor.mjs");
    extractPdf = extractorModule?.extract;
  } catch {
    extractPdf = null;
  }

  if (typeof extractPdf !== "function") {
    return;
  }

  const cases = buildSyntheticPdfCases();

  let passed = 0;
  for (const item of cases) {
    const extracted = await extractPdf({
      bytes: item.bytes,
      fileName: `${item.id}.pdf`,
      mimeType: "application/pdf",
    });
    const ok = Boolean(extracted?.text);
    if (ok === item.expectSuccess) {
      passed += 1;
    }
  }

  const successRate = Number((passed / cases.length).toFixed(4));
  assert.equal(cases.length, 52);
  assert.equal(successRate, 1);
});

test("pdf e2e baseline computes stable modality classification", () => {
  const total = 52;
  let pass = 0;

  for (let index = 0; index < total; index += 1) {
    const result = classifyInputModality({
      message: {
        msg_type: "file",
        content: JSON.stringify({
          attachments: [
            {
              file_token: `pdf_file_${index + 1}`,
              name: `baseline-${index + 1}.pdf`,
              mime_type: "application/pdf",
              ext: "pdf",
            },
          ],
        }),
      },
      text: index % 10 === 0 ? "請整理這份 PDF" : "",
    });

    if (result.modality === "pdf" || result.modality === "pdf_multimodal") {
      pass += 1;
    }
  }

  const successRate = Number((pass / total).toFixed(4));
  assert.equal(successRate, 1);
});
