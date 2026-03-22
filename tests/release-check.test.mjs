import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";

import {
  buildReleaseCheckDrilldown,
  buildReleaseCheckReport,
  getReleaseCheckExitCode,
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
    failing_area: null,
    representative_fail_case: [],
    drilldown_source: [],
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
    suggested_next_step: "先看 routing regression 的 rule 模組：src/router.js 與 src/planner-*-flow.mjs。",
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
    suggested_next_step: "先看 system regression 的 agent registry / contract：src/agent-registry.mjs。",
    failing_area: "mixed",
    representative_fail_case: ["agent_missing:cmo"],
    drilldown_source: ["release-check triage"],
  });
});

test("release-check report points planner contract failure to planner registry first", () => {
  const report = buildReleaseCheckReport({
    selfCheckResult: {
      ok: false,
      system_summary: {
        core_checks: "pass",
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
    suggested_next_step: "先看 planner contract failure 的 registry 模組：src/executive-planner.mjs；只有 intentional stable target 才改 docs/system/planner_contract.json。",
    failing_area: "doc",
    representative_fail_case: ["undefined_actions:search_and_detail_doc via planner_tool_registry"],
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

test("release-check human output stays minimal with drilldown line", () => {
  assert.equal(
    renderReleaseCheckReport({
      overall_status: "fail",
      blocking_checks: ["system_regression", "routing_regression"],
      suggested_next_step: "unused",
      failing_area: "meeting",
    }),
    [
      "能否放心合併/發布：先不要",
      "若不能，先修哪一條線：system regression",
      "先看哪類 case：meeting",
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
    failing_area: null,
    representative_fail_case: [],
    drilldown_source: [],
  });
});

test("release-check CLI default output stays limited to three lines", async () => {
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
    "先看哪類 case：無",
  ].join("\n"));
});

test("release-check exit code maps pass/fail strictly", () => {
  assert.equal(getReleaseCheckExitCode({ overall_status: "pass" }), 0);
  assert.equal(getReleaseCheckExitCode({ overall_status: "fail" }), 1);
  assert.equal(getReleaseCheckExitCode({}), 1);
});

test("release-check CI entry emits minimal JSON and exits 0 on pass", async () => {
  const archives = await seedReleaseCheckArchives();
  const result = spawnSync("node", ["scripts/release-check-ci.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archives.routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: archives.plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: archives.selfCheckArchiveDir,
    },
  });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    overall_status: "pass",
    blocking_checks: [],
    suggested_next_step: "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。",
    failing_area: null,
    representative_fail_case: [],
    drilldown_source: [],
  });
});

test("release-check CI entry exits 1 on fail", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "release-check-ci-fail-"));
  const routingArchiveDir = path.join(baseDir, "routing");
  const plannerArchiveDir = path.join(baseDir, "planner");
  const selfCheckArchiveDir = path.join(baseDir, "self-check");
  await mkdir(routingArchiveDir, { recursive: true });
  await mkdir(plannerArchiveDir, { recursive: true });
  await mkdir(selfCheckArchiveDir, { recursive: true });

  const result = spawnSync("node", ["scripts/release-check-ci.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
      PLANNER_DIAGNOSTICS_ARCHIVE_DIR: plannerArchiveDir,
      SYSTEM_SELF_CHECK_ARCHIVE_DIR: selfCheckArchiveDir,
    },
  });

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    overall_status: "fail",
    blocking_checks: ["routing_regression"],
    suggested_next_step: "先看 routing regression：diagnostics 在 src/routing-eval-diagnostics.mjs；rule 看 src/router.js / src/planner-*-flow.mjs；fixture 看 evals/routing-eval-set.mjs。",
    failing_area: "mixed",
    representative_fail_case: ["routing latest snapshot unavailable or has no miss case"],
    drilldown_source: ["release-check triage", "routing-eval diagnostics/history"],
  });
});
