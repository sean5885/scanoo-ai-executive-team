import { listRegisteredAgents } from "./agent-registry.mjs";
import { executiveTaskStateStorePath } from "./config.mjs";
import { existsSync, readFileSync } from "node:fs";
import {
  buildControlSummary,
  buildDiagnosticsReportingSummary,
  buildVerificationFailureTaxonomy,
  buildWriteSummary,
} from "./control-diagnostics.mjs";
import { runCompanyBrainLifecycleSelfCheck } from "./company-brain-lifecycle-contract.mjs";
import { buildDependencySummary } from "./dependency-guardrails.mjs";
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
import { readJsonFile } from "./token-store.mjs";

const REQUIRED_AGENT_IDS = [
  "generalist",
  "planner_agent",
  "company_brain_agent",
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
const USAGE_LAYER_GATE_STAGE_PHASE_1 = "phase1";
const USAGE_LAYER_GATE_STAGE_PHASE_2 = "phase2";
const USAGE_LAYER_GATE_THRESHOLDS = {
  [USAGE_LAYER_GATE_STAGE_PHASE_1]: {
    fthr_min_percent: 70,
    generic_rate_max_percent: 30,
  },
  [USAGE_LAYER_GATE_STAGE_PHASE_2]: {
    fthr_min_percent: 80,
    generic_rate_max_percent: 20,
  },
};
const SYSTEM_STATUS_ORDER = {
  fail: 0,
  degrade: 1,
  pass: 2,
};
const PLANNER_STATUS_ORDER = {
  fail: 0,
  pass: 1,
};
const DECISION_OS_OBSERVABILITY_VERSION = "decision_os_observability_v1";
const DECISION_OS_SCORE_WEIGHTS = {
  gate: 55,
  routing: 30,
  memory: 15,
};
const TRUTHFUL_COMPLETION_METRICS_VERSION = "truthful_completion_metrics_v1";
const TRUTHFUL_COMPLETION_THRESHOLDS = Object.freeze({
  pdf_success_rate_min: 0.9,
  pdf_min_case_count: 50,
  fake_completion_rate_max: 0.02,
  verifier_coverage_rate_min: 1,
  parallel_ratio_min: 0.4,
  blocked_misreported_completed_max: 0,
  documentation_consistency_rate_min: 1,
});
const REQUIRED_DOC_SYNC_PATHS = Object.freeze([
  "docs/system/architecture.md",
  "docs/system/data_flow.md",
  "docs/system/module_contracts.md",
]);
const REQUIRED_DOC_SYNC_CONTENT_CONTRACTS = Object.freeze([
  {
    path: "docs/system/architecture.md",
    checks: [
      {
        id: "control_execution_evidence_plane_reference",
        description: "architecture must mirror control/execution/evidence plane module split",
        pattern: /src\/contracts\/index\.mjs/i,
      },
      {
        id: "execution_plane_replaceable_modules_reference",
        description: "architecture must include replaceable execution modules (decision/dispatch/recovery/formatter)",
        pattern: /src\/execution\/decision\.mjs[\s\S]*src\/execution\/dispatch\.mjs[\s\S]*src\/execution\/recovery\.mjs[\s\S]*src\/execution\/formatter\.mjs/i,
      },
      {
        id: "module_contract_doc_reference",
        description: "architecture must reference docs/system/module_contracts.md",
        pattern: /docs\/system\/module_contracts\.md/i,
      },
    ],
  },
  {
    path: "docs/system/data_flow.md",
    checks: [
      {
        id: "pdf_extractor_reference",
        description: "data-flow must mirror PDF ingestion via src/pdf-extractor.mjs",
        pattern: /src\/pdf-extractor\.mjs/i,
      },
      {
        id: "pdf_retriever_reference",
        description: "data-flow must mirror PDF retrieval chunk mapping via src/pdf-retriever.mjs",
        pattern: /src\/pdf-retriever\.mjs/i,
      },
      {
        id: "pdf_answer_reference",
        description: "data-flow must mirror PDF answer citation rendering via src/pdf-answer.mjs",
        pattern: /src\/pdf-answer\.mjs/i,
      },
      {
        id: "pdf_ocr_fallback_reference",
        description: "data-flow must mention OCR fallback for scanned PDFs",
        pattern: /ocr fallback/i,
      },
      {
        id: "pdf_page_citation_reference",
        description: "data-flow must mention page-aware citation markers (#page)",
        pattern: /#page/i,
      },
    ],
  },
  {
    path: "docs/system/module_contracts.md",
    checks: [
      {
        id: "capability_contract_section",
        description: "module contracts must include capability contract section",
        pattern: /##\s*Capability Contracts/i,
      },
      {
        id: "failure_taxonomy_section",
        description: "module contracts must include failure taxonomy section",
        pattern: /##\s*Failure Taxonomy/i,
      },
      {
        id: "evidence_schema_section",
        description: "module contracts must include evidence schema section",
        pattern: /##\s*Evidence Schema/i,
      },
      {
        id: "subtask_artifact_gate_section",
        description: "module contracts must include subtask artifact gate boundary",
        pattern: /Subtask Artifact Gate/i,
      },
    ],
  },
]);

function resolveUsageLayerGateStage(stage = "") {
  const normalized = cleanText(stage || process.env.USAGE_LAYER_GATE_STAGE || "").toLowerCase();
  if (
    normalized === "2"
    || normalized === "stage2"
    || normalized === "phase2"
    || normalized === "p2"
  ) {
    return USAGE_LAYER_GATE_STAGE_PHASE_2;
  }
  return USAGE_LAYER_GATE_STAGE_PHASE_1;
}

function parsePercentMetric(value = null) {
  if (value == null) {
    return null;
  }
  const text = cleanText(value);
  if (text) {
    const parsed = Number.parseFloat(text.replace(/%/g, ""));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  if (numeric >= 0 && numeric <= 1) {
    return numeric * 100;
  }
  return numeric;
}

function formatPercentMetric(value = null) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }
  return `${Number(value).toFixed(2)}%`;
}

function safeRatio(numerator = 0, denominator = 0) {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) {
    return null;
  }
  return Number((n / d).toFixed(4));
}

function normalizeTaskListFromStore(store = {}) {
  if (!store || typeof store !== "object") {
    return [];
  }
  const taskMap = store.tasks && typeof store.tasks === "object" ? store.tasks : {};
  return Object.values(taskMap).filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function readLastVerification(task = {}) {
  const verifications = Array.isArray(task?.verifications) ? task.verifications : [];
  return verifications.at(-1) || null;
}

function looksLikePdfTask(task = {}) {
  const summary = cleanText([
    task?.task_type,
    task?.workflow,
    task?.objective,
    task?.execution_journal?.classified_intent,
    task?.execution_journal?.selected_action,
  ].filter(Boolean).join(" ")).toLowerCase();
  return /\bpdf\b|\.pdf|附件|檔案|文件檔|文件档/.test(summary);
}

function hasCompletedTone(text = "") {
  return /已完成|已處理完|已处理完|完成了|全部完成|已搞定/u.test(cleanText(text));
}

function deriveAssistantTurnText(task = {}) {
  const turns = Array.isArray(task?.turns) ? task.turns : [];
  const assistantTurn = [...turns].reverse().find((item) => cleanText(item?.role) === "assistant");
  return cleanText(assistantTurn?.text || task?.execution_journal?.reply_text || "");
}

function computeParallelStepSignals(task = {}) {
  const workPlan = Array.isArray(task?.work_plan) ? task.work_plan : [];
  if (workPlan.length <= 1) {
    return { total: 0, parallel: 0 };
  }
  const total = workPlan.length;
  const parallel = workPlan.filter((item) => cleanText(item?.role || "").toLowerCase() !== "primary").length;
  return { total, parallel };
}

function defaultResolveDocSyncPath(filePath = "") {
  if (!existsSync(filePath)) {
    return { exists: false, text: "" };
  }
  try {
    return {
      exists: true,
      text: readFileSync(filePath, "utf8"),
    };
  } catch (error) {
    return {
      exists: false,
      text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveDocSyncRecord(filePath = "", resolveDocSyncPath = defaultResolveDocSyncPath) {
  if (typeof resolveDocSyncPath !== "function") {
    return defaultResolveDocSyncPath(filePath);
  }
  const resolved = resolveDocSyncPath(filePath);
  if (typeof resolved === "string") {
    return {
      exists: true,
      text: resolved,
    };
  }
  if (!resolved || typeof resolved !== "object") {
    return {
      exists: false,
      text: "",
    };
  }
  return {
    exists: resolved.exists === true || typeof resolved.text === "string",
    text: typeof resolved.text === "string" ? resolved.text : "",
    error: cleanText(resolved.error) || null,
  };
}

function buildDocConsistencySignal({ resolveDocSyncPath = defaultResolveDocSyncPath } = {}) {
  const missingPaths = [];
  const failedChecks = [];
  let existingCount = 0;
  let totalChecks = 0;
  let passedChecks = 0;

  for (const contract of REQUIRED_DOC_SYNC_CONTENT_CONTRACTS) {
    const filePath = contract?.path || "";
    const checks = Array.isArray(contract?.checks) ? contract.checks : [];
    const resolved = resolveDocSyncRecord(filePath, resolveDocSyncPath);
    if (resolved.exists) {
      existingCount += 1;
    } else {
      missingPaths.push(filePath);
    }
    for (const check of checks) {
      totalChecks += 1;
      const pattern = check?.pattern instanceof RegExp ? check.pattern : null;
      const matched = resolved.exists && pattern ? pattern.test(resolved.text) : false;
      if (matched) {
        passedChecks += 1;
      } else {
        failedChecks.push({
          path: filePath,
          check_id: cleanText(check?.id) || "unknown_check",
          description: cleanText(check?.description) || "doc contract check failed",
          missing_path: resolved.exists !== true,
        });
      }
    }
  }

  const pathRate = REQUIRED_DOC_SYNC_PATHS.length > 0
    ? Number((existingCount / REQUIRED_DOC_SYNC_PATHS.length).toFixed(4))
    : 1;
  const contentRate = totalChecks > 0
    ? Number((passedChecks / totalChecks).toFixed(4))
    : 1;
  const rate = Number(Math.min(pathRate, contentRate).toFixed(4));

  return {
    checked_paths: REQUIRED_DOC_SYNC_PATHS,
    checked_contract_paths: REQUIRED_DOC_SYNC_CONTENT_CONTRACTS.map((item) => item.path),
    found_path_count: existingCount,
    total_path_count: REQUIRED_DOC_SYNC_PATHS.length,
    missing_paths: missingPaths,
    required_check_count: totalChecks,
    passed_check_count: passedChecks,
    failed_checks: failedChecks,
    path_rate: pathRate,
    content_rate: contentRate,
    pass: missingPaths.length === 0 && failedChecks.length === 0,
    rate,
  };
}

async function buildTruthfulCompletionMetricsSummary({
  docSyncResolver = null,
  pdfAcceptanceCheck = null,
} = {}) {
  let rawStore = null;
  try {
    rawStore = await readJsonFile(executiveTaskStateStorePath);
  } catch (error) {
    return {
      version: TRUTHFUL_COMPLETION_METRICS_VERSION,
      status: "unknown",
      summary: "truthful completion metrics unavailable",
      thresholds: TRUTHFUL_COMPLETION_THRESHOLDS,
      error: error instanceof Error ? error.message : String(error),
      metrics: {},
    };
  }

  const tasks = normalizeTaskListFromStore(rawStore);
  const importantTasks = tasks.filter((task) => cleanText(task?.task_type || task?.workflow || task?.objective));
  const importantTaskTotal = importantTasks.length;

  const pdfTasks = importantTasks.filter((task) => looksLikePdfTask(task));
  const pdfE2eTotalFromStore = pdfTasks.length;
  const pdfE2ePassFromStore = pdfTasks.filter((task) => readLastVerification(task)?.pass === true).length;
  let pdfAcceptanceSummary = null;
  try {
    if (typeof pdfAcceptanceCheck === "function") {
      pdfAcceptanceSummary = await pdfAcceptanceCheck();
    } else {
      const { runPdfAcceptanceEval } = await import("./pdf-acceptance-eval.mjs");
      pdfAcceptanceSummary = await runPdfAcceptanceEval();
    }
  } catch {
    pdfAcceptanceSummary = null;
  }
  const pdfE2eTotal = Number.isFinite(Number(pdfAcceptanceSummary?.total_cases))
    ? Number(pdfAcceptanceSummary.total_cases)
    : pdfE2eTotalFromStore;
  const pdfE2ePass = Number.isFinite(Number(pdfAcceptanceSummary?.pass_count))
    ? Number(pdfAcceptanceSummary.pass_count)
    : pdfE2ePassFromStore;

  const verifierCoveredCount = importantTasks.filter((task) => Array.isArray(task?.verifications) && task.verifications.length > 0).length;
  const fakeCompletionCount = importantTasks.filter((task) => readLastVerification(task)?.fake_completion === true).length;

  let totalStepCount = 0;
  let parallelStepCount = 0;
  for (const task of importantTasks) {
    const signals = computeParallelStepSignals(task);
    totalStepCount += signals.total;
    parallelStepCount += signals.parallel;
  }

  const blockedMisreportedCompleted = importantTasks.filter((task) => {
    const status = cleanText(task?.status || task?.lifecycle_state || "").toLowerCase();
    if (status !== "blocked" && status !== "escalated") {
      return false;
    }
    return hasCompletedTone(deriveAssistantTurnText(task));
  }).length;

  const pdfSuccessRate = safeRatio(pdfE2ePass, pdfE2eTotal);
  const fakeCompletionRate = safeRatio(fakeCompletionCount, importantTaskTotal);
  const verifierCoverageRate = safeRatio(verifierCoveredCount, importantTaskTotal);
  const parallelRatio = safeRatio(parallelStepCount, totalStepCount);
  const docConsistency = buildDocConsistencySignal({
    ...(typeof docSyncResolver === "function"
      ? { resolveDocSyncPath: docSyncResolver }
      : {}),
  });
  const hasSufficientSample = importantTaskTotal >= 40 && pdfE2eTotal >= 1 && totalStepCount >= 10;
  const hasDocContractFailure = docConsistency.pass !== true
    || docConsistency.rate < TRUTHFUL_COMPLETION_THRESHOLDS.documentation_consistency_rate_min;
  const hasPdfCaseCoverageFailure = pdfE2eTotal < TRUTHFUL_COMPLETION_THRESHOLDS.pdf_min_case_count;
  const hasPdfSuccessThresholdFailure = pdfSuccessRate == null
    || pdfSuccessRate < TRUTHFUL_COMPLETION_THRESHOLDS.pdf_success_rate_min;
  const hasPdfAcceptanceFailure = hasPdfCaseCoverageFailure || hasPdfSuccessThresholdFailure;

  const metricChecks = [
    pdfSuccessRate == null || pdfSuccessRate >= TRUTHFUL_COMPLETION_THRESHOLDS.pdf_success_rate_min,
    fakeCompletionRate == null || fakeCompletionRate < TRUTHFUL_COMPLETION_THRESHOLDS.fake_completion_rate_max,
    verifierCoverageRate == null || verifierCoverageRate >= TRUTHFUL_COMPLETION_THRESHOLDS.verifier_coverage_rate_min,
    parallelRatio == null || parallelRatio >= TRUTHFUL_COMPLETION_THRESHOLDS.parallel_ratio_min,
    blockedMisreportedCompleted <= TRUTHFUL_COMPLETION_THRESHOLDS.blocked_misreported_completed_max,
    docConsistency.rate >= TRUTHFUL_COMPLETION_THRESHOLDS.documentation_consistency_rate_min,
  ];
  const status = hasDocContractFailure || hasPdfAcceptanceFailure
    ? "fail"
    : !hasSufficientSample
      ? "unknown"
    : metricChecks.every(Boolean)
      ? "pass"
      : "fail";

  return {
    version: TRUTHFUL_COMPLETION_METRICS_VERSION,
    status,
    summary: status === "pass"
      ? "truthful completion metrics pass"
      : status === "fail"
        ? hasDocContractFailure
          ? "truthful completion metrics fail because documentation contracts are inconsistent"
          : hasPdfAcceptanceFailure
            ? "truthful completion metrics fail because PDF acceptance coverage or success rate is below contract"
          : "truthful completion metrics have threshold violations"
        : "truthful completion metrics sample is not large enough for strict gating",
    thresholds: TRUTHFUL_COMPLETION_THRESHOLDS,
    metrics: {
      important_task_total: importantTaskTotal,
      pdf_e2e_pass: pdfE2ePass,
      pdf_e2e_total: pdfE2eTotal,
      pdf_task_success_rate: pdfSuccessRate,
      fake_completion_count: fakeCompletionCount,
      fake_completion_rate: fakeCompletionRate,
      verifier_covered_count: verifierCoveredCount,
      verifier_coverage_rate: verifierCoverageRate,
      parallel_step_count: parallelStepCount,
      total_step_count: totalStepCount,
      parallel_ratio: parallelRatio,
      blocked_misreported_completed_count: blockedMisreportedCompleted,
      documentation_consistency_rate: docConsistency.rate,
      documentation_consistency: docConsistency,
      pdf_acceptance: pdfAcceptanceSummary,
      pdf_acceptance_min_case_count: TRUTHFUL_COMPLETION_THRESHOLDS.pdf_min_case_count,
      pdf_acceptance_case_coverage_fail: hasPdfCaseCoverageFailure,
      pdf_acceptance_success_rate_fail: hasPdfSuccessThresholdFailure,
      pdf_acceptance_hard_gate_fail: hasPdfAcceptanceFailure,
      documentation_consistency_hard_gate_fail: hasDocContractFailure,
      sample_ready_for_gate: hasSufficientSample,
    },
  };
}

async function runUsageLayerEvalSummary() {
  const [{ usageLayerEvals }, { runUsageLayerEvalCase, summarizeResults }] = await Promise.all([
    import("../evals/usage-layer/usage-layer-evals.mjs"),
    import("../evals/usage-layer/usage-layer-runner.mjs"),
  ]);

  const results = [];
  for (const testCase of usageLayerEvals) {
    results.push(await runUsageLayerEvalCase(testCase));
  }
  return summarizeResults(results);
}

async function buildUsageLayerSummary({
  usageLayerCheck = runUsageLayerEvalSummary,
  usageLayerGateStage = "",
} = {}) {
  const gateStage = resolveUsageLayerGateStage(usageLayerGateStage);
  const thresholds = USAGE_LAYER_GATE_THRESHOLDS[gateStage] || USAGE_LAYER_GATE_THRESHOLDS[USAGE_LAYER_GATE_STAGE_PHASE_1];

  let evalSummary = null;
  try {
    evalSummary = await usageLayerCheck();
  } catch (error) {
    return {
      status: "fail",
      gate_stage: gateStage,
      thresholds,
      metrics: {
        FTHR: null,
        generic_rate: null,
        fthr_percent: null,
        generic_rate_percent: null,
      },
      total_cases: 0,
      blocking_reasons: ["usage_eval_error"],
      summary: "usage-layer gate failed",
      guidance: "先跑 npm run eval:usage-layer；usage-layer metrics 無法取得時不可放行 merge/release。",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const metrics = evalSummary?.metrics || {};
  const totalCases = Number(evalSummary?.total || evalSummary?.total_cases || 0);
  const fthrPercent = parsePercentMetric(metrics?.fthr_percent ?? metrics?.FTHR);
  const genericRatePercent = parsePercentMetric(metrics?.generic_rate_percent ?? metrics?.generic_rate);
  const blockingReasons = [];

  if (!Number.isFinite(fthrPercent)) {
    blockingReasons.push("fthr_unavailable");
  } else if (fthrPercent < Number(thresholds.fthr_min_percent)) {
    blockingReasons.push("fthr_below_threshold");
  }

  if (!Number.isFinite(genericRatePercent)) {
    blockingReasons.push("generic_rate_unavailable");
  } else if (genericRatePercent > Number(thresholds.generic_rate_max_percent)) {
    blockingReasons.push("generic_rate_above_threshold");
  }

  const status = blockingReasons.length === 0 ? "pass" : "fail";
  const fthrLine = formatPercentMetric(fthrPercent) || "unknown";
  const genericLine = formatPercentMetric(genericRatePercent) || "unknown";
  const targetLine = `FTHR >= ${Number(thresholds.fthr_min_percent).toFixed(0)}%、Generic <= ${Number(thresholds.generic_rate_max_percent).toFixed(0)}%`;

  return {
    status,
    gate_stage: gateStage,
    thresholds,
    metrics: {
      FTHR: cleanText(metrics?.FTHR) || formatPercentMetric(fthrPercent),
      generic_rate: cleanText(metrics?.generic_rate) || formatPercentMetric(genericRatePercent),
      fthr_percent: Number.isFinite(fthrPercent) ? Number(fthrPercent.toFixed(2)) : null,
      generic_rate_percent: Number.isFinite(genericRatePercent) ? Number(genericRatePercent.toFixed(2)) : null,
    },
    total_cases: Number.isFinite(totalCases) ? totalCases : 0,
    blocking_reasons: blockingReasons,
    summary: status === "pass"
      ? "usage-layer gate passes"
      : "usage-layer gate fails",
    guidance: status === "pass"
      ? `usage-layer gate 通過：${targetLine}（目前 FTHR ${fthrLine}、Generic ${genericLine}）。`
      : `先跑 npm run eval:usage-layer 並修正 usage 回覆品質：目標 ${targetLine}（目前 FTHR ${fthrLine}、Generic ${genericLine}）。`,
  };
}

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
  dependencySummary = {},
  writeSummary = {},
  usageLayerSummary = {},
  routingSummary = {},
  plannerSummary = {},
  truthfulCompletionMetrics = {},
} = {}) {
  const companyBrainStatus = cleanText(companyBrainSummary?.status) === "pass" ? "pass" : "fail";
  const controlStatus = cleanText(controlSummary?.status) === "pass" ? "pass" : "fail";
  const dependencyStatus = cleanText(dependencySummary?.status) === "fail" ? "fail" : "pass";
  const usageLayerStatus = cleanText(usageLayerSummary?.status) === "pass" ? "pass" : "fail";
  const routingStatus = routingSummary?.status || "fail";
  const plannerGate = plannerSummary?.gate || "fail";
  const truthfulCompletionStatus = cleanText(truthfulCompletionMetrics?.status || "unknown") === "fail" ? "fail" : "pass";
  const hasObviousRegression = Boolean(
    routingSummary?.compare?.has_obvious_regression
    || plannerSummary?.compare?.has_obvious_regression
  );
  const status = !baseOk
    || companyBrainStatus === "fail"
    || controlStatus === "fail"
    || dependencyStatus === "fail"
    || cleanText(writeSummary?.status) !== "pass"
    || usageLayerStatus === "fail"
    || routingStatus === "fail"
    || plannerGate === "fail"
    || truthfulCompletionStatus === "fail"
    ? "fail"
    : routingStatus === "degrade" || hasObviousRegression
      ? "degrade"
      : "pass";
  const safeToChange = baseOk
    && companyBrainStatus === "pass"
    && controlStatus === "pass"
    && dependencyStatus === "pass"
    && cleanText(writeSummary?.status) === "pass"
    && usageLayerStatus === "pass"
    && routingStatus === "pass"
    && plannerGate === "pass"
    && truthfulCompletionStatus === "pass"
    && hasObviousRegression === false;
  const reviewPriority = !baseOk
    ? "base"
    : companyBrainStatus !== "pass"
      ? "company_brain"
    : controlStatus !== "pass"
      ? "control"
    : dependencyStatus !== "pass"
      ? "dependency"
    : cleanText(writeSummary?.status) !== "pass"
      ? "write_policy"
    : usageLayerStatus !== "pass"
      ? "usage_layer"
    : truthfulCompletionStatus !== "pass"
      ? "truthful_completion"
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
    : reviewPriority === "dependency"
      ? "先看 dependency guardrails：package-lock 不可解析到 axios 1.14.1 / 0.30.4；先跑 npm run check:dependencies，必要時調整 direct/transitive constraints 後再更新。"
    : reviewPriority === "write_policy"
      ? "先看 write governance：external write 必須統一走 canonical request -> runtime；先修 src/http-server.mjs、src/runtime-message-reply.mjs、src/meeting-agent.mjs、src/lane-executor.mjs、src/lark-mutation-runtime.mjs 與對應 route contract/diagnostics。"
      : reviewPriority === "usage_layer"
        ? "先看 usage-layer gate：跑 npm run eval:usage-layer，優先修 first-turn helpfulness 與 generic reply 漂移。"
      : reviewPriority === "truthful_completion"
        ? "先看 truthful completion gate：verification 未通過時前台只能回 blocked/escalated + evidence + limitation；補齊 verifier 覆蓋與 fake-completion 防護後再放行。"
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
    dependency_status: dependencyStatus,
    write_policy_status: cleanText(writeSummary?.status) || "fail",
    usage_layer_status: usageLayerStatus,
    truthful_completion_status: truthfulCompletionStatus,
    routing_status: routingStatus,
    planner_gate: plannerGate,
    has_obvious_regression: hasObviousRegression,
    review_priority: reviewPriority,
    guidance,
  };
}

function toFiniteNumber(value = null, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return numeric;
}

function clampNumber(value = 0, minimum = 0, maximum = 1) {
  const numeric = toFiniteNumber(value, minimum);
  return Math.min(maximum, Math.max(minimum, numeric));
}

function roundNumber(value = 0, digits = 2) {
  const numeric = toFiniteNumber(value, 0);
  const precision = Number.isFinite(Number(digits)) ? Number(digits) : 2;
  return Number(numeric.toFixed(precision));
}

function normalizeMemoryInfluenceSummary(summary = null) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return {
      status: "unknown",
      source: "not_configured",
      gate: "unknown",
      summary: "memory influence signal unavailable",
      metrics: {
        memory_hit_rate: null,
        action_changed_by_memory_rate: null,
      },
      thresholds: {
        memory_hit_rate_min: null,
        action_changed_by_memory_rate_min: null,
      },
    };
  }

  const gate = cleanText(summary?.gate)
    || (summary?.ok === true ? "pass" : summary?.ok === false ? "fail" : "unknown");
  const status = gate === "pass"
    ? "pass"
    : gate === "fail"
      ? "fail"
      : "unknown";

  return {
    status,
    source: cleanText(summary?.source) || "memory_influence_check",
    gate,
    summary: cleanText(summary?.summary)
      || (
        gate === "pass"
          ? "memory influence gate passes"
          : gate === "fail"
            ? "memory influence gate fails"
            : "memory influence gate unavailable"
      ),
    metrics: {
      memory_hit_rate: toFiniteNumber(summary?.metrics?.memory_hit_rate, null),
      action_changed_by_memory_rate: toFiniteNumber(summary?.metrics?.action_changed_by_memory_rate, null),
    },
    thresholds: {
      memory_hit_rate_min: toFiniteNumber(summary?.thresholds?.memory_hit_rate_min, null),
      action_changed_by_memory_rate_min: toFiniteNumber(summary?.thresholds?.action_changed_by_memory_rate_min, null),
    },
  };
}

async function resolveMemoryInfluenceSummary({ memoryInfluenceCheck = null } = {}) {
  if (typeof memoryInfluenceCheck !== "function") {
    return normalizeMemoryInfluenceSummary(null);
  }

  try {
    return normalizeMemoryInfluenceSummary(await memoryInfluenceCheck());
  } catch (error) {
    return {
      status: "fail",
      source: "memory_influence_check_error",
      gate: "fail",
      summary: "memory influence check failed",
      metrics: {
        memory_hit_rate: null,
        action_changed_by_memory_rate: null,
      },
      thresholds: {
        memory_hit_rate_min: null,
        action_changed_by_memory_rate_min: null,
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildDecisionOsGateChecks({
  baseOk = false,
  companyBrainSummary = {},
  controlSummary = {},
  dependencySummary = {},
  writeSummary = {},
  usageLayerSummary = {},
  routingSummary = {},
  plannerSummary = {},
  truthfulCompletionMetrics = {},
} = {}) {
  const routingStatus = normalizeRoutingStatus(routingSummary?.status);
  const plannerStatus = normalizePlannerStatus(plannerSummary?.gate);

  const checks = [
    {
      gate_id: "base_checks",
      pass: baseOk === true,
    },
    {
      gate_id: "company_brain_lifecycle",
      pass: cleanText(companyBrainSummary?.status) === "pass",
    },
    {
      gate_id: "control_integrity",
      pass: cleanText(controlSummary?.status) === "pass",
    },
    {
      gate_id: "dependency_policy",
      pass: cleanText(dependencySummary?.status || "pass") === "pass",
    },
    {
      gate_id: "write_policy",
      pass: cleanText(writeSummary?.status) === "pass",
    },
    {
      gate_id: "usage_layer_quality",
      pass: cleanText(usageLayerSummary?.status) === "pass",
    },
    {
      gate_id: "routing_snapshot",
      pass: routingStatus === "pass",
    },
    {
      gate_id: "routing_compare",
      pass: routingSummary?.compare?.has_obvious_regression !== true,
    },
    {
      gate_id: "planner_contract",
      pass: plannerStatus === "pass",
    },
    {
      gate_id: "planner_compare",
      pass: plannerSummary?.compare?.has_obvious_regression !== true,
    },
    {
      gate_id: "truthful_completion_metrics",
      pass: cleanText(truthfulCompletionMetrics?.status || "unknown") !== "fail",
    },
  ];
  const passCount = checks.filter((check) => check.pass === true).length;
  const total = checks.length;
  const failCount = Math.max(0, total - passCount);
  const passRate = total > 0 ? Number((passCount / total).toFixed(4)) : 0;

  return {
    checks,
    total,
    pass_count: passCount,
    fail_count: failCount,
    pass_rate: passRate,
  };
}

function buildDecisionOsBlockedReasons({
  baseOk = false,
  companyBrainSummary = {},
  controlSummary = {},
  dependencySummary = {},
  writeSummary = {},
  usageLayerSummary = {},
  routingSummary = {},
  plannerSummary = {},
  verificationFailureTaxonomy = {},
  truthfulCompletionMetrics = {},
} = {}) {
  const reasons = [];
  if (!baseOk) {
    reasons.push("base_regression");
  }
  if (cleanText(companyBrainSummary?.status) !== "pass") {
    reasons.push("company_brain_lifecycle_failure");
  }
  if (cleanText(controlSummary?.status) !== "pass") {
    reasons.push("control_regression");
  }
  if (cleanText(dependencySummary?.status || "pass") !== "pass") {
    reasons.push("dependency_policy_failure");
  }
  if (cleanText(writeSummary?.status) !== "pass") {
    reasons.push("write_policy_failure");
  }
  if (cleanText(usageLayerSummary?.status) !== "pass") {
    reasons.push("usage_layer_failure");
    if (Array.isArray(usageLayerSummary?.blocking_reasons)) {
      for (const reason of usageLayerSummary.blocking_reasons) {
        const normalized = cleanText(reason);
        if (normalized) {
          reasons.push(`usage_layer:${normalized}`);
        }
      }
    }
  }
  if (
    normalizeRoutingStatus(routingSummary?.status) !== "pass"
    || routingSummary?.compare?.has_obvious_regression === true
  ) {
    reasons.push("routing_regression");
    if (routingSummary?.doc_boundary_regression === true) {
      reasons.push("routing_doc_boundary_regression");
    }
  }
  if (
    normalizePlannerStatus(plannerSummary?.gate) !== "pass"
    || plannerSummary?.compare?.has_obvious_regression === true
  ) {
    reasons.push("planner_contract_failure");
    const plannerFailingCategories = Array.isArray(plannerSummary?.report?.gate?.failing_categories)
      ? plannerSummary.report.gate.failing_categories
      : [];
    for (const category of plannerFailingCategories) {
      const normalized = cleanText(category);
      if (normalized) {
        reasons.push(`planner:${normalized}`);
      }
    }
  }
  if (cleanText(verificationFailureTaxonomy?.status) === "fail") {
    reasons.push("verification_failure_taxonomy");
    const topCases = Array.isArray(verificationFailureTaxonomy?.top_regression_cases)
      ? verificationFailureTaxonomy.top_regression_cases
      : [];
    for (const item of topCases.slice(0, 2)) {
      const line = cleanText(item?.line) || "unknown";
      const caseId = cleanText(item?.case_id) || "unknown";
      reasons.push(`verification:${line}:${caseId}`);
    }
  }
  if (cleanText(truthfulCompletionMetrics?.status) === "fail") {
    reasons.push("truthful_completion_metrics_failure");
  }
  return uniqLabels(reasons);
}

function buildDecisionOsRoutingSignal(routingSummary = {}) {
  const status = normalizeRoutingStatus(routingSummary?.status);
  const accuracyRatio = toFiniteNumber(routingSummary?.latest_snapshot?.accuracy_ratio, null);
  const threshold = toFiniteNumber(routingSummary?.latest_snapshot?.threshold, null)
    || ROUTING_EVAL_MIN_ACCURACY_RATIO;
  const hasObviousRegression = routingSummary?.compare?.has_obvious_regression === true;
  const gatePass = status === "pass" && hasObviousRegression !== true;

  return {
    status,
    gate_pass: gatePass,
    accuracy_ratio: accuracyRatio,
    threshold,
    has_obvious_regression: hasObviousRegression,
    doc_boundary_regression: routingSummary?.doc_boundary_regression === true,
  };
}

function buildDecisionOsReadinessScore({
  gateChecks = {},
  routingSignal = {},
  memoryInfluenceSummary = {},
} = {}) {
  const gatePassRate = clampNumber(gateChecks?.pass_rate, 0, 1);
  const gateComponent = DECISION_OS_SCORE_WEIGHTS.gate * gatePassRate;

  const routingAccuracyRatio = toFiniteNumber(routingSignal?.accuracy_ratio, null);
  const routingThreshold = toFiniteNumber(routingSignal?.threshold, ROUTING_EVAL_MIN_ACCURACY_RATIO);
  const routingAccuracyFactor = routingAccuracyRatio == null || routingThreshold <= 0
    ? (routingSignal?.status === "fail" ? 0 : 1)
    : clampNumber(routingAccuracyRatio / routingThreshold, 0, 1);
  const routingStatusFactor = routingSignal?.status === "pass"
    ? 1
    : routingSignal?.status === "degrade"
      ? 0.6
      : 0;
  const routingRegressionFactor = routingSignal?.has_obvious_regression === true ? 0.5 : 1;
  const routingComponent = DECISION_OS_SCORE_WEIGHTS.routing
    * routingStatusFactor
    * routingAccuracyFactor
    * routingRegressionFactor;

  const memoryStatus = cleanText(memoryInfluenceSummary?.status);
  const memoryStatusFactor = memoryStatus === "pass"
    ? 1
    : memoryStatus === "fail"
      ? 0
      : 0.5;
  const memoryComponent = DECISION_OS_SCORE_WEIGHTS.memory * memoryStatusFactor;

  const score = roundNumber(gateComponent + routingComponent + memoryComponent, 2);
  const level = score >= 85
    ? "ready"
    : score >= 70
      ? "watch"
      : "at_risk";

  return {
    score,
    level,
    score_breakdown: {
      gate_checks: roundNumber(gateComponent, 2),
      routing_closed_loop: roundNumber(routingComponent, 2),
      memory_influence: roundNumber(memoryComponent, 2),
    },
  };
}

function buildDecisionOsObservability({
  baseOk = false,
  companyBrainSummary = {},
  controlSummary = {},
  dependencySummary = {},
  writeSummary = {},
  usageLayerSummary = {},
  routingSummary = {},
  plannerSummary = {},
  verificationFailureTaxonomy = {},
  memoryInfluenceSummary = {},
  truthfulCompletionMetrics = {},
} = {}) {
  const gateChecks = buildDecisionOsGateChecks({
    baseOk,
    companyBrainSummary,
    controlSummary,
    dependencySummary,
    writeSummary,
    usageLayerSummary,
    routingSummary,
    plannerSummary,
    truthfulCompletionMetrics,
  });
  const blockedReasons = buildDecisionOsBlockedReasons({
    baseOk,
    companyBrainSummary,
    controlSummary,
    dependencySummary,
    writeSummary,
    usageLayerSummary,
    routingSummary,
    plannerSummary,
    verificationFailureTaxonomy,
    truthfulCompletionMetrics,
  });
  const routingSignal = buildDecisionOsRoutingSignal(routingSummary);
  const normalizedMemoryInfluence = normalizeMemoryInfluenceSummary(memoryInfluenceSummary);
  const readinessScore = buildDecisionOsReadinessScore({
    gateChecks,
    routingSignal,
    memoryInfluenceSummary: normalizedMemoryInfluence,
  });
  const regressionItems = uniqLabels([
    ...blockedReasons.slice(0, 3),
    ...(
      Array.isArray(verificationFailureTaxonomy?.top_regression_cases)
        ? verificationFailureTaxonomy.top_regression_cases.slice(0, 2).map((item) => (
          `${cleanText(item?.line) || "unknown"}:${cleanText(item?.case_id) || "unknown"}`
        ))
        : []
    ),
  ]);

  return {
    version: DECISION_OS_OBSERVABILITY_VERSION,
    generated_at: new Date().toISOString(),
    gate_pass_rate: gateChecks.pass_rate,
    gate_summary: {
      total_gates: gateChecks.total,
      passed_gates: gateChecks.pass_count,
      failed_gates: gateChecks.fail_count,
    },
    gate_checks: gateChecks.checks,
    blocked_reasons: blockedReasons,
    verification_fail_taxonomy: verificationFailureTaxonomy,
    closed_loop_metrics: {
      routing_closed_loop: routingSignal,
      memory_influence: normalizedMemoryInfluence,
      truthful_completion: truthfulCompletionMetrics,
    },
    readiness_score: readinessScore,
    regression_items: regressionItems,
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
  const dependencyStatus = normalizePlannerStatus(
    report?.system_summary?.dependency_status || report?.dependency_summary?.status || "pass",
  );
  const routingStatus = normalizeRoutingStatus(report?.system_summary?.routing_status || report?.routing_summary?.status);
  const plannerStatus = normalizePlannerStatus(report?.system_summary?.planner_gate || report?.planner_summary?.gate);
  const usageLayerStatus = normalizePlannerStatus(
    report?.system_summary?.usage_layer_status || report?.usage_layer_summary?.status || "pass",
  );
  const truthfulCompletionStatus = normalizePlannerStatus(
    report?.system_summary?.truthful_completion_status || report?.truthful_completion_metrics?.status || "pass",
  );
  const hasObviousRegression = Boolean(report?.system_summary?.has_obvious_regression);

  if (
    !baseOk
    || companyBrainStatus === "fail"
    || controlStatus === "fail"
    || dependencyStatus === "fail"
    || usageLayerStatus === "fail"
    || truthfulCompletionStatus === "fail"
    || routingStatus === "fail"
    || plannerStatus === "fail"
  ) {
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
  const usageLayerSummary = result?.usage_layer_summary || {};
  const decisionOs = result?.decision_os_observability || {};
  const decisionOsScore = toFiniteNumber(decisionOs?.readiness_score?.score, null);
  const decisionOsLevel = cleanText(decisionOs?.readiness_score?.level) || "unknown";
  const decisionOsGatePassRate = Number.isFinite(Number(decisionOs?.gate_pass_rate))
    ? `${(Number(decisionOs.gate_pass_rate) * 100).toFixed(2)}%`
    : "unknown";
  const decisionOsGateSummary = decisionOs?.gate_summary || {};
  const decisionOsBlockedReasons = Array.isArray(decisionOs?.blocked_reasons)
    ? decisionOs.blocked_reasons
    : [];
  const decisionOsVerification = decisionOs?.verification_fail_taxonomy || {};
  const decisionOsRoutingClosedLoop = decisionOs?.closed_loop_metrics?.routing_closed_loop || {};
  const decisionOsMemoryInfluence = decisionOs?.closed_loop_metrics?.memory_influence || {};
  const usageGateStage = cleanText(usageLayerSummary?.gate_stage) || USAGE_LAYER_GATE_STAGE_PHASE_1;
  const usageThresholds = usageLayerSummary?.thresholds || USAGE_LAYER_GATE_THRESHOLDS[usageGateStage] || USAGE_LAYER_GATE_THRESHOLDS[USAGE_LAYER_GATE_STAGE_PHASE_1];
  const usageFthr = cleanText(usageLayerSummary?.metrics?.FTHR)
    || formatPercentMetric(usageLayerSummary?.metrics?.fthr_percent)
    || "unknown";
  const usageGeneric = cleanText(usageLayerSummary?.metrics?.generic_rate)
    || formatPercentMetric(usageLayerSummary?.metrics?.generic_rate_percent)
    || "unknown";
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
  const highRiskHints = Array.isArray(writeSummary?.rollout_advice?.high_risk_routes)
    ? uniqLabels(writeSummary.rollout_advice.high_risk_routes.map((route) => {
      const label = cleanText(route?.action) || cleanText(route?.pathname) || "unknown";
      const hint = cleanText(route?.risk_hint);
      return hint ? `${label}=${hint}` : "";
    }).filter(Boolean))
    : [];
  const rolloutBasisRoutes = Array.isArray(rolloutBasisSummary?.routes)
    ? rolloutBasisSummary.routes
    : [];
  const warnToEnforceReadiness = Array.isArray(rolloutBasisSummary?.warn_to_enforce_readiness)
    ? rolloutBasisSummary.warn_to_enforce_readiness
    : [];
  const warnToEnforceReadinessLine = warnToEnforceReadiness.length > 0
    ? warnToEnforceReadiness
      .map((route) => `${cleanText(route?.action) || cleanText(route?.pathname) || "unknown"}=${cleanText(route?.real_request_backed_sample_progress) || "0/0"}`)
      .join(",")
    : "none";
  const operationalDebtItems = Array.isArray(rolloutBasisSummary?.operational_debt?.items)
    ? rolloutBasisSummary.operational_debt.items
    : [];
  const operationalDebtLine = operationalDebtItems.length > 0
    ? operationalDebtItems
      .map((item) => `${cleanText(item?.action) || cleanText(item?.pathname) || "unknown"}=${cleanText(item?.detail) || "unknown"}`)
      .join(",")
    : "none";
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
    `結論：core ${systemSummary?.core_checks || "fail"} | company-brain ${systemSummary?.company_brain_status || "fail"} | control ${systemSummary?.control_status || "fail"} | dependency ${systemSummary?.dependency_status || "pass"} | write-policy ${systemSummary?.write_policy_status || "fail"} | usage-layer ${systemSummary?.usage_layer_status || "fail"} | routing ${systemSummary?.routing_status || "fail"} | planner ${systemSummary?.planner_gate || "fail"} | regression ${systemSummary?.has_obvious_regression ? "yes" : "no"}`,
    `write policy：coverage ${Number(writeSummary?.policy_coverage?.enforced_route_count || 0)}/${Number(writeSummary?.policy_coverage?.metadata_route_count || 0)} | modes ${writeModes || "none"}`,
    `write evidence：real_only_violation ${realOnlyLine} | rollout_basis ${rolloutBasisLine}`,
    `warn->enforce readiness：${warnToEnforceReadinessLine}`,
    `write rollout：ready ${upgradeReady.length > 0 ? upgradeReady.join(",") : "none"} | high_risk ${highRisk.length > 0 ? highRisk.join(",") : "none"}`,
    `write rollout risk：${highRiskHints.length > 0 ? highRiskHints.join(",") : "none"}`,
    `operational debt：${operationalDebtLine}`,
    `usage gate：${usageGateStage} | FTHR ${usageFthr} (>=${Number(usageThresholds?.fthr_min_percent || 0).toFixed(0)}%) | Generic ${usageGeneric} (<=${Number(usageThresholds?.generic_rate_max_percent || 0).toFixed(0)}%)`,
    `decision-os：score ${decisionOsScore == null ? "unknown" : decisionOsScore}/100 | level ${decisionOsLevel} | gate ${Number(decisionOsGateSummary?.passed_gates || 0)}/${Number(decisionOsGateSummary?.total_gates || 0)} (${decisionOsGatePassRate})`,
    `decision-os blockers：${decisionOsBlockedReasons.length > 0 ? decisionOsBlockedReasons.join(",") : "none"}`,
    `decision-os verification：${cleanText(decisionOsVerification?.status) || "unknown"} | taxonomy ${Number(decisionOsVerification?.top_regression_case_count || 0)} cases`,
    `decision-os closed-loop：routing ${cleanText(decisionOsRoutingClosedLoop?.status) || "unknown"} | memory ${cleanText(decisionOsMemoryInfluence?.status) || "unknown"}`,
    `先看：${systemSummary?.review_priority || "base"}`,
    `指引：${systemSummary?.guidance || "先看 self-check 失敗項目。"}`
  ].join("\n");
}

export async function runSystemSelfCheck({
  routingArchiveDir,
  plannerArchiveDir,
  selfCheckArchiveDir,
  dependencyCheck = buildDependencySummary,
  writeCheck = buildWriteSummary,
  plannerContractCheck = runPlannerContractConsistencyCheck,
  usageLayerCheck = runUsageLayerEvalSummary,
  usageLayerGateStage = "",
  memoryInfluenceCheck = null,
  docSyncResolver = null,
  pdfAcceptanceCheck = null,
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

  const missingKnowledgeSubcommands = [];

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

  const [controlSummary, dependencySummary, writeSummary, usageLayerSummary, plannerSummary, routingSummary, memoryInfluenceSummary] = await Promise.all([
    buildControlSummary(),
    dependencyCheck(),
    writeCheck(),
    buildUsageLayerSummary({ usageLayerCheck, usageLayerGateStage }),
    buildPlannerSummary({ plannerArchiveDir, plannerContractCheck }),
    buildRoutingSummary({ routingArchiveDir }),
    resolveMemoryInfluenceSummary({ memoryInfluenceCheck }),
  ]);
  const truthfulCompletionMetrics = await buildTruthfulCompletionMetricsSummary({
    docSyncResolver,
    pdfAcceptanceCheck,
  });
  const companyBrainSummary = runCompanyBrainLifecycleSelfCheck({
    getRouteContract,
  });
  const diagnosticsReportingSummary = buildDiagnosticsReportingSummary({
    controlSummary,
    routingSummary,
    writeSummary,
  });
  const verificationFailureTaxonomy = buildVerificationFailureTaxonomy({
    reportingSummary: diagnosticsReportingSummary,
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
    dependencySummary,
    writeSummary,
    usageLayerSummary,
    routingSummary,
    plannerSummary,
    truthfulCompletionMetrics,
  });
  const decisionOsObservability = buildDecisionOsObservability({
    baseOk,
    companyBrainSummary,
    controlSummary,
    dependencySummary,
    writeSummary,
    usageLayerSummary,
    routingSummary,
    plannerSummary,
    verificationFailureTaxonomy,
    memoryInfluenceSummary,
    truthfulCompletionMetrics,
  });
  const ok = systemSummary.safe_to_change === true;

  const result = {
    ok,
    doc_boundary_regression: routingSummary?.doc_boundary_regression === true,
    system_summary: systemSummary,
    company_brain_summary: companyBrainSummary,
    control_summary: controlSummary,
    dependency_summary: dependencySummary,
    write_summary: writeSummary,
    usage_layer_summary: usageLayerSummary,
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
    decision_os_observability: decisionOsObservability,
    truthful_completion_metrics: truthfulCompletionMetrics,
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
