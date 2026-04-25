const wantsJson = process.argv.includes("--json");
const writeSummaryFixturePath = process.env.SYSTEM_SELF_CHECK_WRITE_SUMMARY_FIXTURE || "";
const usageSummaryFixturePath = process.env.SYSTEM_SELF_CHECK_USAGE_SUMMARY_FIXTURE || "";

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function renderCompareValue(value = "unchanged") {
  if (value === "better") {
    return "變好";
  }
  if (value === "worse") {
    return "變差";
  }
  return "無變化";
}

function renderRegressionValue(value = false) {
  return value ? "有" : "無";
}

function printUsage() {
  console.log([
    "Usage:",
    "  npm run self-check",
    "  npm run self-check -- --compare-previous",
    "  npm run self-check -- --compare-snapshot <run-id|path>",
    "  npm run self-check -- --json",
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

if (process.argv.includes("--help")) {
  printUsage();
  process.exit(0);
}

const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true);

const {
  buildSystemSelfCheckCompareSummary,
  renderSystemSelfCheckReport,
  runSystemSelfCheck,
} = await import("../src/system-self-check.mjs");
const {
  resolvePreviousSystemSelfCheckSnapshot,
  resolveSystemSelfCheckSnapshot,
} = await import("../src/system-self-check-history.mjs");

async function resolveCompareTarget(currentRunId = "") {
  const compareSnapshot = getArgValue("--compare-snapshot");
  const comparePrevious = process.argv.includes("--compare-previous");
  const selectors = [
    Boolean(compareSnapshot),
    comparePrevious,
  ].filter(Boolean);

  if (selectors.length > 1) {
    throw new Error("Choose only one compare selector: --compare-previous or --compare-snapshot");
  }

  if (comparePrevious) {
    return resolvePreviousSystemSelfCheckSnapshot({
      reference: currentRunId || "latest",
    });
  }

  if (compareSnapshot) {
    return resolveSystemSelfCheckSnapshot({
      reference: compareSnapshot,
    });
  }

  return null;
}

try {
  let result;
  try {
    result = await runSystemSelfCheck(await resolveRuntimeOverrides());
  } finally {
    process.stdout.write = originalWrite;
  }

  let compareSummary = null;
  const compareTarget = await resolveCompareTarget(result?.self_check_archive?.run_id || "");
  if (compareTarget) {
    compareSummary = buildSystemSelfCheckCompareSummary({
      currentReport: result,
      previousReport: compareTarget?.report || {},
    });
    result.compare_summary = compareSummary;
  }

  if (wantsJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (compareSummary) {
    console.log([
      `system: ${renderCompareValue(compareSummary.system_status)}`,
      `control regression: ${renderRegressionValue(compareSummary.control_regression)}`,
      `routing regression: ${renderRegressionValue(compareSummary.routing_regression)}`,
      `planner regression: ${renderRegressionValue(compareSummary.planner_regression)}`,
    ].join("\n"));
  } else {
    console.log(renderSystemSelfCheckReport(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stdout.write = originalWrite;
  console.error(`self-check error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
