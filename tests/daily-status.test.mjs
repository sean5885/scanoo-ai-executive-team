import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const [
  {
    buildDailyStatusCompareSummary,
    buildDailyStatusHumanSummary,
    buildDailyStatusReport,
    buildDailyStatusTrendSummary,
    renderDailyStatusTrendReport,
    renderDailyStatusCompareReport,
    renderDailyStatusReport,
  },
  { runPlannerContractConsistencyCheck },
  { archivePlannerDiagnosticsSnapshot },
  { buildRoutingDiagnosticsSummary },
  { archiveRoutingDiagnosticsSnapshot },
  { archiveReleaseCheckSnapshot },
  { runRoutingEval },
  { archiveSystemSelfCheckSnapshot },
] = await Promise.all([
  import("../src/daily-status.mjs"),
  import("../src/planner-contract-consistency.mjs"),
  import("../src/planner-diagnostics-history.mjs"),
  import("../src/routing-eval-diagnostics.mjs"),
  import("../src/routing-diagnostics-history.mjs"),
  import("../src/release-check-history.mjs"),
  import("../src/routing-eval.mjs"),
  import("../src/system-self-check-history.mjs"),
]);

test.after(() => {
  testDb.close();
});

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function seedDailyStatusArchives() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "daily-status-"));
  const routingArchiveDir = path.join(baseDir, "routing");
  const plannerArchiveDir = path.join(baseDir, "planner");
  const selfCheckArchiveDir = path.join(baseDir, "self-check");
  const releaseCheckArchiveDir = path.join(baseDir, "release-check");

  const routingRun = await runRoutingEval();
  const firstRoutingDiagnostics = buildRoutingDiagnosticsSummary({
    run: routingRun,
    previousRun: null,
    currentLabel: "snapshot:routing-1",
  });
  await archiveRoutingDiagnosticsSnapshot({
    baseDir: routingArchiveDir,
    runId: "routing-1",
    timestamp: "2026-03-22T00:00:00.000Z",
    scope: "routing-eval",
    stage: "standalone",
    run: routingRun,
    diagnosticsSummary: firstRoutingDiagnostics,
  });

  const secondRoutingDiagnostics = buildRoutingDiagnosticsSummary({
    run: routingRun,
    previousRun: routingRun,
    currentLabel: "snapshot:routing-2",
    previousLabel: "snapshot:routing-1",
  });
  await archiveRoutingDiagnosticsSnapshot({
    baseDir: routingArchiveDir,
    runId: "routing-2",
    timestamp: "2026-03-22T00:00:01.000Z",
    scope: "routing-eval",
    stage: "standalone",
    run: routingRun,
    diagnosticsSummary: secondRoutingDiagnostics,
  });

  const plannerReport = runPlannerContractConsistencyCheck();
  await archivePlannerDiagnosticsSnapshot({
    baseDir: plannerArchiveDir,
    commandName: "planner-diagnostics",
    report: plannerReport,
    timestamp: "2026-03-22T00:00:02.000Z",
  });

  return {
    plannerArchiveDir,
    releaseCheckArchiveDir,
    routingArchiveDir,
    selfCheckArchiveDir,
  };
}

function buildTrendSelfCheckReport({
  routingStatus = "pass",
  plannerStatus = "pass",
  safeToChange = true,
} = {}) {
  return {
    ok: safeToChange,
    system_summary: {
      status: safeToChange ? "pass" : "fail",
      safe_to_change: safeToChange,
      core_checks: "pass",
      routing_status: routingStatus,
      planner_gate: plannerStatus,
      has_obvious_regression: routingStatus === "degrade",
    },
    routing_summary: {
      status: routingStatus,
    },
    planner_summary: {
      gate: plannerStatus,
    },
  };
}

function buildTrendReleaseReport({
  releaseStatus = "pass",
  blockingChecks = [],
} = {}) {
  return {
    overall_status: releaseStatus,
    blocking_checks: blockingChecks,
    suggested_next_step: blockingChecks.length > 0 ? `check ${blockingChecks[0]}` : null,
  };
}

async function seedDailyStatusTrendArchives() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "daily-status-trend-"));
  const selfCheckArchiveDir = path.join(baseDir, "self-check");
  const releaseCheckArchiveDir = path.join(baseDir, "release-check");
  const entries = [
    {
      selfCheckTimestamp: "2026-03-18T00:00:00.000Z",
      releaseTimestamp: "2026-03-18T00:00:01.000Z",
      routingStatus: "pass",
      plannerStatus: "pass",
      releaseStatus: "pass",
      safeToChange: true,
      blockingChecks: [],
    },
    {
      selfCheckTimestamp: "2026-03-19T00:00:00.000Z",
      releaseTimestamp: "2026-03-19T00:00:01.000Z",
      routingStatus: "degrade",
      plannerStatus: "pass",
      releaseStatus: "fail",
      safeToChange: false,
      blockingChecks: ["routing_regression"],
    },
    {
      selfCheckTimestamp: "2026-03-20T00:00:00.000Z",
      releaseTimestamp: "2026-03-20T00:00:01.000Z",
      routingStatus: "pass",
      plannerStatus: "pass",
      releaseStatus: "pass",
      safeToChange: true,
      blockingChecks: [],
    },
    {
      selfCheckTimestamp: "2026-03-21T00:00:00.000Z",
      releaseTimestamp: "2026-03-21T00:00:01.000Z",
      routingStatus: "degrade",
      plannerStatus: "pass",
      releaseStatus: "fail",
      safeToChange: false,
      blockingChecks: ["routing_regression"],
    },
    {
      selfCheckTimestamp: "2026-03-22T00:00:00.000Z",
      releaseTimestamp: "2026-03-22T00:00:01.000Z",
      routingStatus: "pass",
      plannerStatus: "fail",
      releaseStatus: "fail",
      safeToChange: false,
      blockingChecks: ["planner_contract_failure"],
    },
  ];

  for (const entry of entries) {
    await archiveSystemSelfCheckSnapshot({
      baseDir: selfCheckArchiveDir,
      timestamp: entry.selfCheckTimestamp,
      report: buildTrendSelfCheckReport({
        routingStatus: entry.routingStatus,
        plannerStatus: entry.plannerStatus,
        safeToChange: entry.safeToChange,
      }),
    });
    await archiveReleaseCheckSnapshot({
      baseDir: releaseCheckArchiveDir,
      timestamp: entry.releaseTimestamp,
      report: buildTrendReleaseReport({
        releaseStatus: entry.releaseStatus,
        blockingChecks: entry.blockingChecks,
      }),
    });
  }

  return {
    releaseCheckArchiveDir,
    selfCheckArchiveDir,
  };
}

test("daily-status json stays minimal and points to routing first when routing blocks release", () => {
  const report = buildDailyStatusReport({
    report: {
      overall_status: "fail",
      blocking_checks: ["routing_regression", "planner_contract_failure"],
    },
    self_check_result: {
      system_summary: {
        safe_to_change: false,
      },
      routing_summary: {
        status: "degrade",
      },
      planner_summary: {
        gate: "fail",
      },
    },
  });

  assert.deepEqual(report, {
    routing_status: "degrade",
    planner_status: "fail",
    release_status: "fail",
    overall_recommendation: "check_routing_first",
  });
});

test("daily-status human summary maps system regression to the release line", () => {
  const releaseCheckResult = {
    report: {
      overall_status: "fail",
      blocking_checks: ["system_regression"],
    },
    self_check_result: {
      system_summary: {
        safe_to_change: false,
      },
      routing_summary: {
        status: "pass",
      },
      planner_summary: {
        gate: "pass",
      },
    },
  };

  assert.deepEqual(buildDailyStatusHumanSummary(releaseCheckResult), {
    develop: "先不要",
    merge: "先不要",
    release: "先不要",
    first_line_to_check: "release",
  });
  assert.equal(renderDailyStatusReport(releaseCheckResult), [
    "今天能不能安心開發：先不要",
    "今天能不能安心合併：先不要",
    "今天能不能安心發布：先不要",
    "若不能，先看哪一條線：release",
  ].join("\n"));
});

test("daily-status compare summary adds routing line and eval hint on regression", () => {
  const compare = buildDailyStatusCompareSummary({
    releaseCheckResult: {
      report: {
        overall_status: "fail",
        blocking_checks: ["routing_regression"],
        failing_area: "doc",
      },
      self_check_result: {
        system_summary: {
          safe_to_change: false,
        },
        routing_summary: {
          status: "degrade",
          compare: {
            has_obvious_regression: true,
          },
        },
        planner_summary: {
          gate: "pass",
          compare: {
            has_obvious_regression: false,
            compare_summary: {},
          },
        },
        planner_contract: {
          failing_categories: [],
        },
      },
    },
    previousReleaseReport: {
      overall_status: "pass",
      blocking_checks: [],
    },
  });

  assert.deepEqual(compare, {
    routing_status: "degrade",
    planner_status: "pass",
    release_status: "fail",
    overall_recommendation: "check_routing_first",
    changed_line: "routing",
    change_reason_hint: "doc",
    action_hint: "run routing-eval and inspect doc fixtures",
  });
});

test("daily-status compare summary maps planner drift to selector hint", () => {
  const compare = buildDailyStatusCompareSummary({
    releaseCheckResult: {
      report: {
        overall_status: "fail",
        blocking_checks: ["planner_contract_failure"],
      },
      self_check_result: {
        system_summary: {
          safe_to_change: false,
        },
        routing_summary: {
          status: "pass",
          compare: {
            has_obvious_regression: false,
          },
        },
        planner_summary: {
          gate: "fail",
          compare: {
            has_obvious_regression: true,
            compare_summary: {
              selector_contract_mismatches: {
                previous: 0,
                current: 1,
                delta: 1,
                status: "worse",
              },
            },
          },
        },
        planner_contract: {
          failing_categories: ["selector_contract_mismatches"],
        },
      },
    },
    previousReleaseReport: {
      overall_status: "pass",
      blocking_checks: [],
    },
  });

  assert.equal(compare.changed_line, "planner");
  assert.equal(compare.change_reason_hint, "selector");
  assert.equal(compare.action_hint, "run planner-contract-check and fix selector mismatch");
});

test("daily-status compare report keeps the daily summary and adds one reason line", () => {
  assert.equal(renderDailyStatusCompareReport({
    releaseCheckResult: {
      report: {
        overall_status: "fail",
        blocking_checks: ["system_regression"],
      },
      self_check_result: {
        system_summary: {
          safe_to_change: false,
        },
        routing_summary: {
          status: "pass",
          compare: {
            has_obvious_regression: false,
          },
        },
        planner_summary: {
          gate: "pass",
          compare: {
            has_obvious_regression: false,
            compare_summary: {},
          },
        },
        planner_contract: {
          failing_categories: [],
        },
      },
    },
    previousReleaseReport: {
      overall_status: "pass",
      blocking_checks: [],
    },
  }), [
    "今天能不能安心開發：先不要",
    "今天能不能安心合併：先不要",
    "今天能不能安心發布：先不要",
    "若不能，先看哪一條線：release",
    "下一步：inspect blocking_checks and representative_fail_case",
  ].join("\n"));
});

test("daily-status trend summary reports worsening trend and the most changed line", () => {
  const trendSummary = buildDailyStatusTrendSummary({
    recent_runs: [
      {
        run_id: "release-check-5",
        timestamp: "2026-03-22T00:00:01.000Z",
        routing_status: "pass",
        planner_status: "fail",
        release_status: "fail",
        overall_recommendation: "check_planner_first",
      },
      {
        run_id: "release-check-4",
        timestamp: "2026-03-21T00:00:01.000Z",
        routing_status: "degrade",
        planner_status: "pass",
        release_status: "fail",
        overall_recommendation: "check_routing_first",
      },
      {
        run_id: "release-check-3",
        timestamp: "2026-03-20T00:00:01.000Z",
        routing_status: "pass",
        planner_status: "pass",
        release_status: "pass",
        overall_recommendation: "safe_to_develop_merge_release",
      },
      {
        run_id: "release-check-2",
        timestamp: "2026-03-19T00:00:01.000Z",
        routing_status: "degrade",
        planner_status: "pass",
        release_status: "fail",
        overall_recommendation: "check_routing_first",
      },
      {
        run_id: "release-check-1",
        timestamp: "2026-03-18T00:00:01.000Z",
        routing_status: "pass",
        planner_status: "pass",
        release_status: "pass",
        overall_recommendation: "safe_to_develop_merge_release",
      },
    ],
  });

  assert.deepEqual(trendSummary, {
    sample_count: 5,
    trend: "worsening",
    most_changed_line: "routing",
    recent_runs: [
      {
        run_id: "release-check-5",
        timestamp: "2026-03-22T00:00:01.000Z",
        routing_status: "pass",
        planner_status: "fail",
        release_status: "fail",
        overall_recommendation: "check_planner_first",
      },
      {
        run_id: "release-check-4",
        timestamp: "2026-03-21T00:00:01.000Z",
        routing_status: "degrade",
        planner_status: "pass",
        release_status: "fail",
        overall_recommendation: "check_routing_first",
      },
      {
        run_id: "release-check-3",
        timestamp: "2026-03-20T00:00:01.000Z",
        routing_status: "pass",
        planner_status: "pass",
        release_status: "pass",
        overall_recommendation: "safe_to_develop_merge_release",
      },
      {
        run_id: "release-check-2",
        timestamp: "2026-03-19T00:00:01.000Z",
        routing_status: "degrade",
        planner_status: "pass",
        release_status: "fail",
        overall_recommendation: "check_routing_first",
      },
      {
        run_id: "release-check-1",
        timestamp: "2026-03-18T00:00:01.000Z",
        routing_status: "pass",
        planner_status: "pass",
        release_status: "pass",
        overall_recommendation: "safe_to_develop_merge_release",
      },
    ],
  });
  assert.equal(renderDailyStatusTrendReport(trendSummary), [
    "最近趨勢：惡化",
    "最常變動：routing",
  ].join("\n"));
});

test("daily-status CLI renders the bounded human summary", async () => {
  const archives = await seedDailyStatusArchives();
  const output = execFileSync("node", ["scripts/daily-status.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
    },
  });

  assert.equal(output.trim(), [
    "今天能不能安心開發：可以",
    "今天能不能安心合併：可以",
    "今天能不能安心發布：可以",
    "若不能，先看哪一條線：無",
  ].join("\n"));
});

test("daily-status CLI emits the minimal json report with --json", async () => {
  const archives = await seedDailyStatusArchives();
  const raw = execFileSync("node", ["scripts/daily-status.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
    },
  });

  assert.deepEqual(JSON.parse(raw), {
    routing_status: "pass",
    planner_status: "pass",
    release_status: "pass",
    overall_recommendation: "safe_to_develop_merge_release",
  });
});

test("daily-status CLI trend renders only the trend verdict and most changed line", async () => {
  const archives = await seedDailyStatusTrendArchives();
  const output = execFileSync("node", ["scripts/daily-status.mjs", "--trend"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
    },
  });

  assert.equal(output.trim(), [
    "最近趨勢：惡化",
    "最常變動：routing",
  ].join("\n"));
});

test("daily-status CLI trend json returns the minimal trend_summary", async () => {
  const archives = await seedDailyStatusTrendArchives();
  const raw = execFileSync("node", ["scripts/daily-status.mjs", "--trend", "--trend-count", "2", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
    },
  });

  assert.deepEqual(JSON.parse(raw), {
    trend_summary: {
      sample_count: 2,
      trend: "stable",
      most_changed_line: "routing",
      recent_runs: [
        {
          run_id: "release-check-20260322T000001000Z",
          timestamp: "2026-03-22T00:00:01.000Z",
          routing_status: "pass",
          planner_status: "fail",
          release_status: "fail",
          overall_recommendation: "check_planner_first",
        },
        {
          run_id: "release-check-20260321T000001000Z",
          timestamp: "2026-03-21T00:00:01.000Z",
          routing_status: "degrade",
          planner_status: "pass",
          release_status: "fail",
          overall_recommendation: "check_routing_first",
        },
      ],
    },
  });
});

test("daily-status CLI compare-previous adds only the short why-worse line", async () => {
  const archives = await seedDailyStatusArchives();
  execFileSync("node", ["scripts/daily-status.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
    },
  });

  const routingManifest = await readJson(path.join(archives.routingArchiveDir, "manifest.json"));
  const latestRoutingRunId = routingManifest.latest_run_id;
  const latestRoutingSnapshotPath = path.join(
    archives.routingArchiveDir,
    "snapshots",
    `${latestRoutingRunId}.json`,
  );
  const latestRoutingSnapshot = await readJson(latestRoutingSnapshotPath);
  latestRoutingSnapshot.run.summary.overall = {
    hits: 1,
    total: 2,
    accuracy_ratio: 0.5,
    accuracy: 50,
  };
  latestRoutingSnapshot.run.summary.by_lane_accuracy = {
    knowledge_assistant: {
      hits: 1,
      total: 2,
      accuracy_ratio: 0.5,
      accuracy: 50,
    },
  };
  latestRoutingSnapshot.run.summary.by_action_accuracy = {
    search_and_detail_doc: {
      hits: 1,
      total: 2,
      accuracy_ratio: 0.5,
      accuracy: 50,
    },
  };
  latestRoutingSnapshot.run.summary.error_breakdown = {
    ROUTING_NO_MATCH: {
      expected: 1,
      actual: 2,
      matched: 1,
      misses: 1,
    },
    INVALID_ACTION: {
      expected: 0,
      actual: 0,
      matched: 0,
      misses: 0,
    },
    FALLBACK_DISABLED: {
      expected: 0,
      actual: 0,
      matched: 0,
      misses: 0,
    },
  };
  latestRoutingSnapshot.run.summary.miss_count = 1;
  latestRoutingSnapshot.run.summary.top_miss_cases = [{
    id: "doc-compare-001",
    category: "doc",
    miss_dimensions: ["planner_action"],
    expected: {
      planner_action: "search_and_detail_doc",
    },
    actual: {
      planner_action: "get_runtime_info",
      route_source: "planner_flow",
    },
  }];
  await writeJson(latestRoutingSnapshotPath, latestRoutingSnapshot);

  const result = spawnSync("node", ["scripts/daily-status.mjs", "--compare-previous"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), [
    "今天能不能安心開發：先不要",
    "今天能不能安心合併：先不要",
    "今天能不能安心發布：先不要",
    "若不能，先看哪一條線：routing",
    "下一步：run routing-eval and inspect doc fixtures",
  ].join("\n"));
});

test("daily-status CLI json compare-snapshot adds changed_line and reason hint", async () => {
  const archives = await seedDailyStatusArchives();
  execFileSync("node", ["scripts/daily-status.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
    },
  });

  const releaseManifest = await readJson(path.join(archives.releaseCheckArchiveDir, "manifest.json"));
  const firstRunId = releaseManifest.latest_run_id;
  const firstSnapshotPath = path.join(archives.releaseCheckArchiveDir, "snapshots", `${firstRunId}.json`);
  const firstSnapshot = await readJson(firstSnapshotPath);
  firstSnapshot.overall_status = "pass";
  firstSnapshot.blocking_checks = [];
  await writeJson(firstSnapshotPath, firstSnapshot);

  releaseManifest.snapshots[0].overall_status = "pass";
  releaseManifest.snapshots[0].blocking_checks = [];
  await writeJson(path.join(archives.releaseCheckArchiveDir, "manifest.json"), releaseManifest);

  const routingManifest = await readJson(path.join(archives.routingArchiveDir, "manifest.json"));
  const latestRoutingRunId = routingManifest.latest_run_id;
  const latestRoutingSnapshotPath = path.join(
    archives.routingArchiveDir,
    "snapshots",
    `${latestRoutingRunId}.json`,
  );
  const latestRoutingSnapshot = await readJson(latestRoutingSnapshotPath);
  latestRoutingSnapshot.run.summary.overall = {
    hits: 1,
    total: 2,
    accuracy_ratio: 0.5,
    accuracy: 50,
  };
  latestRoutingSnapshot.run.summary.by_lane_accuracy = {
    knowledge_assistant: {
      hits: 1,
      total: 2,
      accuracy_ratio: 0.5,
      accuracy: 50,
    },
  };
  latestRoutingSnapshot.run.summary.by_action_accuracy = {
    search_and_detail_doc: {
      hits: 1,
      total: 2,
      accuracy_ratio: 0.5,
      accuracy: 50,
    },
  };
  latestRoutingSnapshot.run.summary.error_breakdown = {
    ROUTING_NO_MATCH: {
      expected: 1,
      actual: 2,
      matched: 1,
      misses: 1,
    },
    INVALID_ACTION: {
      expected: 0,
      actual: 0,
      matched: 0,
      misses: 0,
    },
    FALLBACK_DISABLED: {
      expected: 0,
      actual: 0,
      matched: 0,
      misses: 0,
    },
  };
  latestRoutingSnapshot.run.summary.miss_count = 1;
  latestRoutingSnapshot.run.summary.top_miss_cases = [{
    id: "doc-compare-json-001",
    category: "doc",
    miss_dimensions: ["planner_action"],
    expected: {
      planner_action: "search_and_detail_doc",
    },
    actual: {
      planner_action: "get_runtime_info",
      route_source: "planner_flow",
    },
  }];
  await writeJson(latestRoutingSnapshotPath, latestRoutingSnapshot);

  const result = spawnSync("node", [
    "scripts/daily-status.mjs",
    "--json",
    "--compare-snapshot",
    firstRunId,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
    },
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    routing_status: "fail",
    planner_status: "pass",
    release_status: "fail",
    overall_recommendation: "check_routing_first",
    changed_line: "routing",
    change_reason_hint: "doc",
    action_hint: "run routing-eval and inspect doc fixtures",
  });
});
