import test from "node:test";
import assert from "node:assert/strict";

import { buildPdfAcceptanceCases, runPdfAcceptanceEval } from "../src/pdf-acceptance-eval.mjs";

test("pdf acceptance cases keep 50+ deterministic samples", () => {
  const cases = buildPdfAcceptanceCases();
  assert.ok(cases.length >= 50);
  assert.equal(cases.some((item) => item.mode === "ocr_fallback"), true);
  assert.equal(cases.some((item) => item.mode === "text"), true);
});

test("pdf acceptance evaluation passes 50+ ingest/retrieve/answer chain", async () => {
  const result = await runPdfAcceptanceEval();
  assert.equal(result.total_cases >= 50, true);
  assert.equal(result.sample_ready, true);
  assert.equal(result.pass, true);
  assert.equal(result.success_rate >= 0.9, true);
  assert.equal(result.ingest_success_rate >= 0.9, true);
  assert.equal(result.retrieve_success_rate >= 0.9, true);
  assert.equal(result.answer_success_rate >= 0.9, true);
  assert.equal(result.failed_case_ids.length, 0);
});
