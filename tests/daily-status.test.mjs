import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  buildDailyStatusHumanSummary,
  buildDailyStatusReport,
  renderDailyStatusReport,
} from "../src/daily-status.mjs";
import { runPlannerContractConsistencyCheck } from "../src/planner-contract-consistency.mjs";
import { archivePlannerDiagnosticsSnapshot } from "../src/planner-diagnostics-history.mjs";
import { buildRoutingDiagnosticsSummary } from "../src/routing-eval-diagnostics.mjs";
import { archiveRoutingDiagnosticsSnapshot } from "../src/routing-diagnostics-history.mjs";
import { runRoutingEval } from "../src/routing-eval.mjs";

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
