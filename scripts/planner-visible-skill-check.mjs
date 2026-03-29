import {
  renderPlannerVisibleSkillObservabilityReport,
  runPlannerVisibleSkillObservabilityCheck,
} from "../src/planner-visible-skill-observability.mjs";

const wantsJson = process.argv.includes("--json");
const report = await runPlannerVisibleSkillObservabilityCheck();

if (wantsJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderPlannerVisibleSkillObservabilityReport(report));
}

if (report?.ok !== true) {
  process.exitCode = 1;
}
