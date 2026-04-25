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

if (process.argv.includes("--help")) {
  printUsage();
  process.exit(0);
}

const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true);

try {
  let buildReleaseCheckCompareSummary;
  let getReleaseCheckExitCode;
  let runReleaseCheck;
  let resolvePreviousReleaseCheckSnapshot;
  let resolveReleaseCheckSnapshot;
  let result;

  try {
    ({
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

  let output = report;
  if (comparePrevious || compareSnapshot) {
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
  }

  console.log(JSON.stringify(output, null, 2));
  process.exit(getReleaseCheckExitCode(report));
} catch (error) {
  process.stdout.write = originalWrite;
  console.error(`release-check ci error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
