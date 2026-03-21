import { spawn } from "node:child_process";

const BASELINES = {
  smoke: [
    "tests/executive-task-state.test.mjs",
    "tests/control-unification-phase2-meeting.test.mjs",
    "tests/control-unification-phase2-doc-rewrite.test.mjs",
    "tests/control-unification-phase2-cloud-doc.test.mjs",
    "tests/openclaw-plugin-regression.test.mjs",
  ],
  integration: [
    "tests/http-server.route-success.test.mjs",
    "tests/cloud-doc-organization-regression.test.mjs",
    "tests/lane-executor.test.mjs",
    "tests/chain-integration.test.mjs",
    "tests/lobster-security-bridge.integration.test.mjs",
  ],
  meeting: [
    "tests/control-unification-phase2-meeting.test.mjs",
    "tests/meeting-agent.test.mjs",
    "tests/chain-integration.test.mjs",
  ],
  "doc-rewrite": [
    "tests/control-unification-phase2-doc-rewrite.test.mjs",
    "tests/http-server.route-success.test.mjs",
  ],
  "cloud-doc": [
    "tests/control-unification-phase2-cloud-doc.test.mjs",
    "tests/cloud-doc-organization-regression.test.mjs",
    "tests/http-server.route-success.test.mjs",
    "tests/lane-executor.test.mjs",
  ],
};

BASELINES.all = Array.from(
  new Set([
    ...BASELINES.smoke,
    ...BASELINES.integration,
    ...BASELINES.meeting,
    ...BASELINES["doc-rewrite"],
    ...BASELINES["cloud-doc"],
  ]),
);

function printUsage() {
  console.error(
    [
      "Usage: node scripts/run-workflow-baseline.mjs <baseline>",
      "",
      "Available baselines:",
      ...Object.keys(BASELINES).map((name) => `- ${name}`),
    ].join("\n"),
  );
}

async function run() {
  const baselineName = process.argv[2] || "smoke";
  const files = BASELINES[baselineName];
  if (!files) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  console.log(`Running workflow baseline: ${baselineName}`);
  console.log(files.join("\n"));

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", ...files], {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`workflow baseline failed: ${baselineName} (exit ${code ?? 1})`));
    });
    child.on("error", reject);
  });
}

run().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
