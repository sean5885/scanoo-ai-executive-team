import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  buildReleaseCheckReport,
  renderReleaseCheckReport,
  runReleaseCheck,
} from "../src/release-check.mjs";
import { runPlannerContractConsistencyCheck } from "../src/planner-contract-consistency.mjs";
import { archivePlannerDiagnosticsSnapshot } from "../src/planner-diagnostics-history.mjs";
import { buildRoutingDiagnosticsSummary } from "../src/routing-eval-diagnostics.mjs";
import { archiveRoutingDiagnosticsSnapshot } from "../src/routing-diagnostics-history.mjs";
import { runRoutingEval } from "../src/routing-eval.mjs";

async function seedReleaseCheckArchives() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "release-check-"));
  const routingArchiveDir = path.join(baseDir, "routing");
  const plannerArchiveDir = path.join(baseDir, "planner");
  const selfCheckArchiveDir = path.join(baseDir, "self-check");

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
    routingArchiveDir,
    selfCheckArchiveDir,
  };
}

test("release-check report passes when self-check, routing, and planner are stable", async () => {
  const archives = await seedReleaseCheckArchives();
  const result = await runReleaseCheck(archives);

  assert.deepEqual(result.report, {
    overall_status: "pass",
    blocking_checks: [],
    suggested_next_step: "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。",
  });
});

test("release-check report prioritizes routing before planner when both block", () => {
  const report = buildReleaseCheckReport({
    selfCheckResult: {
      ok: false,
      system_summary: {
        core_checks: "pass",
      },
      routing_summary: {
        status: "degrade",
        compare: {
          has_obvious_regression: true,
        },
      },
      planner_summary: {
        gate: "fail",
        compare: {
          has_obvious_regression: false,
        },
      },
    },
  });

  assert.deepEqual(report, {
    overall_status: "fail",
    blocking_checks: ["routing", "planner"],
    suggested_next_step: "先修 routing 線：先看 latest snapshot 與 compare，判斷是 fixture coverage 還是 routing rule regression。",
  });
});

test("release-check human output stays limited to two answers", () => {
  assert.equal(
    renderReleaseCheckReport({
      overall_status: "fail",
      blocking_checks: ["self_check_base", "routing"],
      suggested_next_step: "unused",
    }),
    [
      "能否放心合併/發布：先不要",
      "若不能，先修哪一條線：self-check 基礎項目",
    ].join("\n"),
  );
});

test("release-check CLI emits only the minimal JSON structure", async () => {
  const archives = await seedReleaseCheckArchives();
  const raw = execFileSync("node", ["scripts/release-check.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });
  const parsed = JSON.parse(raw);

  assert.deepEqual(parsed, {
    overall_status: "pass",
    blocking_checks: [],
    suggested_next_step: "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。",
  });
});

test("release-check CLI default output stays limited to two lines", async () => {
  const archives = await seedReleaseCheckArchives();
  const output = execFileSync("node", ["scripts/release-check.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });

  assert.equal(output.trim(), [
    "能否放心合併/發布：可以",
    "若不能，先修哪一條線：無",
  ].join("\n"));
});
