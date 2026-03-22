import {
  renderPlannerContractConsistencyReport,
  runPlannerContractConsistencyCheck,
} from "../src/planner-contract-consistency.mjs";
import { archivePlannerDiagnosticsSnapshot } from "../src/planner-diagnostics-history.mjs";

const wantsJson = process.argv.includes("--json");
const report = runPlannerContractConsistencyCheck();

await archivePlannerDiagnosticsSnapshot({
  commandName: "planner:diagnostics",
  report,
});

if (wantsJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderPlannerContractConsistencyReport(report));
}

if (report?.gate?.ok === false) {
  process.exitCode = 1;
}
