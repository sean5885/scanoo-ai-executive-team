import { spawnSync } from "node:child_process";

const DEMOS = {
  print: {
    description: "Print the v1.0.0 demo flow without executing commands.",
    steps: [],
  },
  quick: {
    description: "Run the recommended release demo flow.",
    steps: [
      {
        title: "Self-check",
        command: process.execPath,
        args: ["scripts/self-check.mjs"],
      },
      {
        title: "Workflow Smoke Baseline",
        command: process.execPath,
        args: ["scripts/run-workflow-baseline.mjs", "smoke"],
      },
      {
        title: "Company Brain + Logging + OAuth Demo Tests",
        command: process.execPath,
        args: [
          "--test",
          "tests/company-brain-learning.test.mjs",
          "tests/http-server.trace.test.mjs",
          "tests/lark-oauth-refresh.test.mjs",
        ],
      },
    ],
  },
  full: {
    description: "Run the full release verification suite.",
    steps: [
      {
        title: "Full Test Suite",
        command: "npm",
        args: ["test"],
      },
    ],
  },
  "oauth-live": {
    description: "Run the optional live tenant auth smoke check.",
    steps: [
      {
        title: "Tenant Auth Check",
        command: process.execPath,
        args: ["scripts/check-auth.mjs"],
      },
    ],
  },
};

function printUsage() {
  console.log(
    [
      "Usage: node scripts/demo-release-v1.mjs <scenario>",
      "",
      "Available scenarios:",
      ...Object.entries(DEMOS).map(([name, value]) => `- ${name}: ${value.description}`),
    ].join("\n"),
  );
}

function printDemoScript() {
  console.log(
    [
      "Release Demo Script: v1.0.0",
      "",
      "1. Preflight",
      "   - Confirm repo baseline is tagged at v1.0.0.",
      "   - Confirm required env vars for Lark are loaded if live auth demo is needed.",
      "",
      "2. Stability Gate",
      "   - node scripts/self-check.mjs",
      "   - node scripts/run-workflow-baseline.mjs smoke",
      "",
      "3. Core Capability Demo",
      "   - node --test tests/company-brain-learning.test.mjs",
      "   - node --test tests/http-server.trace.test.mjs",
      "   - node --test tests/lark-oauth-refresh.test.mjs",
      "",
      "4. Optional Live Tenant Check",
      "   - node scripts/check-auth.mjs",
      "",
      "5. Freeze Reminder",
      "   - Do not change planner/company-brain/OAuth/learning/logging core logic on v1.0.0.",
    ].join("\n"),
  );
}

function runScenario(name) {
  const demo = DEMOS[name];
  if (!demo) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (name === "print") {
    printDemoScript();
    return;
  }

  console.log(`Running release demo scenario: ${name}`);
  for (const step of demo.steps) {
    console.log(`\n== ${step.title} ==`);
    console.log([step.command, ...step.args].join(" "));
    const result = spawnSync(step.command, step.args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: false,
    });
    if (result.status !== 0) {
      process.exitCode = result.status || 1;
      return;
    }
  }
}

const scenario = process.argv[2] || "print";
runScenario(scenario);
