import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";

import {
  buildReleaseCheckCompareSummary,
  buildReleaseCheckDrilldown,
  buildReleaseCheckReport,
  getReleaseCheckExitCode,
  renderReleaseCheckReport,
  runReleaseCheck,
} from "../src/release-check.mjs";
import {
  archiveControlDiagnosticsSnapshot,
  resolveControlDiagnosticsSnapshot,
} from "../src/control-diagnostics-history.mjs";
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
    releaseCheckArchiveDir: path.join(baseDir, "release-check"),
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

const PASS_WRITE_GOVERNANCE = {
  status: "pass",
  metadata_route_count: 7,
  enforced_route_count: 7,
  route_coverage_ratio: 1,
  mode_counts: {
    enforce: 2,
    observe: 2,
    warn: 3,
  },
  violation_type_stats: {
    missing_scope_key: 7,
    missing_idempotency_key: 2,
    confirm_required: 7,
    review_required: 4,
  },
  rollout_rules: {
    evidence_source: "real_request_backed",
    warn_to_enforce: {
      max_real_violation_rate: 0.01,
      min_real_sample_size: 20,
    },
  },
  rollout_basis_summary: {
    evidence_source: "real_request_backed",
    candidate_route_count: 1,
    eligible_route_count: 0,
    blocked_route_count: 1,
    routes: [
      {
        pathname: "/api/meeting/confirm",
        action: "meeting_confirm_write",
        current_mode: "warn",
        target_mode: "enforce",
        eligible: false,
        real_traffic_sample_count: 0,
        real_traffic_violation_rate: null,
      },
    ],
  },
  upgrade_ready_routes: [],
  high_risk_routes: [
    {
      pathname: "/api/meeting/confirm",
      action: "meeting_confirm_write",
      current_mode: "warn",
      target_mode: "enforce",
      recommendation: "hold_warn",
      real_traffic_sample_count: 0,
      real_traffic_violation_rate: null,
    },
    {
      pathname: "/meeting/confirm",
      action: "meeting_confirm_write",
      current_mode: "warn",
      target_mode: "enforce",
      recommendation: "hold_warn",
      real_traffic_sample_count: 0,
      real_traffic_violation_rate: null,
    },
  ],
};

test("release-check report passes when self-check, routing, and planner are stable", async () => {
  const archives = await seedReleaseCheckArchives();
  const result = await runReleaseCheck(archives);

  assert.deepEqual(result.report, {
    overall_status: "pass",
    blocking_checks: [],
    doc_boundary_regression: false,
    write_governance: PASS_WRITE_GOVERNANCE,
    suggested_next_step: "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。",
    action_hint: null,
    failing_area: null,
    representative_fail_case: [],
    drilldown_source: [],
  });
});

test("release-check compare summary only reports status and field changes", () => {
  assert.deepEqual(buildReleaseCheckCompareSummary({
    currentReport: {
      overall_status: "pass",
      blocking_checks: [],
      suggested_next_step: "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。",
    },
    previousReport: {
      overall_status: "fail",
      blocking_checks: ["routing_regression"],
      suggested_next_step: "先看 routing regression 的 rule 模組：src/router.js 與 src/planner-*-flow.mjs。",
    },
  }), {
    release_status: "better",
    blocking_checks_changed: true,
    suggested_next_step_changed: true,
  });
});

test("release-check report blocks on company-brain lifecycle governance failures", () => {
  const report = buildReleaseCheckReport({
    selfCheckResult: {
      ok: false,
      system_summary: {
        core_checks: "pass",
        company_brain_status: "fail",
      },
      company_brain_summary: {
        status: "fail",
        failing_routes: [
          {
            pathname: "/agent/company-brain/docs/test-doc/apply",
          },
        ],
        failing_cases: [
          {
            case_id: "missing_review",
          },
        ],
      },
      control_summary: {
        status: "pass",
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
        },
      },
    },
    drilldown: {
      failing_area: "doc",
      representative_fail_case: ["company_brain_apply_gate:missing_review"],
      drilldown_source: ["release-check triage"],
    },
  });

  assert.deepEqual(report, {
    overall_status: "fail",
    blocking_checks: ["company_brain_lifecycle_failure"],
    doc_boundary_regression: false,
    suggested_next_step: "先看 company-brain lifecycle contract：src/company-brain-lifecycle-contract.mjs、src/http-route-contracts.mjs、src/system-self-check.mjs；不要改 runtime write path。",
    action_hint: "inspect company-brain lifecycle contract and apply gate",
    failing_area: "doc",
    representative_fail_case: ["company_brain_apply_gate:missing_review"],
    drilldown_source: ["release-check triage"],
  });
});

test("release-check report prioritizes routing before planner when both block", () => {
  const report = buildReleaseCheckReport({
    selfCheckResult: {
      ok: false,
      system_summary: {
        core_checks: "pass",
        company_brain_status: "pass",
      },
      routing_summary: {
        status: "degrade",
        doc_boundary_regression: true,
        diagnostics_summary: {
          decision_advice: {
            minimal_decision: {
              action: "check_routing_rule",
            },
          },
        },
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
      planner_contract: {
        failing_categories: ["undefined_actions"],
      },
    },
    drilldown: {
      failing_area: "doc",
      representative_fail_case: ["doc-001 [doc] planner_action via planner_flow"],
      drilldown_source: ["release-check triage", "routing-eval diagnostics/history"],
    },
  });

  assert.deepEqual(report, {
    overall_status: "fail",
    blocking_checks: ["routing_regression", "planner_contract_failure"],
    doc_boundary_regression: true,
    suggested_next_step: "先看 routing regression 的 doc-boundary pack：evals/routing-eval-set.mjs 的 doc-023a~023k；再看 src/message-intent-utils.mjs 與 src/lane-executor.mjs 的 intent guard。",
    action_hint: "run routing-eval doc-boundary pack and inspect message-intent-utils / lane-executor guard",
    failing_area: "doc",
    representative_fail_case: ["doc-001 [doc] planner_action via planner_flow"],
    drilldown_source: ["release-check triage", "routing-eval diagnostics/history"],
  });
});

test("release-check report classifies system regression and points to base modules", () => {
  const report = buildReleaseCheckReport({
    selfCheckResult: {
      ok: false,
      system_summary: {
        core_checks: "fail",
        company_brain_status: "pass",
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
        },
      },
      agents: {
        missing: ["cmo"],
        invalid_contracts: [],
        knowledge_subcommands_missing: [],
      },
      routes: {
        missing: [],
      },
      services: [],
    },
    drilldown: {
      failing_area: "mixed",
      representative_fail_case: ["agent_missing:cmo"],
      drilldown_source: ["release-check triage"],
    },
  });

  assert.deepEqual(report, {
    overall_status: "fail",
    blocking_checks: ["system_regression"],
    doc_boundary_regression: false,
    suggested_next_step: "先看 system regression 的 agent registry / contract：src/agent-registry.mjs。",
    action_hint: "inspect blocking_checks and representative_fail_case",
    failing_area: "mixed",
    representative_fail_case: ["agent_missing:cmo"],
    drilldown_source: ["release-check triage"],
  });
});

test("release-check report classifies control regression and points to control modules", () => {
  const report = buildReleaseCheckReport({
    selfCheckResult: {
      ok: false,
      system_summary: {
        core_checks: "pass",
        company_brain_status: "pass",
      },
      control_summary: {
        status: "fail",
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
        },
      },
    },
    drilldown: {
      failing_area: "runtime",
      representative_fail_case: ["control_integration_missing:lane_executor_owner_assertions via src/lane-executor.mjs"],
      drilldown_source: ["release-check triage", "control diagnostics/history"],
    },
  });

  assert.deepEqual(report, {
    overall_status: "fail",
    blocking_checks: ["control_regression"],
    doc_boundary_regression: false,
    suggested_next_step: "先看 control regression 的 control 模組：src/control-kernel.mjs 與 src/lane-executor.mjs。",
    action_hint: "inspect blocking_checks and representative_fail_case",
    failing_area: "runtime",
    representative_fail_case: ["control_integration_missing:lane_executor_owner_assertions via src/lane-executor.mjs"],
    drilldown_source: ["release-check triage", "control diagnostics/history"],
  });
});

test("release-check report points planner contract failure to planner registry first", () => {
  const report = buildReleaseCheckReport({
    selfCheckResult: {
      ok: false,
      system_summary: {
        core_checks: "pass",
        company_brain_status: "pass",
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
          has_obvious_regression: false,
        },
      },
      planner_contract: {
        failing_categories: ["undefined_actions", "undefined_presets"],
      },
    },
    drilldown: {
      failing_area: "doc",
      representative_fail_case: ["undefined_actions:search_and_detail_doc via planner_tool_registry"],
      drilldown_source: ["release-check triage", "planner diagnostics/history"],
    },
  });

  assert.deepEqual(report, {
    overall_status: "fail",
    blocking_checks: ["planner_contract_failure"],
    doc_boundary_regression: false,
    suggested_next_step: "先看 planner contract failure 的 registry 模組：src/executive-planner.mjs；只有 intentional stable target 才改 docs/system/planner_contract.json。",
    action_hint: "run planner-contract-check and fix contract mismatch",
    failing_area: "doc",
    representative_fail_case: ["undefined_actions:search_and_detail_doc via planner_tool_registry"],
    drilldown_source: ["release-check triage", "planner diagnostics/history"],
  });
});

test("release-check report points create_doc governance mismatch to gate modules", () => {
  const report = buildReleaseCheckReport({
    selfCheckResult: {
      ok: false,
      system_summary: {
        core_checks: "pass",
        company_brain_status: "pass",
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
          has_obvious_regression: false,
        },
      },
      planner_contract: {
        failing_categories: ["action_governance_mismatches"],
      },
    },
    drilldown: {
      failing_area: "doc",
      representative_fail_case: ["action_governance_mismatches:create_doc via action_governance:create_doc:contract_vs_route_contract"],
      drilldown_source: ["release-check triage", "planner diagnostics/history"],
    },
  });

  assert.deepEqual(report, {
    overall_status: "fail",
    blocking_checks: ["planner_contract_failure"],
    doc_boundary_regression: false,
    suggested_next_step: "先看 planner contract failure 的 create_doc gate 模組：src/executive-planner.mjs、src/http-route-contracts.mjs、src/lark-write-guard.mjs；先對齊 source、owner、intent、type entry governance，只有 intentional stable target 才改 docs/system/planner_contract.json。",
    action_hint: "run planner-contract-check and fix governance mismatch",
    failing_area: "doc",
    representative_fail_case: ["action_governance_mismatches:create_doc via action_governance:create_doc:contract_vs_route_contract"],
    drilldown_source: ["release-check triage", "planner diagnostics/history"],
  });
});

test("release-check drilldown derives routing representative miss cases from history", () => {
  const drilldown = buildReleaseCheckDrilldown({
    selfCheckResult: {
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
        },
      },
      system_summary: {
        core_checks: "pass",
        company_brain_status: "pass",
      },
    },
    latestRoutingSnapshot: {
      run: {
        summary: {
          top_miss_cases: [
            {
              id: "doc-001",
              category: "doc",
              miss_dimensions: ["planner_action"],
              actual: {
                route_source: "planner_flow",
              },
            },
            {
              id: "doc-002",
              category: "doc",
              miss_dimensions: ["agent_or_tool"],
              actual: {
                route_source: "planner_flow",
              },
            },
          ],
        },
      },
    },
  });

  assert.deepEqual(drilldown, {
    failing_area: "doc",
    representative_fail_case: [
      "doc-001 [doc] planner_action via planner_flow",
      "doc-002 [doc] agent_or_tool via planner_flow",
    ],
    drilldown_source: ["release-check triage", "routing-eval diagnostics/history"],
  });
});

test("release-check drilldown derives planner representative findings from diagnostics", () => {
  const drilldown = buildReleaseCheckDrilldown({
    selfCheckResult: {
      routing_summary: {
        status: "pass",
        compare: {
          has_obvious_regression: false,
        },
      },
      planner_summary: {
        gate: "fail",
        compare: {
          has_obvious_regression: false,
        },
      },
      system_summary: {
        core_checks: "pass",
        company_brain_status: "pass",
      },
    },
    plannerReport: {
      findings: {
        undefined_actions: [
          {
            category: "undefined_actions",
            target: "search_and_detail_doc",
            source_id: "planner_tool_registry",
            file: "/Users/seanhan/Documents/Playground/src/executive-planner.mjs",
          },
        ],
        undefined_presets: [
          {
            category: "undefined_presets",
            target: "create_and_list_doc",
            source_id: "planner_preset_registry",
            file: "/Users/seanhan/Documents/Playground/src/executive-planner.mjs",
          },
        ],
        selector_contract_mismatches: [],
        deprecated_reachable_targets: [],
      },
    },
  });

  assert.deepEqual(drilldown, {
    failing_area: "mixed",
    representative_fail_case: [
      "undefined_actions:search_and_detail_doc via planner_tool_registry",
      "undefined_presets:create_and_list_doc via planner_preset_registry",
    ],
    drilldown_source: ["release-check triage", "planner diagnostics/history"],
  });
});

test("release-check drilldown derives system representative cases from triage", () => {
  const drilldown = buildReleaseCheckDrilldown({
    selfCheckResult: {
      system_summary: {
        core_checks: "fail",
        company_brain_status: "pass",
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
        },
      },
      services: [],
      routes: {
        missing: ["/api/meeting/process"],
      },
      agents: {
        missing: [],
        invalid_contracts: [],
        knowledge_subcommands_missing: [],
      },
    },
  });

  assert.deepEqual(drilldown, {
    failing_area: "meeting",
    representative_fail_case: ["route_missing:/api/meeting/process"],
    drilldown_source: ["release-check triage"],
  });
});

test("release-check drilldown derives control representative issues from diagnostics history", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "release-check-control-drilldown-"));
  const controlArchiveDir = path.join(baseDir, "control");
  await archiveControlDiagnosticsSnapshot({
    baseDir: controlArchiveDir,
    report: {
      diagnostics_summary: {
        overall_status: "fail",
        control_status: "fail",
        routing_status: "pass",
        write_status: "pass",
        control_issue_count: 2,
        routing_issue_count: 0,
        write_issue_count: 0,
      },
      control_summary: {
        status: "fail",
        issue_count: 2,
        issues: [
          {
            code: "control_scenario_failed:active_executive_task_keeps_follow_up_ownership",
            file: path.join(process.cwd(), "src/control-kernel.mjs"),
          },
          {
            code: "control_integration_missing:lane_executor_owner_assertions",
            file: path.join(process.cwd(), "src/lane-executor.mjs"),
          },
        ],
      },
      routing_summary: {
        status: "pass",
        compare: {
          has_obvious_regression: false,
        },
      },
      write_summary: {
        status: "pass",
      },
      decision: {
        action: "inspect_control_kernel",
        line: "control",
      },
    },
    timestamp: "2026-03-22T00:00:03.000Z",
  });

  const drilldown = buildReleaseCheckDrilldown({
    selfCheckResult: {
      system_summary: {
        core_checks: "pass",
        company_brain_status: "pass",
      },
      control_summary: {
        status: "fail",
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
        },
      },
    },
    controlSnapshot: await resolveControlDiagnosticsSnapshot({
      reference: "latest",
      baseDir: controlArchiveDir,
    }),
  });

  assert.deepEqual(drilldown, {
    failing_area: "runtime",
    representative_fail_case: [
      "control_scenario_failed:active_executive_task_keeps_follow_up_ownership via src/control-kernel.mjs",
      "control_integration_missing:lane_executor_owner_assertions via src/lane-executor.mjs",
    ],
    drilldown_source: ["release-check triage", "control diagnostics/history"],
  });
});

test("release-check human output stays minimal with drilldown line", () => {
  assert.equal(
    renderReleaseCheckReport({
      overall_status: "fail",
      blocking_checks: ["system_regression", "routing_regression"],
      doc_boundary_regression: false,
      suggested_next_step: "unused",
      action_hint: "inspect blocking_checks and representative_fail_case",
    }),
    [
      "能否放心合併/發布：先不要",
      "若不能，先修哪一條線：system regression",
      "下一步：inspect blocking_checks and representative_fail_case",
      "write evidence：real_only_violation none | rollout_basis none",
      "write rollout：ready none | high_risk none",
    ].join("\n"),
  );
});

test("release-check human output flags doc-boundary routing regressions", () => {
  assert.equal(
    renderReleaseCheckReport({
      overall_status: "fail",
      blocking_checks: ["routing_regression"],
      doc_boundary_regression: true,
      suggested_next_step: "unused",
      action_hint: "run routing-eval doc-boundary pack and inspect message-intent-utils / lane-executor guard",
    }),
    [
      "能否放心合併/發布：先不要",
      "若不能，先修哪一條線：routing regression",
      "下一步：這是 doc-boundary 類問題，優先檢查 intent guard；run routing-eval doc-boundary pack and inspect message-intent-utils / lane-executor guard",
      "write evidence：real_only_violation none | rollout_basis none",
      "write rollout：ready none | high_risk none",
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
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });
  const parsed = JSON.parse(raw);

  assert.deepEqual(parsed, {
    overall_status: "pass",
    blocking_checks: [],
    doc_boundary_regression: false,
    write_governance: PASS_WRITE_GOVERNANCE,
    suggested_next_step: "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。",
    action_hint: null,
    failing_area: null,
    representative_fail_case: [],
    drilldown_source: [],
  });

  const manifest = readJson(path.join(archives.releaseCheckArchiveDir, "manifest.json"));
  const latestEntry = manifest.snapshots[0];
  const snapshot = readJson(path.join(
    archives.releaseCheckArchiveDir,
    "snapshots",
    `${manifest.latest_run_id}.json`,
  ));

  assert.equal(manifest.latest_run_id, latestEntry.run_id);
  assert.deepEqual(latestEntry, {
    run_id: manifest.latest_run_id,
    timestamp: latestEntry.timestamp,
    overall_status: "pass",
    blocking_checks: [],
    suggested_next_step: "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。",
  });
  assert.deepEqual(snapshot, {
    run_id: manifest.latest_run_id,
    timestamp: latestEntry.timestamp,
    overall_status: "pass",
    blocking_checks: [],
    doc_boundary_regression: false,
    write_governance: PASS_WRITE_GOVERNANCE,
    suggested_next_step: "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。",
    action_hint: null,
    failing_area: null,
    representative_fail_case: [],
    drilldown_source: [],
  });
});

test("release-check CLI default output stays limited to the minimal write-governance view", async () => {
  const archives = await seedReleaseCheckArchives();
  const output = execFileSync("node", ["scripts/release-check.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });

  assert.equal(output.trim(), [
    "能否放心合併/發布：可以",
    "若不能，先修哪一條線：無",
    "下一步：無",
    "write evidence：real_only_violation meeting_confirm_write=unknown | rollout_basis 0/1 ready",
    "write rollout：ready none | high_risk meeting_confirm_write",
  ].join("\n"));
});

test("release-check exit code maps pass/fail strictly", () => {
  assert.equal(getReleaseCheckExitCode({ overall_status: "pass" }), 0);
  assert.equal(getReleaseCheckExitCode({ overall_status: "fail" }), 1);
  assert.equal(getReleaseCheckExitCode({}), 1);
});

test("release-check CLI compare-previous prints only the minimal compare view", async () => {
  const archives = await seedReleaseCheckArchives();
  const firstRaw = execFileSync("node", ["scripts/release-check.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });
  const firstReport = JSON.parse(firstRaw);
  assert.deepEqual(firstReport, {
    overall_status: "pass",
    blocking_checks: [],
    doc_boundary_regression: false,
    write_governance: PASS_WRITE_GOVERNANCE,
    suggested_next_step: "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。",
    action_hint: null,
    failing_area: null,
    representative_fail_case: [],
    drilldown_source: [],
  });
  const manifestPath = path.join(archives.releaseCheckArchiveDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const firstSnapshotPath = path.join(
    archives.releaseCheckArchiveDir,
    "snapshots",
    `${manifest.latest_run_id}.json`,
  );
  const firstSnapshot = readJson(firstSnapshotPath);

  firstSnapshot.overall_status = "fail";
  firstSnapshot.blocking_checks = ["routing_regression"];
  firstSnapshot.suggested_next_step = "先看 routing regression 的 rule 模組：src/router.js 與 src/planner-*-flow.mjs。";
  writeJson(firstSnapshotPath, firstSnapshot);

  manifest.snapshots[0].overall_status = "fail";
  manifest.snapshots[0].blocking_checks = ["routing_regression"];
  manifest.snapshots[0].suggested_next_step = "先看 routing regression 的 rule 模組：src/router.js 與 src/planner-*-flow.mjs。";
  writeJson(manifestPath, manifest);

  const output = execFileSync("node", ["scripts/release-check.mjs", "--compare-previous"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });

  assert.deepEqual(firstReport, {
    overall_status: "pass",
    blocking_checks: [],
    doc_boundary_regression: false,
    write_governance: PASS_WRITE_GOVERNANCE,
    suggested_next_step: "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。",
    action_hint: null,
    failing_area: null,
    representative_fail_case: [],
    drilldown_source: [],
  });
  assert.equal(output.trim(), [
    "release 狀態：變好",
    "blocking_checks：有改變",
    "suggested_next_step：有改變",
  ].join("\n"));
});

test("release-check CLI json compare-snapshot only returns the compare summary", async () => {
  const archives = await seedReleaseCheckArchives();
  execFileSync("node", ["scripts/release-check.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });

  const manifestPath = path.join(archives.releaseCheckArchiveDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const firstRunId = manifest.latest_run_id;
  const firstSnapshotPath = path.join(archives.releaseCheckArchiveDir, "snapshots", `${firstRunId}.json`);
  const firstSnapshot = readJson(firstSnapshotPath);

  firstSnapshot.overall_status = "fail";
  firstSnapshot.blocking_checks = ["planner_contract_failure"];
  firstSnapshot.suggested_next_step = "先看 planner contract failure 的 registry 模組：src/executive-planner.mjs；只有 intentional stable target 才改 docs/system/planner_contract.json。";
  writeJson(firstSnapshotPath, firstSnapshot);

  manifest.snapshots[0].overall_status = "fail";
  manifest.snapshots[0].blocking_checks = ["planner_contract_failure"];
  manifest.snapshots[0].suggested_next_step = "先看 planner contract failure 的 registry 模組：src/executive-planner.mjs；只有 intentional stable target 才改 docs/system/planner_contract.json。";
  writeJson(manifestPath, manifest);

  const raw = execFileSync("node", [
    "scripts/release-check.mjs",
    "--json",
    "--compare-snapshot",
    firstRunId,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });
  const parsed = JSON.parse(raw);

  assert.deepEqual(parsed, {
    release_status: "better",
    blocking_checks_changed: true,
    suggested_next_step_changed: true,
  });
});

test("release-check CI entry emits minimal JSON and exits 0 on pass", async () => {
  const archives = await seedReleaseCheckArchives();
  const result = spawnSync("node", ["scripts/release-check-ci.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    overall_status: "pass",
    blocking_checks: [],
    doc_boundary_regression: false,
    write_governance: PASS_WRITE_GOVERNANCE,
    suggested_next_step: "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。",
    action_hint: null,
    failing_area: null,
    representative_fail_case: [],
    drilldown_source: [],
  });

  const manifest = readJson(path.join(archives.releaseCheckArchiveDir, "manifest.json"));
  assert.match(manifest.latest_run_id, /^release-check-/);
});

test("release-check CI compare-previous emits only the compare summary JSON", async () => {
  const archives = await seedReleaseCheckArchives();
  spawnSync("node", ["scripts/release-check-ci.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });

  const manifestPath = path.join(archives.releaseCheckArchiveDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const firstSnapshotPath = path.join(
    archives.releaseCheckArchiveDir,
    "snapshots",
    `${manifest.latest_run_id}.json`,
  );
  const firstSnapshot = readJson(firstSnapshotPath);

  firstSnapshot.overall_status = "fail";
  firstSnapshot.blocking_checks = ["system_regression"];
  firstSnapshot.suggested_next_step = "先看 system regression 的 agent registry / contract：src/agent-registry.mjs。";
  writeJson(firstSnapshotPath, firstSnapshot);

  manifest.snapshots[0].overall_status = "fail";
  manifest.snapshots[0].blocking_checks = ["system_regression"];
  manifest.snapshots[0].suggested_next_step = "先看 system regression 的 agent registry / contract：src/agent-registry.mjs。";
  writeJson(manifestPath, manifest);

  const result = spawnSync("node", ["scripts/release-check-ci.mjs", "--compare-previous"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_CHECK_ARCHIVE_DIR: archives.releaseCheckArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    release_status: "better",
    blocking_checks_changed: true,
    suggested_next_step_changed: true,
  });
});

test("release-check CI entry exits 1 on fail", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "release-check-ci-fail-"));
  const releaseCheckArchiveDir = path.join(baseDir, "release-check");
  const routingArchiveDir = path.join(baseDir, "routing");
  const plannerArchiveDir = path.join(baseDir, "planner");
  const selfCheckArchiveDir = path.join(baseDir, "self-check");
  await mkdir(releaseCheckArchiveDir, { recursive: true });
  await mkdir(routingArchiveDir, { recursive: true });
  await mkdir(plannerArchiveDir, { recursive: true });
  await mkdir(selfCheckArchiveDir, { recursive: true });

  const result = spawnSync("node", ["scripts/release-check-ci.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_CHECK_ARCHIVE_DIR: releaseCheckArchiveDir,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: selfCheckArchiveDir,
    },
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    overall_status: "fail",
    blocking_checks: ["routing_regression"],
    doc_boundary_regression: false,
    write_governance: PASS_WRITE_GOVERNANCE,
    suggested_next_step: "先看 routing regression：diagnostics 在 src/routing-eval-diagnostics.mjs；rule 看 src/router.js / src/planner-*-flow.mjs；fixture 看 evals/routing-eval-set.mjs。",
    action_hint: "run routing-eval and inspect mixed fixtures",
    failing_area: "mixed",
    representative_fail_case: ["routing latest snapshot unavailable or has no miss case"],
    drilldown_source: ["release-check triage", "routing-eval diagnostics/history"],
  });
});
