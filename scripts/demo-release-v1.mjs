import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
        args: ["scripts/self-check.mjs", "--json"],
        summary_kind: "self_check",
      },
      {
        title: "Workflow Smoke Baseline",
        command: process.execPath,
        args: ["scripts/run-workflow-baseline.mjs", "smoke"],
        summary_kind: "node_test",
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
        summary_kind: "node_test",
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
        summary_kind: "node_test",
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
        summary_kind: "generic",
      },
    ],
  },
};

const NOISY_OUTPUT_PATTERNS = [
  /^\[info\]: \[ 'client ready' \]$/u,
];

export function formatCommand(command, args = []) {
  return [command, ...(Array.isArray(args) ? args : [])].join(" ");
}

function formatDuration(durationMs = 0) {
  const rounded = Math.max(0, Math.round(Number(durationMs) || 0));
  return `${rounded} ms`;
}

function normalizeOutputLines(text = "") {
  return String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !NOISY_OUTPUT_PATTERNS.some((pattern) => pattern.test(line)));
}

export function extractTrailingJson(text = "") {
  const source = String(text || "").trim();
  if (!source) {
    return null;
  }

  const openBraceIndexes = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "{") {
      openBraceIndexes.push(index);
    }
  }

  for (const start of openBraceIndexes) {
    const candidate = source.slice(start);
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue scanning until a parseable trailing JSON object is found.
    }
  }

  return null;
}

export function parseNodeTestSummary(text = "") {
  const source = String(text || "");
  const readMetric = (name) => {
    const match = source.match(new RegExp(`ℹ ${name} (\\d+)`, "u"));
    return match ? Number(match[1]) : null;
  };

  const summary = {
    tests: readMetric("tests"),
    pass: readMetric("pass"),
    fail: readMetric("fail"),
    skipped: readMetric("skipped"),
    todo: readMetric("todo"),
    duration_ms: readMetric("duration_ms"),
  };

  return Object.values(summary).some((value) => value !== null) ? summary : null;
}

function summarizeSelfCheck(stdout = "") {
  const parsed = extractTrailingJson(stdout);
  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const agents = parsed.agents && typeof parsed.agents === "object" ? parsed.agents : {};
  const routes = parsed.routes && typeof parsed.routes === "object" ? parsed.routes : {};
  const services = Array.isArray(parsed.services) ? parsed.services : [];
  const failingServices = services.filter((item) => item?.ok !== true);

  return [
    `system_ok: ${parsed.ok === true ? "yes" : "no"}`,
    `agents_checked: ${Number.isFinite(agents.total) ? agents.total : 0}, missing: ${Array.isArray(agents.missing) ? agents.missing.length : 0}, invalid_contracts: ${Array.isArray(agents.invalid_contracts) ? agents.invalid_contracts.length : 0}`,
    `routes_checked: ${Array.isArray(routes.checked) ? routes.checked.length : 0}, missing: ${Array.isArray(routes.missing) ? routes.missing.length : 0}`,
    `services_ok: ${services.length - failingServices.length}/${services.length}`,
  ];
}

function summarizeNodeTest(stdout = "") {
  const summary = parseNodeTestSummary(stdout);
  if (!summary) {
    return [];
  }

  const lines = [
    `tests: ${summary.tests ?? 0}, pass: ${summary.pass ?? 0}, fail: ${summary.fail ?? 0}`,
  ];

  if ((summary.skipped ?? 0) > 0 || (summary.todo ?? 0) > 0) {
    lines.push(`skipped: ${summary.skipped ?? 0}, todo: ${summary.todo ?? 0}`);
  }

  if (summary.duration_ms !== null) {
    lines.push(`test_duration: ${summary.duration_ms} ms`);
  }

  return lines;
}

function summarizeGeneric(execution = {}) {
  const outputLines = normalizeOutputLines(`${execution.stdout || ""}\n${execution.stderr || ""}`);
  if (outputLines.length === 0) {
    return [];
  }
  return [`last_output: ${outputLines[outputLines.length - 1]}`];
}

function summarizeExecution(step, execution) {
  if (step.summary_kind === "self_check") {
    return summarizeSelfCheck(execution.stdout);
  }
  if (step.summary_kind === "node_test") {
    return summarizeNodeTest(execution.stdout);
  }
  return summarizeGeneric(execution);
}

function buildErrorLines(step, execution) {
  const lines = [];
  if (execution.error instanceof Error) {
    lines.push(`spawn_error: ${execution.error.message}`);
  }
  if (execution.signal) {
    lines.push(`signal: ${execution.signal}`);
  }
  if (execution.status !== 0) {
    lines.push(`exit_code: ${execution.status ?? "unknown"}`);
  }

  const stderrLines = normalizeOutputLines(execution.stderr);
  const stdoutLines = normalizeOutputLines(execution.stdout);
  const preferredLines = stderrLines.length > 0 ? stderrLines : stdoutLines;
  if (preferredLines.length > 0) {
    const tail = preferredLines.slice(-10);
    lines.push(...tail.map((line, index) => `${index === 0 ? "details" : "details+"}: ${line}`));
  } else if (!summarizeExecution(step, execution).length) {
    lines.push("details: no additional output captured");
  }

  return lines;
}

export function buildStepReport(step, execution) {
  const ok = execution.status === 0 && !execution.error;
  return {
    ok,
    resultLabel: ok ? "PASS" : "FAIL",
    summaryLines: summarizeExecution(step, execution),
    errorLines: ok ? [] : buildErrorLines(step, execution),
  };
}

export function runStep(step, { cwd = process.cwd() } = {}) {
  const startedAt = Date.now();
  const result = spawnSync(step.command, step.args, {
    cwd,
    encoding: "utf8",
    shell: false,
  });
  return {
    status: typeof result.status === "number" ? result.status : 1,
    signal: result.signal || null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null,
    durationMs: Date.now() - startedAt,
  };
}

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
      "   - node scripts/self-check.mjs --json",
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

function printStepExecution(index, total, step, execution) {
  const report = buildStepReport(step, execution);
  console.log(`\n[${index + 1}/${total}] Step: ${step.title}`);
  console.log(`Command: ${formatCommand(step.command, step.args)}`);
  console.log(`Result: ${report.resultLabel} (${formatDuration(execution.durationMs)})`);

  if (report.summaryLines.length > 0) {
    console.log("Summary:");
    for (const line of report.summaryLines) {
      console.log(`- ${line}`);
    }
  }

  if (!report.ok) {
    console.log("Error:");
    for (const line of report.errorLines) {
      console.log(`- ${line}`);
    }
  }

  return report;
}

export function runScenario(name, { cwd = process.cwd() } = {}) {
  const demo = DEMOS[name];
  if (!demo) {
    printUsage();
    return { ok: false, exitCode: 1, reason: "unknown_scenario" };
  }

  if (name === "print") {
    printDemoScript();
    return { ok: true, exitCode: 0, reason: "printed" };
  }

  console.log(`Release Demo Scenario: ${name}`);
  console.log(`Description: ${demo.description}`);
  console.log(`Steps: ${demo.steps.length}`);

  for (let index = 0; index < demo.steps.length; index += 1) {
    const step = demo.steps[index];
    const execution = runStep(step, { cwd });
    const report = printStepExecution(index, demo.steps.length, step, execution);

    if (!report.ok) {
      console.log("\nScenario Result: FAIL");
      console.log(`Failed Step: ${index + 1}/${demo.steps.length} ${step.title}`);
      return {
        ok: false,
        exitCode: execution.status || 1,
        failedStepIndex: index,
      };
    }
  }

  console.log("\nScenario Result: PASS");
  console.log(`Completed Steps: ${demo.steps.length}/${demo.steps.length}`);
  return { ok: true, exitCode: 0 };
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const scenario = process.argv[2] || "print";
  const result = runScenario(scenario);
  process.exitCode = result.exitCode;
}
