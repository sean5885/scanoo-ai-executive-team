import { runPdfAcceptanceEval } from "../src/pdf-acceptance-eval.mjs";

const wantsJson = process.argv.includes("--json");

function renderReport(summary = {}) {
  return [
    `pdf acceptance pass: ${summary?.pass === true ? "yes" : "no"}`,
    `cases: ${Number(summary?.pass_count || 0)}/${Number(summary?.total_cases || 0)}`,
    `success_rate: ${Number(summary?.success_rate || 0).toFixed(4)}`,
    `ingest_success_rate: ${Number(summary?.ingest_success_rate || 0).toFixed(4)}`,
    `retrieve_success_rate: ${Number(summary?.retrieve_success_rate || 0).toFixed(4)}`,
    `answer_success_rate: ${Number(summary?.answer_success_rate || 0).toFixed(4)}`,
    `sample_ready(>=50): ${summary?.sample_ready === true ? "yes" : "no"}`,
    `failed_cases: ${Array.isArray(summary?.failed_case_ids) && summary.failed_case_ids.length > 0 ? summary.failed_case_ids.join(",") : "none"}`,
  ].join("\n");
}

try {
  const result = await runPdfAcceptanceEval();
  if (wantsJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderReport(result));
  }
  if (result?.pass !== true) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`pdf-acceptance-eval error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
