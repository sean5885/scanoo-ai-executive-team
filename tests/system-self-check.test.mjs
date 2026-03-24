import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  buildPlannerContractGate,
  buildPlannerDiagnosticsDecision,
  buildPlannerDiagnosticsSummary,
  runPlannerContractConsistencyCheck,
} from "../src/planner-contract-consistency.mjs";
import { archivePlannerDiagnosticsSnapshot } from "../src/planner-diagnostics-history.mjs";
import { buildRoutingDiagnosticsSummary } from "../src/routing-eval-diagnostics.mjs";
import { archiveRoutingDiagnosticsSnapshot } from "../src/routing-diagnostics-history.mjs";
import { runRoutingEval, summarizeRoutingEval } from "../src/routing-eval.mjs";
import { runSystemSelfCheck } from "../src/system-self-check.mjs";

async function seedSelfCheckArchives() {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "system-self-check-"));
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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

test("system self-check returns unified routing and planner summaries", async () => {
  const archives = await seedSelfCheckArchives();
  const result = await runSystemSelfCheck(archives);

  assert.equal(result.ok, true);
  assert.equal(result.doc_boundary_regression, false);
  assert.equal(result.system_summary.status, "pass");
  assert.equal(result.system_summary.safe_to_change, true);
  assert.equal(result.system_summary.core_checks, "pass");
  assert.equal(result.system_summary.company_brain_status, "pass");
  assert.equal(result.system_summary.control_status, "pass");
  assert.equal(result.system_summary.routing_status, "pass");
  assert.equal(result.system_summary.planner_gate, "pass");
  assert.equal(result.system_summary.has_obvious_regression, false);
  assert.equal(result.company_brain_summary.status, "pass");
  assert.equal(result.company_brain_summary.failing_routes.length, 0);
  assert.equal(result.company_brain_summary.failing_cases.length, 0);
  assert.equal(result.control_summary.status, "pass");
  assert.equal(result.control_summary.issue_count, 0);
  assert.equal(result.routing_summary.status, "pass");
  assert.equal(result.routing_summary.doc_boundary_regression, false);
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
  assert.match(result.self_check_archive.run_id, /^self-check-/);

  const manifest = readJson(path.join(archives.selfCheckArchiveDir, "manifest.json"));
  const snapshot = readJson(path.join(
    archives.selfCheckArchiveDir,
    "snapshots",
    `${result.self_check_archive.run_id}.json`,
  ));

  assert.deepEqual(manifest.snapshots[0], {
    run_id: result.self_check_archive.run_id,
    timestamp: result.self_check_archive.timestamp,
    system_status: "pass",
    control_status: "pass",
    routing_status: "pass",
    planner_status: "pass",
  });
  assert.equal(snapshot.run_id, result.self_check_archive.run_id);
  assert.equal(snapshot.system_summary.status, "pass");
  assert.equal(snapshot.system_summary.company_brain_status, "pass");
  assert.equal(snapshot.system_summary.control_status, "pass");
  assert.equal(snapshot.doc_boundary_regression, false);
  assert.equal(snapshot.control_summary.status, "pass");
  assert.equal(snapshot.routing_summary.status, "pass");
  assert.equal(snapshot.routing_summary.doc_boundary_regression, false);
  assert.equal(snapshot.planner_summary.gate, "pass");
});

test("system self-check marks doc-boundary routing regressions and points to intent guards", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "system-self-check-doc-boundary-"));
  const routingArchiveDir = path.join(baseDir, "routing");
  const plannerArchiveDir = path.join(baseDir, "planner");
  const selfCheckArchiveDir = path.join(baseDir, "self-check");
  const stableRoutingRun = await runRoutingEval();

  await archiveRoutingDiagnosticsSnapshot({
    baseDir: routingArchiveDir,
    runId: "routing-1",
    timestamp: "2026-03-22T00:00:00.000Z",
    scope: "routing-eval",
    stage: "standalone",
    run: stableRoutingRun,
    diagnosticsSummary: buildRoutingDiagnosticsSummary({
      run: stableRoutingRun,
      previousRun: null,
      currentLabel: "snapshot:routing-1",
    }),
  });

  const docBoundaryRun = {
    ...stableRoutingRun,
    results: stableRoutingRun.results.map((item) => (
      item.id === "doc-023a"
        ? {
            ...item,
            actual: {
              ...item.actual,
              lane: "personal_assistant",
              planner_action: "ROUTING_NO_MATCH",
              agent_or_tool: "error:ROUTING_NO_MATCH",
              route_source: "lane_executor",
            },
            matches: {
              lane: false,
              planner_action: false,
              agent_or_tool: false,
              overall: false,
            },
            miss_dimensions: ["lane", "planner_action", "agent_or_tool"],
          }
        : item
    )),
  };
  docBoundaryRun.summary = summarizeRoutingEval(docBoundaryRun.results);

  await archiveRoutingDiagnosticsSnapshot({
    baseDir: routingArchiveDir,
    runId: "routing-2",
    timestamp: "2026-03-22T00:00:01.000Z",
    scope: "routing-eval",
    stage: "standalone",
    run: docBoundaryRun,
    diagnosticsSummary: buildRoutingDiagnosticsSummary({
      run: docBoundaryRun,
      previousRun: stableRoutingRun,
      currentLabel: "snapshot:routing-2",
      previousLabel: "snapshot:routing-1",
    }),
  });

  const plannerReport = runPlannerContractConsistencyCheck();
  await archivePlannerDiagnosticsSnapshot({
    baseDir: plannerArchiveDir,
    commandName: "planner-diagnostics",
    report: plannerReport,
    timestamp: "2026-03-22T00:00:02.000Z",
  });

  const result = await runSystemSelfCheck({
    routingArchiveDir,
    plannerArchiveDir,
    selfCheckArchiveDir,
  });

  assert.equal(result.ok, false);
  assert.equal(result.doc_boundary_regression, true);
  assert.equal(result.routing_summary.status, "degrade");
  assert.equal(result.routing_summary.doc_boundary_regression, true);
  assert.match(result.routing_summary.guidance, /doc-boundary 類問題/);
  assert.equal(result.system_summary.review_priority, "routing");
  assert.match(result.system_summary.guidance, /優先檢查 intent guard/);
});

test("system self-check surfaces planner create_doc governance mismatches", async () => {
  const archives = await seedSelfCheckArchives();
  const baseReport = runPlannerContractConsistencyCheck();
  const governanceFindings = [
    {
      category: "action_governance_mismatches",
      source_id: "action_governance:create_doc:contract_vs_route_contract",
      file: "/Users/seanhan/Documents/Playground/docs/system/planner_contract.json",
      target: "create_doc",
      reason: "confirm_required_mismatch",
      field: "confirm_required",
      expected: null,
      actual: true,
      counterpart_file: "/Users/seanhan/Documents/Playground/src/http-route-contracts.mjs",
    },
  ];
  const diagnosticsSummary = buildPlannerDiagnosticsSummary({
    gate: buildPlannerContractGate({
      undefined_actions: [],
      undefined_presets: [],
      selector_contract_mismatches: [],
      action_governance_mismatches: governanceFindings,
      deprecated_reachable_targets: [],
    }),
    summary: {
      undefined_actions: 0,
      undefined_presets: 0,
      selector_contract_mismatches: 0,
      action_governance_mismatches: governanceFindings.length,
      deprecated_reachable_targets: 0,
    },
  });
  const plannerReport = {
    ...baseReport,
    ok: false,
    gate: buildPlannerContractGate({
      undefined_actions: [],
      undefined_presets: [],
      selector_contract_mismatches: [],
      action_governance_mismatches: governanceFindings,
      deprecated_reachable_targets: [],
    }),
    diagnostics_summary: diagnosticsSummary,
    decision: buildPlannerDiagnosticsDecision(diagnosticsSummary),
    summary: {
      ...baseReport.summary,
      undefined_actions: 0,
      undefined_presets: 0,
      selector_contract_mismatches: 0,
      action_governance_mismatches: governanceFindings.length,
      deprecated_reachable_targets: 0,
    },
    findings: {
      ...baseReport.findings,
      undefined_actions: [],
      undefined_presets: [],
      selector_contract_mismatches: [],
      action_governance_mismatches: governanceFindings,
      deprecated_reachable_targets: [],
    },
  };

  const result = await runSystemSelfCheck({
    ...archives,
    plannerContractCheck: () => plannerReport,
  });

  assert.equal(result.ok, false);
  assert.equal(result.system_summary.review_priority, "planner");
  assert.equal(result.planner_summary.gate, "fail");
  assert.equal(result.planner_contract.gate_ok, false);
  assert.deepEqual(result.planner_contract.failing_categories, ["action_governance_mismatches"]);
  assert.match(result.planner_summary.guidance, /action_governance_mismatches/);
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
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });

  assert.match(output, /System Self-Check/);
  assert.match(output, /現在系統能不能放心改：可以/);
  assert.match(output, /結論：core pass \| company-brain pass \| control pass \| routing pass \| planner pass \| regression no/);
  assert.match(output, /先看：none/);
  assert.match(output, /指引：可以開始改；改 control 後回看 control:diagnostics，改 routing 後回看 routing:diagnostics，改 planner 後回看 planner:diagnostics 與 self-check。/);
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
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });
  const parsed = JSON.parse(raw);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.doc_boundary_regression, false);
  assert.equal(parsed.company_brain_summary.status, "pass");
  assert.deepEqual(parsed.system_summary, {
    status: "pass",
    safe_to_change: true,
    answer: "可以",
    core_checks: "pass",
    company_brain_status: "pass",
    control_status: "pass",
    routing_status: "pass",
    planner_gate: "pass",
    has_obvious_regression: false,
    review_priority: "none",
    guidance: "可以開始改；改 control 後回看 control:diagnostics，改 routing 後回看 routing:diagnostics，改 planner 後回看 planner:diagnostics 與 self-check。",
  });
  assert.equal(parsed.control_summary.status, "pass");
  assert.equal(parsed.routing_summary.status, "pass");
  assert.equal(parsed.routing_summary.doc_boundary_regression, false);
  assert.equal(parsed.planner_summary.gate, "pass");
  assert.equal(parsed.routing_summary.latest_snapshot.run_id, "routing-2");
  assert.match(parsed.planner_summary.latest_snapshot.run_id, /^planner-diagnostics-/);
  assert.match(parsed.self_check_archive.run_id, /^self-check-/);
});

test("self-check CLI compare-previous prints the minimal compare view", async () => {
  const archives = await seedSelfCheckArchives();
  execFileSync("node", ["scripts/self-check.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });

  const output = execFileSync("node", ["scripts/self-check.mjs", "--compare-previous"], {
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
    "system: 無變化",
    "control regression: 無",
    "routing regression: 無",
    "planner regression: 無",
  ].join("\n"));
});

test("self-check CLI json compare_summary stays minimal", async () => {
  const archives = await seedSelfCheckArchives();
  const firstRaw = execFileSync("node", ["scripts/self-check.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });
  const firstParsed = JSON.parse(firstRaw);
  const firstSnapshotPath = path.join(
    archives.selfCheckArchiveDir,
    "snapshots",
    `${firstParsed.self_check_archive.run_id}.json`,
  );
  const firstSnapshot = readJson(firstSnapshotPath);
  firstSnapshot.system_summary.status = "degrade";
  firstSnapshot.system_summary.safe_to_change = false;
  firstSnapshot.system_summary.answer = "先不要";
  firstSnapshot.system_summary.has_obvious_regression = true;
  firstSnapshot.system_summary.review_priority = "routing";
  firstSnapshot.routing_summary.status = "degrade";
  writeJson(firstSnapshotPath, firstSnapshot);

  const manifestPath = path.join(archives.selfCheckArchiveDir, "manifest.json");
  const manifest = readJson(manifestPath);
  manifest.snapshots[0].system_status = "degrade";
  manifest.snapshots[0].routing_status = "degrade";
  writeJson(manifestPath, manifest);

  const raw = execFileSync("node", [
    "scripts/self-check.mjs",
    "--json",
    "--compare-snapshot",
    firstParsed.self_check_archive.run_id,
  ], {
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

  assert.deepEqual(parsed.compare_summary, {
    system_status: "better",
    control_regression: false,
    routing_regression: false,
    planner_regression: false,
  });
});
