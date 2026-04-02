const wantsJson = process.argv.includes("--json");

const {
  buildDependencySummary,
  getDependencyGuardrailsExitCode,
  renderDependencyGuardrailsReport,
} = await import("../src/dependency-guardrails.mjs");

const summary = await buildDependencySummary();

if (wantsJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(renderDependencyGuardrailsReport(summary));
}

process.exitCode = getDependencyGuardrailsExitCode(summary);
