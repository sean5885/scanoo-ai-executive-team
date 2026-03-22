import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { runPlannerContractConsistencyCheck } from "../src/planner-contract-consistency.mjs";
import { archivePlannerDiagnosticsSnapshot } from "../src/planner-diagnostics-history.mjs";
import { buildRoutingDiagnosticsSummary } from "../src/routing-eval-diagnostics.mjs";
import { archiveRoutingDiagnosticsSnapshot } from "../src/routing-diagnostics-history.mjs";
import { runRoutingEval } from "../src/routing-eval.mjs";
import { runSystemSelfCheck } from "../src/system-self-check.mjs";

async function seedSelfCheckArchives() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "system-self-check-"));
  const routingArchiveDir = path.join(baseDir, "routing");
  const plannerArchiveDir = path.join(baseDir, "planner");

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
  };
}

test("system self-check returns unified routing and planner summaries", async () => {
  const archives = await seedSelfCheckArchives();
  const result = await runSystemSelfCheck(archives);

  assert.equal(result.ok, true);
  assert.equal(result.system_summary.safe_to_change, true);
  assert.equal(result.system_summary.core_checks, "pass");
  assert.equal(result.system_summary.routing_status, "pass");
  assert.equal(result.system_summary.planner_gate, "pass");
  assert.equal(result.system_summary.has_obvious_regression, false);
  assert.equal(result.routing_summary.status, "pass");
  assert.equal(result.routing_summary.compare.available, true);
  assert.equal(result.routing_summary.compare.has_obvious_regression, false);
  assert.equal(result.planner_summary.gate, "pass");
  assert.equal(result.planner_summary.compare.available, true);
  assert.equal(result.planner_summary.compare.has_obvious_regression, false);
  assert.equal(result.agents.missing.length, 0);
  assert.equal(result.agents.invalid_contracts.length, 0);
  assert.equal(result.agents.knowledge_subcommands_missing.length, 0);
  assert.equal(result.routes.missing.length, 0);
  assert.equal(result.services.every((item) => item.ok), true);
  assert.equal(result.planner_contract.gate_ok, true);
  assert.equal(result.planner_contract.consistency_ok, true);
  assert.deepEqual(result.planner_contract.failing_categories, []);
});

test("self-check CLI renders concise guidance by default", async () => {
  const archives = await seedSelfCheckArchives();
  const output = execFileSync("node", ["scripts/self-check.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
    },
  });

  assert.match(output, /System Self-Check/);
  assert.match(output, /現在系統能不能放心改：可以/);
  assert.match(output, /結論：core pass \| routing pass \| planner pass \| regression no/);
  assert.match(output, /先看：none/);
  assert.match(output, /指引：可以開始改；改 routing 後回看 routing:diagnostics，改 planner 後回看 planner:diagnostics 與 self-check。/);
});

test("self-check CLI emits unified JSON report with --json", async () => {
  const archives = await seedSelfCheckArchives();
  const raw = execFileSync("node", ["scripts/self-check.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
    },
  });
  const parsed = JSON.parse(raw);

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.system_summary, {
    safe_to_change: true,
    answer: "可以",
    core_checks: "pass",
    routing_status: "pass",
    planner_gate: "pass",
    has_obvious_regression: false,
    review_priority: "none",
    guidance: "可以開始改；改 routing 後回看 routing:diagnostics，改 planner 後回看 planner:diagnostics 與 self-check。",
  });
  assert.equal(parsed.routing_summary.status, "pass");
  assert.equal(parsed.planner_summary.gate, "pass");
  assert.equal(parsed.routing_summary.latest_snapshot.run_id, "routing-2");
  assert.match(parsed.planner_summary.latest_snapshot.run_id, /^planner-diagnostics-/);
});
