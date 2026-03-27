import { listRegisteredAgents, knowledgeAgentSubcommands } from "./agent-registry.mjs";
import { buildControlSummary, buildWriteSummary } from "./control-diagnostics.mjs";
import { runCompanyBrainLifecycleSelfCheck } from "./company-brain-lifecycle-contract.mjs";
import { getAllowedMethodsForPath, getRouteContract } from "./http-route-contracts.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import {
  buildPlannerDiagnosticsCompareSummary,
  runPlannerContractConsistencyCheck,
} from "./planner-contract-consistency.mjs";
import {
  buildRoutingDiagnosticsSummary,
  detectDocBoundaryRoutingRegression,
} from "./routing-eval-diagnostics.mjs";
import {
  resolvePlannerDiagnosticsSnapshot,
} from "./planner-diagnostics-history.mjs";
import {
  resolvePreviousRoutingDiagnosticsSnapshot,
  resolveRoutingDiagnosticsSnapshot,
} from "./routing-diagnostics-history.mjs";
import {
  archiveSystemSelfCheckSnapshot,
} from "./system-self-check-history.mjs";

const REQUIRED_AGENT_IDS = [
  "generalist",
  "ceo",
  "product",
  "prd",
  "cmo",
  "consult",
  "cdo",
  "knowledge-audit",
  "knowledge-consistency",
  "knowledge-conflicts",
  "knowledge-distill",
  "knowledge-brain",
  "knowledge-proposals",
  "knowledge-approve",
  "knowledge-reject",
  "knowledge-ownership",
  "knowledge-learn",
];

const REQUIRED_HTTP_PATHS = [
  "/api/messages/reply",
  "/api/doc/create",
  "/api/doc/update",
  "/api/meeting/process",
  "/api/meeting/confirm",
  "/api/drive/organize/preview",
  "/api/drive/organize/apply",
  "/api/wiki/organize/preview",
  "/api/wiki/organize/apply",
  "/api/bitable/apps/test-app/tables/test-table/records",
  "/api/bitable/apps/test-app/tables/test-table/records/create",
  "/api/bitable/apps/test-app/tables/test-table/records/test-record",
  "/api/bitable/apps/test-app/tables/test-table/records/search",
  "/api/calendar/events/create",
  "/api/calendar/freebusy",
  "/api/tasks/create",
  "/api/tasks/test-task",
  "/api/tasks/test-task/comments",
  "/api/tasks/test-task/comments/test-comment",
  "/agent/improvements",
  "/agent/improvements/test-proposal/approve",
  "/agent/improvements/test-proposal/reject",
  "/agent/improvements/test-proposal/apply",
  "/agent/company-brain/docs",
  "/agent/company-brain/search",
  "/agent/company-brain/approved/docs",
  "/agent/company-brain/approved/search",
  "/agent/company-brain/review",
  "/agent/company-brain/conflicts",
  "/agent/company-brain/approval-transition",
  "/agent/company-brain/learning/ingest",
  "/agent/company-brain/learning/state",
  "/agent/company-brain/approved/docs/test-doc",
  "/agent/company-brain/docs/test-doc/apply",
  "/agent/tasks",
];

const REQUIRED_SERVICE_MODULES = [
  "./agent-dispatcher.mjs",
  "./meeting-agent.mjs",
  "./image-understanding-service.mjs",
  "./lane-executor.mjs",
  "./executive-orchestrator.mjs",
];

const ROUTING_EVAL_MIN_ACCURACY_RATIO = 0.9;
const SYSTEM_STATUS_ORDER = {
  fail: 0,
  degrade: 1,
  pass: 2,
};
const PLANNER_STATUS_ORDER = {
  fail: 0,
  pass: 1,
};

function validateAgentContract(agent) {
  const contract = agent?.contract || {};
  const issues = [];
  if (!agent?.id) {
    issues.push("missing_agent_id");
  }
  if (!contract.trigger) {
    issues.push("missing_trigger");
  }
  if (!contract.expected_input_schema || typeof contract.expected_input_schema !== "object") {
    issues.push("missing_expected_input_schema");
  }
  if (!contract.expected_output_schema || typeof contract.expected_output_schema !== "object") {
    issues.push("missing_expected_output_schema");
  }
  if (!Array.isArray(contract.allowed_tools) || !contract.allowed_tools.length) {
    issues.push("missing_allowed_tools");
  }
  if (!contract.downstream_consumer) {
    issues.push("missing_downstream_consumer");
  }
  if (!contract.fallback_behavior) {
    issues.push("missing_fallback_behavior");
  }
  if (!contract.status) {
    issues.push("missing_status");
  }
  return issues;
}

function hasBlockingBaseFailures({
  missingAgents = [],
  invalidContracts = [],
  missingKnowledgeSubcommands = [],
  missingRoutes = [],
  serviceInitialization = [],
} = {}) {
  return (
    missingAgents.length > 0
    || invalidContracts.length > 0
    || missingKnowledgeSubcommands.length > 0
    || missingRoutes.length > 0
    || serviceInitialization.some((item) => item?.ok !== true)
  );
}

function hasRoutingErrorRegression(delta = {}) {
  return Object.values(delta || {}).some((metric) => (
    Number(metric?.actual?.delta || 0) > 0
    || Number(metric?.misses?.delta || 0) > 0
  ));
}

function hasRoutingBucketRegression(delta = {}) {
  return Object.values(delta || {}).some((metric) => metric?.status === "worse");
}

function buildRoutingStatus({
  accuracyRatio = 0,
  threshold = ROUTING_EVAL_MIN_ACCURACY_RATIO,
  decisionSeverity = "info",
  hasObviousRegression = false,
  snapshotAvailable = false,
} = {}) {
  if (!snapshotAvailable) {
    return "fail";
  }
  if (Number(accuracyRatio) < Number(threshold) || decisionSeverity === "high") {
    return "fail";
  }
  if (hasObviousRegression || decisionSeverity === "warning") {
    return "degrade";
  }
  return "pass";
}

async function buildRoutingSummary({ routingArchiveDir } = {}) {
  let latestSnapshot = null;
  let compareSnapshot = null;

  try {
    latestSnapshot = await resolveRoutingDiagnosticsSnapshot({
      reference: "latest",
      ...(routingArchiveDir ? { baseDir: routingArchiveDir } : {}),
    });
  } catch (error) {
    return {
      status: "fail",
      summary: "routing latest snapshot unavailable",
      guidance: "先跑 npm run routing:closed-loop 或 node scripts/routing-eval.mjs --json 產生最新 routing snapshot。",
      doc_boundary_regression: false,
      latest_snapshot: null,
      compare: {
        available: false,
        target: null,
        has_obvious_regression: false,
        summary: "routing compare unavailable",
      },
      diagnostics_summary: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    compareSnapshot = await resolvePreviousRoutingDiagnosticsSnapshot({
      reference: latestSnapshot?.snapshot?.run_id || "latest",
      ...(routingArchiveDir ? { baseDir: routingArchiveDir } : {}),
    });
  } catch {
    compareSnapshot = null;
  }

  const diagnosticsSummary = compareSnapshot
    ? buildRoutingDiagnosticsSummary({
        run: latestSnapshot.run,
        previousRun: compareSnapshot.run,
        currentLabel: `snapshot:${latestSnapshot.snapshot?.run_id || "latest"}`,
        previousLabel: `snapshot:${compareSnapshot.snapshot?.run_id || "previous"}`,
      })
    : latestSnapshot?.snapshot?.diagnostics_summary || buildRoutingDiagnosticsSummary({
        run: latestSnapshot.run,
        previousRun: null,
        currentLabel: `snapshot:${latestSnapshot.snapshot?.run_id || "latest"}`,
      });
  const trendDelta = diagnosticsSummary?.trend_report?.delta || null;
  const decision = diagnosticsSummary?.decision_advice?.minimal_decision || {};
  const threshold = Number(latestSnapshot?.run?.threshold?.min_accuracy_ratio || ROUTING_EVAL_MIN_ACCURACY_RATIO);
  const docBoundaryRegression = detectDocBoundaryRoutingRegression({
    run: latestSnapshot?.run,
  });
  const hasObviousRegression = Boolean(
    compareSnapshot
    && (
      Number(trendDelta?.accuracy_ratio?.delta || 0) < 0
      || Number(trendDelta?.miss_count?.delta || 0) > 0
      || hasRoutingBucketRegression(trendDelta?.by_lane_accuracy)
      || hasRoutingBucketRegression(trendDelta?.by_action_accuracy)
      || hasRoutingErrorRegression(trendDelta?.error_breakdown)
    )
  );
  const status = buildRoutingStatus({
    accuracyRatio: diagnosticsSummary?.accuracy_ratio || 0,
    threshold,
    decisionSeverity: decision?.severity || "info",
    hasObviousRegression,
    snapshotAvailable: true,
  });

  const summary = status === "pass"
    ? "routing snapshot stable"
    : status === "degrade"
      ? "routing snapshot passes, but compare shows drift"
      : "routing snapshot is not safe";
  const guidance = status === "pass"
    ? "routing 線目前穩定；若接下來改 routing，再看 npm run routing:diagnostics。"
    : status === "degrade"
      ? docBoundaryRegression
        ? "這是 doc-boundary 類問題，優先檢查 intent guard；先看 src/message-intent-utils.mjs、src/lane-executor.mjs，再用 routing-eval doc-boundary pack 驗證。"
        : "先看 routing latest snapshot 與 compare；若只是 coverage 問題先 review fixture，不要改 fallback。"
      : docBoundaryRegression
        ? "這是 doc-boundary 類問題，優先檢查 intent guard；先看 src/message-intent-utils.mjs、src/lane-executor.mjs，再用 routing-eval doc-boundary pack 驗證。"
        : "先看 routing latest snapshot 與 compare；確認 regression 來源後再動 routing，先不要碰 fallback。";

  return {
    status,
    summary,
    guidance,
    doc_boundary_regression: docBoundaryRegression,
    latest_snapshot: {
      run_id: latestSnapshot?.snapshot?.run_id || null,
      timestamp: latestSnapshot?.snapshot?.timestamp || null,
      accuracy_ratio: Number(diagnosticsSummary?.accuracy_ratio || 0),
      threshold,
    },
    compare: {
      available: Boolean(compareSnapshot),
      target: compareSnapshot
        ? {
            run_id: compareSnapshot?.snapshot?.run_id || null,
            timestamp: compareSnapshot?.snapshot?.timestamp || null,
          }
        : null,
      has_obvious_regression: hasObviousRegression,
      summary: compareSnapshot
        ? (hasObviousRegression ? "obvious regression detected from compare" : "no obvious regression from compare")
        : "routing compare unavailable",
    },
    diagnostics_summary: diagnosticsSummary,
  };
}

async function buildPlannerSummary({
  plannerArchiveDir,
  plannerContractCheck = runPlannerContractConsistencyCheck,
} = {}) {
  const report = plannerContractCheck();
  let latestSnapshot = null;

  try {
    latestSnapshot = await resolvePlannerDiagnosticsSnapshot({
      reference: "latest",
      ...(plannerArchiveDir ? { baseDir: plannerArchiveDir } : {}),
    });
  } catch {
    latestSnapshot = null;
  }

  const diagnosticsSummary = report?.diagnostics_summary || {};
  const compareSummary = latestSnapshot
    ? buildPlannerDiagnosticsCompareSummary({
        currentSummary: diagnosticsSummary,
        previousSummary: latestSnapshot?.report?.diagnostics_summary || {},
      })
    : {};
  const hasObviousRegression = Object.values(compareSummary).some((item) => item?.status === "worse");
  const gate = diagnosticsSummary?.gate === "pass" ? "pass" : "fail";
  const latestSnapshotRunId = latestSnapshot?.snapshot?.run_id || latestSnapshot?.ref || null;
  const summary = gate === "pass"
    ? "planner gate passes"
    : "planner gate fails";
  const failingCategories = Array.isArray(report?.gate?.failing_categories)
    ? report.gate.failing_categories.map((category) => cleanText(category)).filter(Boolean)
    : [];
  const guidance = gate === "fail"
    ? (
      failingCategories.length === 1 && failingCategories[0] === "action_governance_mismatches"
        ? "先看 planner gate 的 action_governance_mismatches；create_doc 入口需要對齊 source、owner、intent、type 與既有 create gate。"
        : "先看 planner gate；依序看 undefined_actions、undefined_presets、selector_contract_mismatches、action_governance_mismatches。"
    )
    : hasObviousRegression
      ? "planner gate 雖然 pass，但 compare 變差；先看 planner diagnostics compare。"
      : "planner 線目前穩定；若接下來改 planner，再跑 npm run planner:diagnostics。";

  return {
    gate,
    summary,
    guidance,
    latest_snapshot: latestSnapshot
      ? {
          run_id: latestSnapshotRunId,
          timestamp: latestSnapshot?.snapshot?.timestamp || null,
        }
      : null,
    compare: {
      available: Boolean(latestSnapshot),
      target: latestSnapshot
        ? {
            run_id: latestSnapshotRunId,
            timestamp: latestSnapshot?.snapshot?.timestamp || null,
          }
        : null,
      has_obvious_regression: hasObviousRegression,
      summary: latestSnapshot
        ? (hasObviousRegression ? "obvious regression detected from compare" : "no obvious regression from compare")
        : "planner compare unavailable",
      compare_summary: compareSummary,
    },
    diagnostics_summary: diagnosticsSummary,
    decision: report?.decision || null,
    report,
  };
}

function buildSystemSummary({
  baseOk = false,
  companyBrainSummary = {},
  controlSummary = {},
  writeSummary = {},
  routingSummary = {},
  plannerSummary = {},
} = {}) {
  const companyBrainStatus = cleanText(companyBrainSummary?.status) === "pass" ? "pass" : "fail";
  const controlStatus = cleanText(controlSummary?.status) === "pass" ? "pass" : "fail";
  const routingStatus = routingSummary?.status || "fail";
  const plannerGate = plannerSummary?.gate || "fail";
  const hasObviousRegression = Boolean(
    routingSummary?.compare?.has_obvious_regression
    || plannerSummary?.compare?.has_obvious_regression
  );
  const status = !baseOk
    || companyBrainStatus === "fail"
    || controlStatus === "fail"
    || cleanText(writeSummary?.status) !== "pass"
    || routingStatus === "fail"
    || plannerGate === "fail"
    ? "fail"
    : routingStatus === "degrade" || hasObviousRegression
      ? "degrade"
      : "pass";
  const safeToChange = baseOk
    && companyBrainStatus === "pass"
    && controlStatus === "pass"
    && cleanText(writeSummary?.status) === "pass"
    && routingStatus === "pass"
    && plannerGate === "pass"
    && hasObviousRegression === false;
  const reviewPriority = !baseOk
    ? "base"
    : companyBrainStatus !== "pass"
      ? "company_brain"
    : controlStatus !== "pass"
      ? "control"
    : cleanText(writeSummary?.status) !== "pass"
      ? "write_policy"
    : routingStatus !== "pass" || routingSummary?.compare?.has_obvious_regression
      ? "routing"
      : plannerGate !== "pass" || plannerSummary?.compare?.has_obvious_regression
        ? "planner"
        : "none";
  const guidance = reviewPriority === "base"
    ? "先修 self-check 基礎項目，再看 control / routing / planner。"
    : reviewPriority === "company_brain"
      ? "先看 company-brain lifecycle contract：確認 review / conflict / approval / apply 與 route contract、自檢案例一致；不要改 runtime write path。"
    : reviewPriority === "control"
      ? "先看 control：優先檢查 src/control-kernel.mjs 與 src/lane-executor.mjs，先修 ownership / same-scope drift，再動 downstream workflow。"
    : reviewPriority === "write_policy"
      ? "先看 write governance：external write 必須統一走 canonical request -> runtime；先修 src/http-server.mjs、src/meeting-agent.mjs、src/lane-executor.mjs、src/lark-mutation-runtime.mjs 與對應 route contract/diagnostics。"
    : reviewPriority === "routing"
      ? routingSummary?.doc_boundary_regression === true
        ? "這是 doc-boundary 類問題，優先檢查 intent guard；先看 src/message-intent-utils.mjs、src/lane-executor.mjs，再用 routing-eval doc-boundary pack 驗證。"
        : "先看 routing：latest snapshot 與 compare 決定是不是 regression；routing 穩定後再看 planner。"
      : reviewPriority === "planner"
        ? "先看 planner：gate fail 先修 implementation / contract drift；routing 只在 planner pass 後再看。"
        : "可以開始改；改 control 後回看 control:diagnostics，改 routing 後回看 routing:diagnostics，改 planner 後回看 planner:diagnostics 與 self-check。";

  return {
    status,
    safe_to_change: safeToChange,
    answer: safeToChange ? "可以" : "先不要",
    core_checks: baseOk ? "pass" : "fail",
    company_brain_status: companyBrainStatus,
    control_status: controlStatus,
    write_policy_status: cleanText(writeSummary?.status) || "fail",
    routing_status: routingStatus,
    planner_gate: plannerGate,
    has_obvious_regression: hasObviousRegression,
    review_priority: reviewPriority,
    guidance,
  };
}

function normalizeRoutingStatus(status = "") {
  const normalized = cleanText(status);
  if (normalized === "pass" || normalized === "degrade") {
    return normalized;
  }
  return "fail";
}

function normalizePlannerStatus(status = "") {
  return cleanText(status) === "pass" ? "pass" : "fail";
}

export function normalizeSystemSelfCheckStatus(report = {}) {
  const existingStatus = cleanText(report?.system_summary?.status);
  if (existingStatus === "pass" || existingStatus === "degrade" || existingStatus === "fail") {
    return existingStatus;
  }

  const baseOk = cleanText(report?.system_summary?.core_checks) === "pass";
  const companyBrainStatus = normalizePlannerStatus(
    report?.system_summary?.company_brain_status || report?.company_brain_summary?.status,
  );
  const controlStatus = normalizePlannerStatus(report?.system_summary?.control_status || report?.control_summary?.status);
  const routingStatus = normalizeRoutingStatus(report?.system_summary?.routing_status || report?.routing_summary?.status);
  const plannerStatus = normalizePlannerStatus(report?.system_summary?.planner_gate || report?.planner_summary?.gate);
  const hasObviousRegression = Boolean(report?.system_summary?.has_obvious_regression);

  if (!baseOk || companyBrainStatus === "fail" || controlStatus === "fail" || routingStatus === "fail" || plannerStatus === "fail") {
    return "fail";
  }
  if (cleanText(report?.system_summary?.write_policy_status || report?.write_summary?.status) !== "pass") {
    return "fail";
  }
  if (routingStatus === "degrade" || hasObviousRegression) {
    return "degrade";
  }
  return "pass";
}

function compareStatusDirection(currentStatus = "", previousStatus = "") {
  const currentRank = Number(SYSTEM_STATUS_ORDER[currentStatus] ?? SYSTEM_STATUS_ORDER.fail);
  const previousRank = Number(SYSTEM_STATUS_ORDER[previousStatus] ?? SYSTEM_STATUS_ORDER.fail);

  if (currentRank > previousRank) {
    return "better";
  }
  if (currentRank < previousRank) {
    return "worse";
  }
  return "unchanged";
}

function uniqLabels(values = []) {
  return Array.from(new Set(values.map((value) => cleanText(value)).filter(Boolean)));
}

export function buildSystemSelfCheckCompareSummary({
  currentReport = {},
  previousReport = {},
} = {}) {
  const currentSystemStatus = normalizeSystemSelfCheckStatus(currentReport);
  const previousSystemStatus = normalizeSystemSelfCheckStatus(previousReport);
  const currentRoutingStatus = normalizeRoutingStatus(
    currentReport?.routing_summary?.status || currentReport?.system_summary?.routing_status,
  );
  const previousRoutingStatus = normalizeRoutingStatus(
    previousReport?.routing_summary?.status || previousReport?.system_summary?.routing_status,
  );
  const currentControlStatus = normalizePlannerStatus(
    currentReport?.control_summary?.status || currentReport?.system_summary?.control_status,
  );
  const previousControlStatus = normalizePlannerStatus(
    previousReport?.control_summary?.status || previousReport?.system_summary?.control_status,
  );
  const currentPlannerStatus = normalizePlannerStatus(
    currentReport?.planner_summary?.gate || currentReport?.system_summary?.planner_gate,
  );
  const previousPlannerStatus = normalizePlannerStatus(
    previousReport?.planner_summary?.gate || previousReport?.system_summary?.planner_gate,
  );

  return {
    system_status: compareStatusDirection(currentSystemStatus, previousSystemStatus),
    control_regression: Number(PLANNER_STATUS_ORDER[currentControlStatus] ?? PLANNER_STATUS_ORDER.fail)
      < Number(PLANNER_STATUS_ORDER[previousControlStatus] ?? PLANNER_STATUS_ORDER.fail),
    routing_regression: Number(SYSTEM_STATUS_ORDER[currentRoutingStatus] ?? SYSTEM_STATUS_ORDER.fail)
      < Number(SYSTEM_STATUS_ORDER[previousRoutingStatus] ?? SYSTEM_STATUS_ORDER.fail),
    planner_regression: Number(PLANNER_STATUS_ORDER[currentPlannerStatus] ?? PLANNER_STATUS_ORDER.fail)
      < Number(PLANNER_STATUS_ORDER[previousPlannerStatus] ?? PLANNER_STATUS_ORDER.fail),
  };
}

export function renderSystemSelfCheckReport(result = {}) {
  const systemSummary = result?.system_summary || {};
  const writeSummary = result?.write_summary || {};
  const rolloutBasisSummary = writeSummary?.rollout_advice?.basis_summary || {};
  const writeModes = Object.entries(writeSummary?.enforcement_modes?.mode_counts || {})
    .map(([mode, count]) => `${mode}:${count}`)
    .join(",");
  const upgradeReady = Array.isArray(writeSummary?.rollout_advice?.upgrade_ready_routes)
    ? uniqLabels(writeSummary.rollout_advice.upgrade_ready_routes.map((route) => cleanText(route?.action) || cleanText(route?.pathname)))
    : [];
  const highRisk = Array.isArray(writeSummary?.rollout_advice?.high_risk_routes)
    ? uniqLabels(writeSummary.rollout_advice.high_risk_routes.map((route) => cleanText(route?.action) || cleanText(route?.pathname)))
    : [];
  const rolloutBasisRoutes = Array.isArray(rolloutBasisSummary?.routes)
    ? rolloutBasisSummary.routes
    : [];
  const realOnlyLine = rolloutBasisRoutes.length > 0
    ? rolloutBasisRoutes
      .map((route) => `${cleanText(route?.action) || cleanText(route?.pathname) || "unknown"}=${route?.real_traffic_violation_rate == null ? "unknown" : route.real_traffic_violation_rate}`)
      .join(",")
    : "none";
  const rolloutBasisLine = rolloutBasisRoutes.length > 0
    ? `${Number(rolloutBasisSummary?.eligible_route_count || 0)}/${Number(rolloutBasisSummary?.candidate_route_count || 0)} ready`
    : "none";

  return [
    "System Self-Check",
    `現在系統能不能放心改：${systemSummary?.answer || "先不要"}`,
    `結論：core ${systemSummary?.core_checks || "fail"} | company-brain ${systemSummary?.company_brain_status || "fail"} | control ${systemSummary?.control_status || "fail"} | write-policy ${systemSummary?.write_policy_status || "fail"} | routing ${systemSummary?.routing_status || "fail"} | planner ${systemSummary?.planner_gate || "fail"} | regression ${systemSummary?.has_obvious_regression ? "yes" : "no"}`,
    `write policy：coverage ${Number(writeSummary?.policy_coverage?.enforced_route_count || 0)}/${Number(writeSummary?.policy_coverage?.metadata_route_count || 0)} | modes ${writeModes || "none"}`,
    `write evidence：real_only_violation ${realOnlyLine} | rollout_basis ${rolloutBasisLine}`,
    `write rollout：ready ${upgradeReady.length > 0 ? upgradeReady.join(",") : "none"} | high_risk ${highRisk.length > 0 ? highRisk.join(",") : "none"}`,
    `先看：${systemSummary?.review_priority || "base"}`,
    `指引：${systemSummary?.guidance || "先看 self-check 失敗項目。"}`
  ].join("\n");
}

export async function runSystemSelfCheck({
  routingArchiveDir,
  plannerArchiveDir,
  selfCheckArchiveDir,
  plannerContractCheck = runPlannerContractConsistencyCheck,
} = {}) {
  const agents = listRegisteredAgents();
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]));

  const missingAgents = REQUIRED_AGENT_IDS.filter((id) => !agentMap.has(id));
  const invalidContracts = agents
    .map((agent) => ({
      agent_id: agent.id,
      issues: validateAgentContract(agent),
    }))
    .filter((item) => item.issues.length > 0);

  const missingKnowledgeSubcommands = [
    "audit",
    "consistency",
    "conflicts",
    "distill",
    "brain",
    "proposals",
    "approve",
    "reject",
    "ownership",
    "learn",
  ].filter((item) => !knowledgeAgentSubcommands.includes(item));

  const routeCoverage = REQUIRED_HTTP_PATHS.map((pathname) => ({
    pathname,
    methods: getAllowedMethodsForPath(pathname) || [],
  }));
  const missingRoutes = routeCoverage.filter((item) => item.methods.length === 0).map((item) => item.pathname);

  const serviceInitialization = [];
  for (const modulePath of REQUIRED_SERVICE_MODULES) {
    try {
      await import(modulePath);
      serviceInitialization.push({ module: modulePath, ok: true });
    } catch (error) {
      serviceInitialization.push({
        module: modulePath,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const [controlSummary, writeSummary, plannerSummary, routingSummary] = await Promise.all([
    buildControlSummary(),
    buildWriteSummary(),
    buildPlannerSummary({ plannerArchiveDir, plannerContractCheck }),
    buildRoutingSummary({ routingArchiveDir }),
  ]);
  const companyBrainSummary = runCompanyBrainLifecycleSelfCheck({
    getRouteContract,
  });
  const baseOk = !hasBlockingBaseFailures({
    missingAgents,
    invalidContracts,
    missingKnowledgeSubcommands,
    missingRoutes,
    serviceInitialization,
  });
  const systemSummary = buildSystemSummary({
    baseOk,
    companyBrainSummary,
    controlSummary,
    writeSummary,
    routingSummary,
    plannerSummary,
  });
  const ok = systemSummary.safe_to_change === true;

  const result = {
    ok,
    doc_boundary_regression: routingSummary?.doc_boundary_regression === true,
    system_summary: systemSummary,
    company_brain_summary: companyBrainSummary,
    control_summary: controlSummary,
    write_summary: writeSummary,
    routing_summary: routingSummary,
    planner_summary: {
      gate: plannerSummary.gate,
      summary: plannerSummary.summary,
      guidance: plannerSummary.guidance,
      latest_snapshot: plannerSummary.latest_snapshot,
      compare: plannerSummary.compare,
      diagnostics_summary: plannerSummary.diagnostics_summary,
    },
    agents: {
      total: agents.length,
      missing: missingAgents,
      invalid_contracts: invalidContracts,
      knowledge_subcommands_missing: missingKnowledgeSubcommands,
    },
    routes: {
      checked: routeCoverage,
      missing: missingRoutes,
    },
    services: serviceInitialization,
    planner_contract: {
      gate_ok: plannerSummary?.report?.gate?.ok === true,
      consistency_ok: plannerSummary?.report?.ok === true,
      failing_categories: Array.isArray(plannerSummary?.report?.gate?.failing_categories)
        ? plannerSummary.report.gate.failing_categories
        : [],
      summary: plannerSummary?.report?.summary || null,
    },
  };

  const selfCheckArchive = await archiveSystemSelfCheckSnapshot({
    ...(selfCheckArchiveDir ? { baseDir: selfCheckArchiveDir } : {}),
    report: result,
  });

  return {
    ...result,
    self_check_archive: selfCheckArchive,
  };
}
