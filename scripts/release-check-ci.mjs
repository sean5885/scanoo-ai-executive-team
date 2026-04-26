import { spawnSync } from "node:child_process";

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

const writeSummaryFixturePath = process.env.SYSTEM_SELF_CHECK_WRITE_SUMMARY_FIXTURE || "";
const usageSummaryFixturePath = process.env.SYSTEM_SELF_CHECK_USAGE_SUMMARY_FIXTURE || "";

function printUsage() {
  console.log([
    "Usage:",
    "  npm run release-check:ci",
    "  npm run release-check:ci -- --compare-previous",
    "  npm run release-check:ci -- --compare-snapshot <run-id|path>",
  ].join("\n"));
}

async function resolveRuntimeOverrides() {
  if (!writeSummaryFixturePath && !usageSummaryFixturePath) {
    return {};
  }

  const { readFile } = await import("node:fs/promises");
  const overrides = {};

  if (writeSummaryFixturePath) {
    const raw = await readFile(writeSummaryFixturePath, "utf8");
    const summary = JSON.parse(raw);
    overrides.writeCheck = async () => summary;
  }

  if (usageSummaryFixturePath) {
    const raw = await readFile(usageSummaryFixturePath, "utf8");
    const summary = JSON.parse(raw);
    overrides.usageLayerCheck = async () => summary;
  }

  return overrides;
}

function parseCommandSpecFromEnv(envName = "", fallbackSpec = { command: "node", args: ["--test"] }) {
  const raw = process.env[envName];
  if (!raw) {
    return fallbackSpec;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${envName} must be a JSON array command, e.g. [\"node\",\"--test\"]`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${envName} must be a non-empty JSON array command`);
  }

  const [commandRaw, ...argsRaw] = parsed;
  const command = String(commandRaw || "").trim();
  if (!command) {
    throw new Error(`${envName} command must be a non-empty string`);
  }

  return {
    command,
    args: argsRaw.map((item) => String(item)),
  };
}

function renderCommandSpec(spec = {}) {
  const command = String(spec?.command || "").trim();
  const args = Array.isArray(spec?.args) ? spec.args : [];
  return [command, ...args].join(" ").trim();
}

function runCommandSpec(spec = {}) {
  const command = String(spec?.command || "").trim();
  const args = Array.isArray(spec?.args) ? spec.args : [];
  if (!command) {
    return {
      ok: false,
      exitCode: 1,
      signal: null,
      stderr: "empty command",
    };
  }

  const commandResult = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });

  if (commandResult.error) {
    return {
      ok: false,
      exitCode: 1,
      signal: null,
      stderr: commandResult.error.message || "spawn error",
    };
  }

  return {
    ok: commandResult.status === 0,
    exitCode: Number.isInteger(commandResult.status) ? commandResult.status : 1,
    signal: commandResult.signal || null,
    stderr: String(commandResult.stderr || ""),
  };
}

function runFullTestGate() {
  const commandPlans = [
    {
      label: "node --test",
      spec: parseCommandSpecFromEnv(
        "RELEASE_CHECK_CI_NODE_TEST_COMMAND_JSON",
        { command: "node", args: ["--test"] },
      ),
    },
    {
      label: "npm run test:ci",
      spec: parseCommandSpecFromEnv(
        "RELEASE_CHECK_CI_TEST_CI_COMMAND_JSON",
        { command: "npm", args: ["run", "test:ci"] },
      ),
    },
  ];

  for (const commandPlan of commandPlans) {
    const execution = runCommandSpec(commandPlan.spec);
    if (!execution.ok) {
      return {
        ok: false,
        failedCommandLabel: commandPlan.label,
        failedCommand: renderCommandSpec(commandPlan.spec),
        failedExitCode: execution.exitCode,
        failedSignal: execution.signal,
        stderr: execution.stderr,
      };
    }
  }

  return {
    ok: true,
    failedCommandLabel: null,
    failedCommand: null,
    failedExitCode: null,
    failedSignal: null,
    stderr: "",
  };
}

if (process.argv.includes("--help")) {
  printUsage();
  process.exit(0);
}

const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true);

try {
  let buildReleaseCheckCompareSummary;
  let applyFullTestGateFailureReport;
  let getReleaseCheckExitCode;
  let runReleaseCheck;
  let resolvePreviousReleaseCheckSnapshot;
  let resolveReleaseCheckSnapshot;
  let result;

  try {
    ({
      applyFullTestGateFailureReport,
      buildReleaseCheckCompareSummary,
      getReleaseCheckExitCode,
      runReleaseCheck,
    } = await import("../src/release-check.mjs"));
    ({
      resolvePreviousReleaseCheckSnapshot,
      resolveReleaseCheckSnapshot,
    } = await import("../src/release-check-history.mjs"));
    result = await runReleaseCheck(await resolveRuntimeOverrides());
  } finally {
    process.stdout.write = originalWrite;
  }

  const report = result?.report || {
    overall_status: "fail",
    blocking_checks: ["system_regression"],
    doc_boundary_regression: false,
    suggested_next_step: "release-check 執行失敗，先看 system regression 的基礎模組：src/agent-registry.mjs、src/http-route-contracts.mjs、src/*-service.mjs。",
    action_hint: "inspect blocking_checks and representative_fail_case",
    failing_area: "mixed",
    representative_fail_case: ["release-check execution failed"],
    drilldown_source: ["release-check triage"],
  };
  const compareSnapshot = getArgValue("--compare-snapshot");
  const comparePrevious = process.argv.includes("--compare-previous");
  const selectors = [
    Boolean(compareSnapshot),
    comparePrevious,
  ].filter(Boolean);

  if (selectors.length > 1) {
    throw new Error("Choose only one compare selector: --compare-previous or --compare-snapshot");
  }

  const compareMode = comparePrevious || compareSnapshot;
  const shouldRunFullTestGate = !compareMode && process.env.RELEASE_CHECK_CI_SKIP_FULL_TEST_GATE !== "1";

  let output = report;
  let exitReport = report;
  if (compareMode) {
    const compareTarget = comparePrevious
      ? await resolvePreviousReleaseCheckSnapshot({
          reference: result?.release_check_archive?.run_id || "latest",
        })
      : await resolveReleaseCheckSnapshot({
          reference: compareSnapshot,
        });
    output = buildReleaseCheckCompareSummary({
      currentReport: report,
      previousReport: compareTarget?.report || {},
    });
  } else if (shouldRunFullTestGate && getReleaseCheckExitCode(report) === 0) {
    const fullTestGateResult = runFullTestGate();
    if (!fullTestGateResult.ok) {
      exitReport = applyFullTestGateFailureReport(report, {
        failedCommand: fullTestGateResult.failedCommandLabel || fullTestGateResult.failedCommand,
        failedExitCode: fullTestGateResult.failedExitCode,
      });
      output = exitReport;

      const stderrTail = String(fullTestGateResult.stderr || "")
        .trim()
        .split("\n")
        .slice(-8)
        .join("\n");
      if (stderrTail) {
        console.error(`release-check ci full test gate failed: ${fullTestGateResult.failedCommand || "unknown command"}\n${stderrTail}`);
      } else {
        console.error(`release-check ci full test gate failed: ${fullTestGateResult.failedCommand || "unknown command"} (exit ${fullTestGateResult.failedExitCode ?? "unknown"})`);
      }
    }
  }

  console.log(JSON.stringify(output, null, 2));
  process.exit(getReleaseCheckExitCode(exitReport));
} catch (error) {
  process.stdout.write = originalWrite;
  console.error(`release-check ci error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
