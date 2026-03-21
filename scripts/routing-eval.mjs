const asJson = process.argv.includes("--json");
let restoreStdout = null;

const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true);
restoreStdout = () => {
  process.stdout.write = originalWrite;
};

const {
  formatRoutingEvalReport,
  runRoutingEval,
} = await import("../src/routing-eval.mjs");

restoreStdout?.();

const run = await runRoutingEval();

if (asJson) {
  console.log(JSON.stringify(run, null, 2));
} else {
  console.log(formatRoutingEvalReport(run));
  if (run.validation_issues?.length) {
    console.log("");
    console.log("Validation issues");
    for (const issue of run.validation_issues) {
      console.log(`- ${issue}`);
    }
  }
}

process.exitCode = run.ok ? 0 : 1;
