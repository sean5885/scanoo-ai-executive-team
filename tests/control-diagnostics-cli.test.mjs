import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const {
  buildDiagnosticsReportingSummary,
  buildVerificationFailureTaxonomy,
  buildWritePolicyRuntimeStatsFromRows,
  buildWriteRouteRolloutAdvice,
  runControlDiagnostics,
} = await import("../src/control-diagnostics.mjs");

test.after(() => {
  testDb.close();
});

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function seedRoutingDiagnosticsArchive(routingArchiveDir) {
  execFileSync("node", ["scripts/routing-eval.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
    },
  });
}

function runControlDiagnosticsCli(args, env) {
  const result = spawnSync("node", ["scripts/control-diagnostics.mjs", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("control diagnostics CLI renders the fixed single-view summary", async () => {
  const controlArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-summary-"));
  const routingArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-routing-summary-"));
  seedRoutingDiagnosticsArchive(routingArchiveDir);

  const { status, stdout: output } = runControlDiagnosticsCli([], {
    ...process.env,
    CONTROL_DIAGNOSTICS_ARCHIVE_DIR: controlArchiveDir,
    ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
  });

  assert.equal(status, 0);
  assert.match(output, /Control Diagnostics/);
  assert.match(output, /summary: overall=pass \| control=pass \| routing=pass \| write=pass/);
  assert.match(output, /control_summary: issues=0 \| decisions=3 \| owners=3 \| integrations=3/);
  assert.match(output, /routing_summary: status=pass \| accuracy=[0-9]+(?:\.[0-9]+)? \| compare=unavailable \| doc_boundary_regression=false/);
  assert.match(output, /write_summary: issues=0 \| guarded_operations=40 \| policy_actions=30 \| enforced_routes=33 \| modes=enforce:27,observe:2,warn:4/);
  assert.match(output, /reporting_summary: error_code_groups=0 \| failure_groups=0 \| top_regressions=0/);
  assert.match(output, /top_regressions: none/);
  assert.match(output, /write_route: \/api\/doc\/rewrite-from-comments \| action=document_comment_rewrite_apply \| mode=warn/);
  assert.match(output, /write_route: \/api\/meeting\/confirm \| action=meeting_confirm_write \| mode=warn .* violation_rate=unknown .* recommendation=hold_warn/);
  assert.match(output, /write_route: \/api\/doc\/update \| action=update_doc \| mode=warn .* violation_rate=unknown .* recommendation=keep_warn/);
  assert.match(output, /decision: observe_only \| line none/);
});

test("control diagnostics CLI archives the full JSON report into snapshot history", async () => {
  const controlArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-history-"));
  const routingArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-routing-history-"));
  seedRoutingDiagnosticsArchive(routingArchiveDir);

  const { status, stdout: raw } = runControlDiagnosticsCli(["--json"], {
    ...process.env,
    CONTROL_DIAGNOSTICS_ARCHIVE_DIR: controlArchiveDir,
    ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
  });
  const parsed = JSON.parse(raw);
  const manifest = readJson(path.join(controlArchiveDir, "manifest.json"));
  const latestEntry = manifest.snapshots[0];
  const snapshot = readJson(path.join(controlArchiveDir, "snapshots", `${manifest.latest_run_id}.json`));

  assert.equal(status, 0);
  assert.equal(manifest.latest_run_id, latestEntry.run_id);
  assert.deepEqual(latestEntry, {
    run_id: manifest.latest_run_id,
    timestamp: latestEntry.timestamp,
    overall_status: "pass",
    control_status: "pass",
    routing_status: "pass",
    write_status: "pass",
    control_issue_count: 0,
    routing_issue_count: 0,
    write_issue_count: 0,
  });
  assert.deepEqual(snapshot, parsed);
});

test("control diagnostics reporting groups error codes and failure families deterministically", () => {
  const reportingSummary = buildDiagnosticsReportingSummary({
    controlSummary: {
      status: "fail",
      issues: [
        {
          code: "control_scenario_failed:active_executive_task_keeps_follow_up_ownership",
          summary: "Control scenario failed: active executive task follow-up",
          file: path.join(process.cwd(), "src/control-kernel.mjs"),
        },
        {
          code: "control_integration_missing:lane_executor_owner_assertions",
          summary: "Control integration missing: owner assertions",
          file: path.join(process.cwd(), "src/lane-executor.mjs"),
        },
      ],
    },
    routingSummary: {
      status: "degrade",
      issue_count: 2,
      issues: [
        {
          code: "routing_compare_regression",
          summary: "Routing compare shows an obvious regression.",
          file: path.join(process.cwd(), ".tmp/routing-diagnostics-history/snapshots/routing-2.json"),
        },
        {
          code: "routing_decision_requires_review",
          summary: "Routing diagnostics require manual review.",
          file: path.join(process.cwd(), ".tmp/routing-diagnostics-history/snapshots/routing-2.json"),
        },
      ],
      latest_snapshot: {
        snapshot_path: path.join(process.cwd(), ".tmp/routing-diagnostics-history/snapshots/routing-2.json"),
      },
      diagnostics_summary: {
        top_miss_cases: [
          {
            id: "doc-023a",
            category: "doc",
            miss_dimensions: ["planner_action", "agent_or_tool"],
            actual: {
              planner_action: "ROUTING_NO_MATCH",
              agent_or_tool: "error:ROUTING_NO_MATCH",
              route_source: "planner_flow",
            },
          },
          {
            id: "doc-023b",
            category: "doc",
            miss_dimensions: ["lane"],
            actual: {
              planner_action: "ROUTING_NO_MATCH",
              route_source: "lane_executor",
            },
          },
        ],
      },
    },
    writeSummary: {
      status: "fail",
      issues: [
        {
          code: "write_scenario_failed:external_write_requires_confirmation",
          summary: "Write guard scenario failed: confirmation required",
          file: path.join(process.cwd(), "src/write-guard.mjs"),
        },
      ],
    },
  });

  assert.deepEqual(reportingSummary.error_code_classes.map((item) => ({
    class_key: item.class_key,
    count: item.count,
  })), [
    {
      class_key: "control_integration_missing",
      count: 1,
    },
    {
      class_key: "control_scenario_failed",
      count: 1,
    },
    {
      class_key: "write_scenario_failed",
      count: 1,
    },
    {
      class_key: "routing_top_miss:ROUTING_NO_MATCH",
      count: 2,
    },
    {
      class_key: "routing_compare_regression",
      count: 1,
    },
    {
      class_key: "routing_decision_requires_review",
      count: 1,
    },
  ]);
  assert.deepEqual(reportingSummary.failure_groups.map((item) => ({
    group_key: item.group_key,
    count: item.count,
  })), [
    {
      group_key: "control:deterministic_scenarios",
      count: 1,
    },
    {
      group_key: "control:integration_surface",
      count: 1,
    },
    {
      group_key: "write:deterministic_scenarios",
      count: 1,
    },
    {
      group_key: "routing:top_miss_cases",
      count: 2,
    },
    {
      group_key: "routing:compare_regression",
      count: 1,
    },
    {
      group_key: "routing:decision_review",
      count: 1,
    },
  ]);
});

test("control diagnostics reporting emits stable top regression cases without changing gate verdicts", async () => {
  const controlArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-reporting-"));
  const routingArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-routing-reporting-"));
  seedRoutingDiagnosticsArchive(routingArchiveDir);

  const report = await runControlDiagnostics({
    routingArchiveDir,
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.diagnostics_summary, {
    overall_status: "pass",
    control_status: "pass",
    routing_status: "pass",
    write_status: "pass",
    control_issue_count: 0,
    routing_issue_count: 0,
    write_issue_count: 0,
  });
  assert.equal(report.decision.action, "observe_only");
  assert.equal(report.decision.line, "none");
  assert.deepEqual(report.reporting_summary, {
    error_code_class_count: 0,
    failure_group_count: 0,
    top_regression_case_count: 0,
    error_code_classes: [],
    failure_groups: [],
    top_regression_cases: [],
  });
  assert.deepEqual(report.write_summary.policy_actions, [
    "bitable_app_create",
    "bitable_app_update",
    "bitable_record_create",
    "bitable_record_delete",
    "bitable_record_update",
    "bitable_records_bulk_upsert",
    "bitable_table_create",
    "calendar_create_event",
    "create_doc",
    "create_drive_folder",
    "create_wiki_node",
    "delete_drive_item",
    "document_comment_rewrite_apply",
    "drive_organize_apply",
    "meeting_confirm_write",
    "message_reaction_create",
    "message_reaction_delete",
    "message_reply",
    "move_drive_item",
    "move_wiki_node",
    "spreadsheet_create",
    "spreadsheet_replace",
    "spreadsheet_replace_batch",
    "spreadsheet_update",
    "task_comment_create",
    "task_comment_delete",
    "task_comment_update",
    "task_create",
    "update_doc",
    "wiki_organize_apply",
  ]);
  assert.equal(report.write_summary.policy_route_checks.length, 33);
  assert.equal(report.write_summary.policy_route_checks.every((item) => item.ok), true);
  assert.equal(report.write_summary.enforcement_route_checks.length, 33);
  assert.equal(report.write_summary.enforcement_route_checks.every((item) => item.ok), true);
  assert.deepEqual(report.write_summary.policy_coverage, {
    metadata_route_count: 33,
    enforced_route_count: 33,
    metadata_action_count: 30,
    enforced_action_count: 30,
    route_coverage_ratio: 1,
    action_coverage_ratio: 1,
  });
  assert.deepEqual(report.write_summary.enforcement_modes.mode_counts, {
    enforce: 27,
    observe: 2,
    warn: 4,
  });
  assert.deepEqual(report.write_summary.violation_type_stats, {
    missing_scope_key: 33,
    missing_idempotency_key: 2,
    confirm_required: 7,
    review_required: 6,
  });
  assert.equal(report.write_summary.rollout_advice.upgrade_ready_routes.some((route) => route.action === "document_comment_rewrite_apply"), false);
  assert.equal(report.write_summary.rollout_advice.high_risk_routes.some((route) => route.action === "meeting_confirm_write"), true);

  const degradedReporting = buildDiagnosticsReportingSummary({
    controlSummary: {
      status: "fail",
      issues: [
        {
          code: "control_scenario_failed:active_executive_task_keeps_follow_up_ownership",
          summary: "Control scenario failed: active executive task follow-up",
          file: path.join(process.cwd(), "src/control-kernel.mjs"),
        },
      ],
    },
    routingSummary: {
      status: "degrade",
      issue_count: 1,
      issues: [
        {
          code: "routing_compare_regression",
          summary: "Routing compare shows an obvious regression.",
          file: path.join(process.cwd(), ".tmp/routing-diagnostics-history/snapshots/routing-2.json"),
        },
      ],
      latest_snapshot: {
        snapshot_path: path.join(process.cwd(), ".tmp/routing-diagnostics-history/snapshots/routing-2.json"),
      },
      diagnostics_summary: {
        top_miss_cases: [
          {
            id: "doc-023a",
            category: "doc",
            miss_dimensions: ["planner_action", "agent_or_tool"],
            actual: {
              planner_action: "ROUTING_NO_MATCH",
              route_source: "planner_flow",
            },
          },
          {
            id: "doc-023b",
            category: "doc",
            miss_dimensions: ["lane"],
            actual: {
              planner_action: "ROUTING_NO_MATCH",
              route_source: "lane_executor",
            },
          },
        ],
      },
    },
    writeSummary: {
      status: "fail",
      issues: [
        {
          code: "write_integration_missing:http_server_guarded_operations",
          summary: "Write guard integration missing: guarded operations",
          file: path.join(process.cwd(), "src/http-server.mjs"),
        },
      ],
    },
  });

  assert.deepEqual(degradedReporting.top_regression_cases.map((item) => ({
    rank: item.rank,
    line: item.line,
    case_id: item.case_id,
    failure_group: item.failure_group,
  })), [
    {
      rank: 1,
      line: "control",
      case_id: "control_scenario_failed:active_executive_task_keeps_follow_up_ownership",
      failure_group: "control:deterministic_scenarios",
    },
    {
      rank: 2,
      line: "write",
      case_id: "write_integration_missing:http_server_guarded_operations",
      failure_group: "write:integration_surface",
    },
    {
      rank: 3,
      line: "routing",
      case_id: "routing_compare_regression",
      failure_group: "routing:compare_regression",
    },
    {
      rank: 4,
      line: "routing",
      case_id: "doc-023a",
      failure_group: "routing:top_miss_cases",
    },
    {
      rank: 5,
      line: "routing",
      case_id: "doc-023b",
      failure_group: "routing:top_miss_cases",
    },
  ]);
});

test("verification failure taxonomy is deterministic and fail-closed on regression cases", () => {
  const reportingSummary = buildDiagnosticsReportingSummary({
    controlSummary: {
      status: "fail",
      issues: [
        {
          code: "control_scenario_failed:active_executive_task_keeps_follow_up_ownership",
          summary: "Control scenario failed: active executive task follow-up",
          file: path.join(process.cwd(), "src/control-kernel.mjs"),
        },
      ],
    },
    routingSummary: {
      status: "degrade",
      diagnostics_summary: {
        top_miss_cases: [
          {
            id: "doc-023a",
            category: "doc",
            miss_dimensions: ["planner_action"],
            actual: {
              planner_action: "ROUTING_NO_MATCH",
              route_source: "planner_flow",
            },
          },
        ],
      },
      latest_snapshot: {
        snapshot_path: path.join(process.cwd(), ".tmp/routing-diagnostics-history/snapshots/routing-2.json"),
      },
      issue_count: 1,
      issues: [
        {
          code: "routing_compare_regression",
          summary: "Routing compare shows an obvious regression.",
          file: path.join(process.cwd(), ".tmp/routing-diagnostics-history/snapshots/routing-2.json"),
        },
      ],
    },
    writeSummary: {
      status: "pass",
      issues: [],
    },
  });

  const taxonomy = buildVerificationFailureTaxonomy({ reportingSummary });
  assert.equal(taxonomy.status, "fail");
  assert.equal(taxonomy.error_code_class_count > 0, true);
  assert.equal(taxonomy.failure_group_count > 0, true);
  assert.equal(taxonomy.top_regression_case_count > 0, true);
  assert.equal(taxonomy.top_regression_cases.some((item) => item.case_id === "doc-023a"), true);
});

test("write policy runtime stats split real/test traffic and rollout gating uses real request-backed evidence only", () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, index) => ({
      payload_json: JSON.stringify({
        action: "meeting_confirm_write",
        traffic_source: "real",
        request_backed: true,
        allow: true,
        policy_enforcement: {
          violation_count: 0,
          should_block: false,
          violation_types: [],
          violation_reasons: [],
          signals: {
            scope_key_present: true,
            idempotency_key_present: false,
            confirmation_present: true,
            review_completed: true,
            review_required_active: false,
          },
        },
      }),
      created_at: `2026-03-24T00:00:${String(index).padStart(2, "0")}.000Z`,
      pathname: "/api/meeting/confirm",
      request_input_payload_json: JSON.stringify({
        request_input: {
          traffic_source: "real",
          request_backed: true,
        },
      }),
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      payload_json: JSON.stringify({
        action: "meeting_confirm_write",
        traffic_source: "test",
        request_backed: true,
        allow: false,
        policy_enforcement: {
          violation_count: 1,
          should_block: false,
          violation_types: ["confirm_required"],
          violation_reasons: ["missing_confirmation"],
          signals: {
            scope_key_present: true,
            idempotency_key_present: false,
            confirmation_present: false,
            review_completed: true,
            review_required_active: false,
          },
        },
      }),
      created_at: `2026-03-24T00:01:${String(index).padStart(2, "0")}.000Z`,
      pathname: "/api/meeting/confirm",
      request_input_payload_json: JSON.stringify({
        request_input: {
          traffic_source: "test",
          request_backed: true,
        },
      }),
    })),
  ];

  const runtimeStats = buildWritePolicyRuntimeStatsFromRows(rows);
  const routeRuntime = runtimeStats.by_path["/api/meeting/confirm"];

  assert.equal(routeRuntime.request_backed_breakdown.by_source.real.sample_count, 20);
  assert.equal(routeRuntime.request_backed_breakdown.by_source.real.violation_rate, 0);
  assert.equal(routeRuntime.request_backed_breakdown.by_source.test.sample_count, 4);
  assert.equal(routeRuntime.request_backed_breakdown.by_source.test.violation_rate, 1);

  const rollout = buildWriteRouteRolloutAdvice({
    pathname: "/api/meeting/confirm",
    action: "meeting_confirm_write",
    mode: "warn",
    checks: {
      scope_key: true,
      idempotency_key: false,
      confirm_required: true,
      review_required: true,
    },
    runtime: {
      real_traffic_sample_count: routeRuntime.request_backed_breakdown.by_source.real.sample_count,
      real_traffic_violation_rate: routeRuntime.request_backed_breakdown.by_source.real.violation_rate,
      test_traffic_sample_count: routeRuntime.request_backed_breakdown.by_source.test.sample_count,
      test_traffic_violation_rate: routeRuntime.request_backed_breakdown.by_source.test.violation_rate,
      replay_traffic_sample_count: 0,
      replay_traffic_violation_rate: null,
    },
  });

  assert.equal(rollout.recommendation, "upgrade_to_enforce");
  assert.equal(rollout.upgrade_ready, true);
  assert.equal(rollout.risk_hint, null);
  assert.equal(rollout.rollout_basis.eligible, true);
  assert.equal(rollout.rollout_basis.risk_hint, null);
  assert.equal(rollout.rollout_basis.real_traffic_sample_count, 20);
  assert.equal(rollout.rollout_basis.real_traffic_violation_rate, 0);
});

test("write rollout gate keeps meeting_confirm_write on warn when real request-backed samples are below minimum and emits risk hint", () => {
  const rollout = buildWriteRouteRolloutAdvice({
    pathname: "/api/meeting/confirm",
    action: "meeting_confirm_write",
    mode: "warn",
    checks: {
      scope_key: true,
      idempotency_key: false,
      confirm_required: true,
      review_required: true,
    },
    runtime: {
      real_traffic_sample_count: 19,
      real_traffic_violation_rate: 0,
      test_traffic_sample_count: 50,
      test_traffic_violation_rate: 0,
      replay_traffic_sample_count: 0,
      replay_traffic_violation_rate: null,
    },
  });

  assert.equal(rollout.recommendation, "hold_warn");
  assert.equal(rollout.upgrade_ready, false);
  assert.equal(rollout.high_risk, true);
  assert.equal(rollout.risk_hint, "insufficient_real_request_backed_samples:19/20");
  assert.equal(rollout.rollout_basis.eligible, false);
  assert.equal(rollout.rollout_basis.risk_hint, "insufficient_real_request_backed_samples:19/20");
});

test("control diagnostics CLI renders compare-previous with directional markers", async () => {
  const controlArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-compare-previous-"));
  const routingArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-routing-compare-previous-"));
  seedRoutingDiagnosticsArchive(routingArchiveDir);

  const initial = runControlDiagnosticsCli(["--json"], {
    ...process.env,
    CONTROL_DIAGNOSTICS_ARCHIVE_DIR: controlArchiveDir,
    ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
  });
  assert.equal(initial.status, 0);

  const manifestPath = path.join(controlArchiveDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const firstRunId = manifest.latest_run_id;
  const firstSnapshotPath = path.join(controlArchiveDir, "snapshots", `${firstRunId}.json`);
  const firstSnapshot = readJson(firstSnapshotPath);

  firstSnapshot.ok = false;
  firstSnapshot.diagnostics_summary.overall_status = "fail";
  firstSnapshot.diagnostics_summary.control_status = "fail";
  firstSnapshot.diagnostics_summary.write_status = "fail";
  firstSnapshot.diagnostics_summary.control_issue_count = 2;
  firstSnapshot.diagnostics_summary.write_issue_count = 1;
  writeJson(firstSnapshotPath, firstSnapshot);

  manifest.snapshots[0].overall_status = "fail";
  manifest.snapshots[0].control_status = "fail";
  manifest.snapshots[0].write_status = "fail";
  manifest.snapshots[0].control_issue_count = 2;
  manifest.snapshots[0].write_issue_count = 1;
  writeJson(manifestPath, manifest);

  const { status, stdout: output } = runControlDiagnosticsCli(["--compare-previous"], {
    ...process.env,
    CONTROL_DIAGNOSTICS_ARCHIVE_DIR: controlArchiveDir,
    ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
  });

  assert.equal(status, 0);
  assert.match(output, /Control Diagnostics Compare/);
  assert.match(output, /Current: snapshot:control-diagnostics-/);
  assert.match(output, new RegExp(`Compare: snapshot:${firstRunId}`));
  assert.match(output, /↓ overall_status: fail -> pass/);
  assert.match(output, /↓ control_status: fail -> pass/);
  assert.match(output, /= routing_status: pass/);
  assert.match(output, /↓ write_status: fail -> pass/);
  assert.match(output, /↓ control_issue_count: 2 -> 0 \(-2\)/);
  assert.match(output, /= routing_issue_count: 0/);
  assert.match(output, /↓ write_issue_count: 1 -> 0 \(-1\)/);
  assert.match(output, /Manifest:/);
});

test("control diagnostics CLI json compare_summary only includes changed fields", async () => {
  const controlArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-compare-json-"));
  const routingArchiveDir = await mkdtemp(path.join(os.tmpdir(), "control-diagnostics-routing-compare-json-"));
  seedRoutingDiagnosticsArchive(routingArchiveDir);

  const initial = runControlDiagnosticsCli(["--json"], {
    ...process.env,
    CONTROL_DIAGNOSTICS_ARCHIVE_DIR: controlArchiveDir,
    ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
  });
  assert.equal(initial.status, 0);

  const manifestPath = path.join(controlArchiveDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const firstRunId = manifest.latest_run_id;
  const firstSnapshotPath = path.join(controlArchiveDir, "snapshots", `${firstRunId}.json`);
  const firstSnapshot = readJson(firstSnapshotPath);

  firstSnapshot.ok = false;
  firstSnapshot.diagnostics_summary.overall_status = "degrade";
  firstSnapshot.diagnostics_summary.routing_status = "degrade";
  firstSnapshot.diagnostics_summary.routing_issue_count = 2;
  writeJson(firstSnapshotPath, firstSnapshot);

  manifest.snapshots[0].overall_status = "degrade";
  manifest.snapshots[0].routing_status = "degrade";
  manifest.snapshots[0].routing_issue_count = 2;
  writeJson(manifestPath, manifest);

  const { status, stdout: raw } = runControlDiagnosticsCli(["--json", "--compare-snapshot", firstRunId], {
    ...process.env,
    CONTROL_DIAGNOSTICS_ARCHIVE_DIR: controlArchiveDir,
    ROUTING_DIAGNOSTICS_ARCHIVE_DIR: routingArchiveDir,
  });
  const parsed = JSON.parse(raw);
  const updatedManifest = readJson(manifestPath);
  const latestSnapshot = readJson(path.join(controlArchiveDir, "snapshots", `${updatedManifest.latest_run_id}.json`));

  assert.equal(status, 0);
  assert.deepEqual(parsed.compare_summary, {
    overall_status: {
      previous: "degrade",
      current: "pass",
      status: "better",
    },
    routing_status: {
      previous: "degrade",
      current: "pass",
      status: "better",
    },
    routing_issue_count: {
      previous: 2,
      current: 0,
      delta: -2,
      status: "better",
    },
  });
  assert.deepEqual(latestSnapshot.compare_summary, parsed.compare_summary);
});
