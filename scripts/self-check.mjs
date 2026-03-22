const wantsJson = process.argv.includes("--json");

function printUsage() {
  console.log([
    "Usage:",
    "  npm run self-check",
    "  npm run self-check -- --json",
  ].join("\n"));
}

if (process.argv.includes("--help")) {
  printUsage();
  process.exit(0);
}

const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true);

const {
  renderSystemSelfCheckReport,
  runSystemSelfCheck,
} = await import("../src/system-self-check.mjs");

let result;
try {
  result = await runSystemSelfCheck();
} finally {
  process.stdout.write = originalWrite;
}

if (wantsJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(renderSystemSelfCheckReport(result));
}

if (!result.ok) {
  process.exitCode = 1;
}
