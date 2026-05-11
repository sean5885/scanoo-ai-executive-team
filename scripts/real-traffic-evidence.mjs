#!/usr/bin/env node

import {
  buildRealTrafficEvidenceReport,
  writeRealTrafficEvidenceReport,
} from "../src/real-traffic-evidence.mjs";

function renderTextReport(report = {}, persisted = {}) {
  const lines = [
    `real traffic evidence: ${report?.overall_status || "unknown"}`,
    `summary: ${report?.summary || "n/a"}`,
    `blocking_reasons: ${(report?.blocking_reasons || []).join(",") || "none"}`,
  ];

  for (const window of Array.isArray(report?.windows) ? report.windows : []) {
    lines.push(
      [
        `window_${window.window_hours}h`,
        `status=${window.status}`,
        `sample_ready=${window.sample_ready === true ? "true" : "false"}`,
        `runs=${window.observed_runs}/${window.min_required_runs}`,
        `pass_rate=${window.pass_rate == null ? "null" : window.pass_rate}`,
      ].join(" | "),
    );
  }

  lines.push(`output: ${persisted?.output_path || "n/a"}`);
  return lines.join("\n");
}

async function main() {
  const wantsJson = process.argv.includes("--json");
  const report = await buildRealTrafficEvidenceReport();
  const persisted = await writeRealTrafficEvidenceReport(report);

  if (wantsJson) {
    console.log(JSON.stringify({ ...report, ...persisted }, null, 2));
  } else {
    console.log(renderTextReport(report, persisted));
  }

  if (report?.overall_status === "fail") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`real-traffic-evidence error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
