import path from "node:path";

import { cleanText } from "./message-intent-utils.mjs";
import { resolveControlDiagnosticsSnapshot } from "./control-diagnostics-history.mjs";
import { runPlannerContractConsistencyCheck } from "./planner-contract-consistency.mjs";
import { archiveReleaseCheckSnapshot } from "./release-check-history.mjs";
import { resolveRoutingDiagnosticsSnapshot } from "./routing-diagnostics-history.mjs";
import { detectDocBoundaryRoutingRegression } from "./routing-eval-diagnostics.mjs";
import { runSystemSelfCheck } from "./system-self-check.mjs";

const BLOCKING_SYSTEM_REGRESSION = "system_regression";
const BLOCKING_CONTROL_REGRESSION = "control_regression";
const BLOCKING_DEPENDENCY_POLICY_FAILURE = "dependency_policy_failure";
const BLOCKING_WRITE_POLICY_FAILURE = "write_policy_failure";
const BLOCKING_USAGE_LAYER_FAILURE = "usage_layer_failure";
const BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE = "company_brain_lifecycle_failure";
const BLOCKING_ROUTING_REGRESSION = "routing_regression";
const BLOCKING_PLANNER_CONTRACT_FAILURE = "planner_contract_failure";
const BLOCKING_FULL_TEST_FAILURE = "full_test_failure";
const FAILING_AREA_DOC = "doc";
const FAILING_AREA_MEETING = "meeting";
const FAILING_AREA_RUNTIME = "runtime";
const FAILING_AREA_MIXED = "mixed";
const RELEASE_CHECK_TRIAGE_SOURCE = "release-check triage";
const CONTROL_DRILLDOWN_SOURCE = "control diagnostics/history";
const ROUTING_DRILLDOWN_SOURCE = "routing-eval diagnostics/history";
const PLANNER_DRILLDOWN_SOURCE = "planner diagnostics/history";
const DOC_BOUNDARY_ACTION_HINT = "run routing-eval doc-boundary pack and inspect message-intent-utils / lane-executor guard";
const PLANNER_FINDING_ORDER = [
  "undefined_actions",
  "undefined_presets",
  "selector_contract_mismatches",
  "action_governance_mismatches",
  "deprecated_reachable_targets",
];
const RELEASE_STATUS_ORDER = {
  fail: 0,
  pass: 1,
};
const DECISION_OS_READINESS_VERSION = "decision_os_readiness_v1";

function normalizeServiceModule(modulePath = "") {
  const normalized = cleanText(modulePath);
  if (!normalized) {
    return null;
  }
  return normalized.startsWith("./")
    ? `src/${normalized.slice(2)}`
    : normalized;
}

function normalizeRepoPath(filePath = "") {
  const normalized = cleanText(filePath);
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("./")) {
    return `src/${normalized.slice(2)}`;
  }
  const relativePath = path.relative(process.cwd(), normalized);
  if (relativePath && !relativePath.startsWith("..")) {
    return relativePath;
  }
  return normalized;
}

function buildSystemRegressionNextStep(selfCheckResult = {}) {
  const failingServiceModules = Array.isArray(selfCheckResult?.services)
    ? selfCheckResult.services
      .filter((item) => item?.ok !== true)
      .map((item) => normalizeServiceModule(item?.module))
      .filter(Boolean)
    : [];

  if (failingServiceModules.length > 0) {
    return `先看 system regression 的 service 模組：${failingServiceModules.join("、")}。`;
  }

  if (Array.isArray(selfCheckResult?.routes?.missing) && selfCheckResult.routes.missing.length > 0) {
    return "先看 system regression 的 route contract 模組：src/http-route-contracts.mjs 與對應 route handler。";
  }

  if (
    (Array.isArray(selfCheckResult?.agents?.missing) && selfCheckResult.agents.missing.length > 0)
    || (Array.isArray(selfCheckResult?.agents?.invalid_contracts) && selfCheckResult.agents.invalid_contracts.length > 0)
    || (
      Array.isArray(selfCheckResult?.agents?.knowledge_subcommands_missing)
      && selfCheckResult.agents.knowledge_subcommands_missing.length > 0
    )
  ) {
    return "先看 system regression 的 agent registry / contract：src/agent-registry.mjs。";
  }

  return "先看 system regression 的基礎模組：src/agent-registry.mjs、src/http-route-contracts.mjs、src/*-service.mjs。";
}

function buildControlRegressionNextStep() {
  return "先看 control regression 的 control 模組：src/control-kernel.mjs 與 src/lane-executor.mjs。";
}

function buildDependencyRegressionNextStep() {
  return "先看 dependency guardrails：package-lock.json、scripts/dependency-guardrails.mjs、src/dependency-guardrails.mjs；禁止解析到 axios 1.14.1 / 0.30.4。";
}

function buildCompanyBrainRegressionNextStep() {
  return "先看 company-brain lifecycle contract：src/company-brain-lifecycle-contract.mjs、src/http-route-contracts.mjs、src/system-self-check.mjs；不要改 runtime write path。";
}

function buildWritePolicyRegressionNextStep() {
  return "先看 write governance：src/http-server.mjs、src/runtime-message-reply.mjs、src/meeting-agent.mjs、src/lane-executor.mjs、src/lark-mutation-runtime.mjs、src/http-route-contracts.mjs、src/control-diagnostics.mjs。";
}

function buildUsageLayerRegressionNextStep(selfCheckResult = {}) {
  const usageSummary = selfCheckResult?.usage_layer_summary || {};
  const thresholds = usageSummary?.thresholds || {};
  const metrics = usageSummary?.metrics || {};
  const fthrTarget = Number.isFinite(Number(thresholds?.fthr_min_percent))
    ? Number(thresholds.fthr_min_percent).toFixed(0)
    : "70";
  const genericTarget = Number.isFinite(Number(thresholds?.generic_rate_max_percent))
    ? Number(thresholds.generic_rate_max_percent).toFixed(0)
    : "30";
  const fthrMetric = cleanText(metrics?.FTHR)
    || (Number.isFinite(Number(metrics?.fthr_percent)) ? `${Number(metrics.fthr_percent).toFixed(2)}%` : "unknown");
  const genericMetric = cleanText(metrics?.generic_rate)
    || (Number.isFinite(Number(metrics?.generic_rate_percent)) ? `${Number(metrics.generic_rate_percent).toFixed(2)}%` : "unknown");

  return `先跑 npm run eval:usage-layer；先把 FTHR 拉到 >= ${fthrTarget}% 且 Generic Rate 壓到 <= ${genericTarget}%（目前 FTHR ${fthrMetric}、Generic ${genericMetric}）。`;
}

function buildRoutingRegressionNextStep(selfCheckResult = {}) {
  if (selfCheckResult?.routing_summary?.doc_boundary_regression === true) {
    return "先看 routing regression 的 doc-boundary pack：evals/routing-eval-set.mjs 的 doc-023a~023k；再看 src/message-intent-utils.mjs 與 src/lane-executor.mjs 的 intent guard。";
  }

  const minimalDecision = cleanText(
    selfCheckResult?.routing_summary?.diagnostics_summary?.decision_advice?.minimal_decision?.action,
  );

  if (minimalDecision === "review_fixture_coverage") {
    return "先看 routing regression 的 fixture 檔：evals/routing-eval-set.mjs 與 tests/routing-eval*.test.mjs。";
  }

  if (minimalDecision === "check_routing_rule") {
    return "先看 routing regression 的 rule 模組：src/router.js 與 src/planner-*-flow.mjs。";
  }

  if (minimalDecision === "manual_review_high_risk") {
    return "先看 routing regression 的 diagnostics / rule 模組：src/routing-eval-diagnostics.mjs、src/router.js、src/planner-*-flow.mjs。";
  }

  return "先看 routing regression：diagnostics 在 src/routing-eval-diagnostics.mjs；rule 看 src/router.js / src/planner-*-flow.mjs；fixture 看 evals/routing-eval-set.mjs。";
}

function buildPlannerContractFailureNextStep(selfCheckResult = {}) {
  const failingCategories = Array.isArray(selfCheckResult?.planner_contract?.failing_categories)
    ? selfCheckResult.planner_contract.failing_categories.map((category) => cleanText(category)).filter(Boolean)
    : [];
  const hasRegistryDrift = failingCategories.includes("undefined_actions") || failingCategories.includes("undefined_presets");
  const hasSelectorMismatch = failingCategories.includes("selector_contract_mismatches");
  const hasGovernanceMismatch = failingCategories.includes("action_governance_mismatches");

  if (hasGovernanceMismatch && !hasRegistryDrift && !hasSelectorMismatch) {
    return "先看 planner contract failure 的 create_doc gate 模組：src/executive-planner.mjs、src/http-route-contracts.mjs、src/lark-write-guard.mjs；先對齊 source、owner、intent、type entry governance，只有 intentional stable target 才改 docs/system/planner_contract.json。";
  }

  if (hasRegistryDrift && !hasSelectorMismatch && !hasGovernanceMismatch) {
    return "先看 planner contract failure 的 registry 模組：src/executive-planner.mjs；只有 intentional stable target 才改 docs/system/planner_contract.json。";
  }

  if (hasSelectorMismatch && !hasRegistryDrift && !hasGovernanceMismatch) {
    return "先看 planner contract failure 的 route 模組：src/router.js 與 src/planner-*-flow.mjs；只有 intentional stable target 才改 docs/system/planner_contract.json。";
  }

  if (hasGovernanceMismatch) {
    return "先看 planner contract failure：src/executive-planner.mjs、src/http-route-contracts.mjs、src/lark-write-guard.mjs，必要時再對齊 docs/system/planner_contract.json。";
  }

  return "先看 planner contract failure：src/executive-planner.mjs 與 src/planner-*-flow.mjs；只有 intentional stable target 才改 docs/system/planner_contract.json。";
}

function buildFullTestFailureNextStep({ failedCommand = "" } = {}) {
  const normalizedCommand = cleanText(failedCommand);
  if (!normalizedCommand) {
    return "先修 full test gate：先在本地重跑 node --test 與 npm run test:ci，並修第一個失敗的測試或 guardrail。";
  }
  return `先修 full test gate：${normalizedCommand} 失敗；先在本地重跑 node --test 與 npm run test:ci，並修第一個失敗的測試或 guardrail。`;
}

function buildRoutingActionHint(drilldown = {}, { docBoundaryRegression = false } = {}) {
  if (docBoundaryRegression) {
    return DOC_BOUNDARY_ACTION_HINT;
  }

  const area = normalizeFailingArea(drilldown?.failing_area) || FAILING_AREA_MIXED;
  return `run routing-eval and inspect ${area} fixtures`;
}

function inferPlannerActionHintType({ suggestedNextStep = "", drilldown = {} } = {}) {
  const normalizedNextStep = cleanText(suggestedNextStep);
  const representativeCases = normalizeRepresentativeFailCases(drilldown?.representative_fail_case);

  if (
    representativeCases.some((item) => item.startsWith("selector_contract_mismatches:"))
    || normalizedNextStep.includes("route 模組")
    || normalizedNextStep.includes("src/router.js")
    || normalizedNextStep.includes("src/planner-*-flow.mjs")
  ) {
    return "selector";
  }

  if (
    representativeCases.some((item) => item.startsWith("action_governance_mismatches:"))
    || normalizedNextStep.includes("create_doc gate 模組")
    || normalizedNextStep.includes("src/http-route-contracts.mjs")
    || normalizedNextStep.includes("src/lark-write-guard.mjs")
  ) {
    return "governance";
  }

  return "contract";
}

function buildPlannerActionHint({ suggestedNextStep = "", drilldown = {} } = {}) {
  return `run planner-contract-check and fix ${inferPlannerActionHintType({
    suggestedNextStep,
    drilldown,
  })} mismatch`;
}

function buildReleaseActionHint({ blockingChecks = [], drilldown = {} } = {}) {
  const normalizedBlockingChecks = normalizeBlockingChecks(blockingChecks);
  const representativeFailCase = normalizeRepresentativeFailCases(drilldown?.representative_fail_case);

  if (normalizedBlockingChecks.length === 0 && representativeFailCase.length === 0) {
    return null;
  }

  return "inspect blocking_checks and representative_fail_case";
}

function buildReleaseCheckActionHint({
  blockingChecks = [],
  suggestedNextStep = "",
  drilldown = {},
  docBoundaryRegression = false,
} = {}) {
  const firstBlockingCheck = normalizeBlockingChecks(blockingChecks)[0] || null;

  if (firstBlockingCheck === BLOCKING_ROUTING_REGRESSION) {
    return buildRoutingActionHint(drilldown, { docBoundaryRegression });
  }
  if (firstBlockingCheck === BLOCKING_DEPENDENCY_POLICY_FAILURE) {
    return "inspect dependency guardrails and replace blocked package versions";
  }
  if (firstBlockingCheck === BLOCKING_WRITE_POLICY_FAILURE) {
    return "inspect write governance runtime and route coverage";
  }
  if (firstBlockingCheck === BLOCKING_USAGE_LAYER_FAILURE) {
    return "run eval:usage-layer and improve first-turn helpfulness while reducing generic replies";
  }
  if (firstBlockingCheck === BLOCKING_PLANNER_CONTRACT_FAILURE) {
    return buildPlannerActionHint({ suggestedNextStep, drilldown });
  }
  if (firstBlockingCheck === BLOCKING_FULL_TEST_FAILURE) {
    return "run node --test and npm run test:ci; inspect first failing suite";
  }
  if (firstBlockingCheck === BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE) {
    return "inspect company-brain lifecycle contract and apply gate";
  }
  if (firstBlockingCheck === BLOCKING_SYSTEM_REGRESSION || firstBlockingCheck === BLOCKING_CONTROL_REGRESSION) {
    return buildReleaseActionHint({ blockingChecks, drilldown });
  }
  return null;
}

function buildWriteGovernanceSummary(selfCheckResult = {}) {
  const writeSummary = selfCheckResult?.write_summary || {};
  const rolloutAdvice = writeSummary?.rollout_advice || {};
  return {
    status: cleanText(writeSummary?.status) || "fail",
    metadata_route_count: Number(writeSummary?.policy_coverage?.metadata_route_count || 0),
    enforced_route_count: Number(writeSummary?.policy_coverage?.enforced_route_count || 0),
    route_coverage_ratio: Number(writeSummary?.policy_coverage?.route_coverage_ratio || 0),
    mode_counts: writeSummary?.enforcement_modes?.mode_counts || {},
    violation_type_stats: writeSummary?.violation_type_stats || {},
    rollout_rules: rolloutAdvice?.rollout_rules || null,
    rollout_basis_summary: rolloutAdvice?.basis_summary || null,
    upgrade_ready_routes: Array.isArray(rolloutAdvice?.upgrade_ready_routes)
      ? rolloutAdvice.upgrade_ready_routes
      : [],
    high_risk_routes: Array.isArray(rolloutAdvice?.high_risk_routes)
      ? rolloutAdvice.high_risk_routes
      : [],
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

function buildReleaseRollbackCandidates(blockingChecks = []) {
  const candidates = [];
  for (const blockingCheck of normalizeBlockingChecks(blockingChecks)) {
    if (blockingCheck === BLOCKING_ROUTING_REGRESSION) {
      candidates.push("rollback latest routing rule or dataset fixture changes; rerun routing closed-loop");
      continue;
    }
    if (blockingCheck === BLOCKING_PLANNER_CONTRACT_FAILURE) {
      candidates.push("rollback latest planner contract/selector registry changes; rerun planner-contract-check");
      continue;
    }
    if (blockingCheck === BLOCKING_USAGE_LAYER_FAILURE) {
      candidates.push("rollback latest prompt/routing changes that reduced usage-layer quality");
      continue;
    }
    if (blockingCheck === BLOCKING_WRITE_POLICY_FAILURE) {
      candidates.push("rollback latest write-path integration change on canonical runtime boundaries");
      continue;
    }
    if (blockingCheck === BLOCKING_DEPENDENCY_POLICY_FAILURE) {
      candidates.push("rollback dependency lockfile updates introducing blocked versions");
      continue;
    }
    if (blockingCheck === BLOCKING_CONTROL_REGRESSION) {
      candidates.push("rollback control ownership changes in control-kernel/lane-executor");
      continue;
    }
    if (blockingCheck === BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE) {
      candidates.push("rollback company-brain lifecycle/apply gate changes");
      continue;
    }
    if (blockingCheck === BLOCKING_FULL_TEST_FAILURE) {
      candidates.push("rollback latest test-breaking change and rerun node --test plus npm run test:ci");
      continue;
    }
    if (blockingCheck === BLOCKING_SYSTEM_REGRESSION) {
      candidates.push("rollback latest system contract or route/module registration changes");
    }
  }
  return uniqValues(candidates).slice(0, 3);
}

function buildDecisionOsReadiness({
  selfCheckResult = {},
  blockingChecks = [],
  drilldown = {},
} = {}) {
  const normalizedBlockingChecks = normalizeBlockingChecks(blockingChecks);
  const normalizedDrilldown = {
    failing_area: normalizeFailingArea(drilldown?.failing_area),
    representative_fail_case: normalizeRepresentativeFailCases(drilldown?.representative_fail_case),
    drilldown_source: normalizeDrilldownSource(drilldown?.drilldown_source),
  };
  const decisionOsObservability = selfCheckResult?.decision_os_observability || {};
  const fallbackGatePassRate = normalizedBlockingChecks.length === 0 && selfCheckResult?.ok === true
    ? 1
    : clampNumber(1 - (normalizedBlockingChecks.length / 8), 0, 1);
  const observabilityGatePassRate = toFiniteNumber(decisionOsObservability?.gate_pass_rate, null);
  const gatePassRate = observabilityGatePassRate == null
    ? fallbackGatePassRate
    : clampNumber(observabilityGatePassRate, 0, 1);
  const baseGateSummary = decisionOsObservability?.gate_summary || {};
  const gateSummary = {
    total_gates: Number.isFinite(Number(baseGateSummary?.total_gates)) && Number(baseGateSummary.total_gates) > 0
      ? Number(baseGateSummary.total_gates)
      : 8,
    passed_gates: Number.isFinite(Number(baseGateSummary?.passed_gates))
      ? Number(baseGateSummary.passed_gates)
      : Math.round(gatePassRate * 8),
    failed_gates: Number.isFinite(Number(baseGateSummary?.failed_gates))
      ? Number(baseGateSummary.failed_gates)
      : Math.max(0, 8 - Math.round(gatePassRate * 8)),
  };
  const verificationFailTaxonomy = decisionOsObservability?.verification_fail_taxonomy
    && typeof decisionOsObservability.verification_fail_taxonomy === "object"
    ? decisionOsObservability.verification_fail_taxonomy
    : {
        status: "unknown",
        summary: "verification taxonomy unavailable",
        error_code_class_count: 0,
        failure_group_count: 0,
        top_regression_case_count: 0,
        error_code_class_counts: [],
        failure_group_counts: [],
        top_regression_cases: [],
      };
  const routingSignal = decisionOsObservability?.closed_loop_metrics?.routing_closed_loop
    && typeof decisionOsObservability.closed_loop_metrics.routing_closed_loop === "object"
    ? decisionOsObservability.closed_loop_metrics.routing_closed_loop
    : {
        status: cleanText(selfCheckResult?.routing_summary?.status) || "unknown",
        gate_pass: cleanText(selfCheckResult?.routing_summary?.status) === "pass"
          && selfCheckResult?.routing_summary?.compare?.has_obvious_regression !== true,
        accuracy_ratio: toFiniteNumber(selfCheckResult?.routing_summary?.latest_snapshot?.accuracy_ratio, null),
        threshold: toFiniteNumber(selfCheckResult?.routing_summary?.latest_snapshot?.threshold, null),
        has_obvious_regression: selfCheckResult?.routing_summary?.compare?.has_obvious_regression === true,
        doc_boundary_regression: selfCheckResult?.routing_summary?.doc_boundary_regression === true,
      };
  const memoryInfluenceSignal = decisionOsObservability?.closed_loop_metrics?.memory_influence
    && typeof decisionOsObservability.closed_loop_metrics.memory_influence === "object"
    ? decisionOsObservability.closed_loop_metrics.memory_influence
    : {
        status: "unknown",
        source: "not_configured",
        gate: "unknown",
        summary: "memory influence signal unavailable",
        metrics: {
          memory_hit_rate: null,
          action_changed_by_memory_rate: null,
        },
      };
  const baseScore = toFiniteNumber(decisionOsObservability?.readiness_score?.score, null);
  const scoreBeforePenalty = baseScore == null ? roundNumber(gatePassRate * 100, 2) : baseScore;
  const blockingPenalty = Math.min(40, normalizedBlockingChecks.length * 8);
  const finalScore = roundNumber(clampNumber((scoreBeforePenalty - blockingPenalty) / 100, 0, 1) * 100, 2);
  const readinessLevel = finalScore >= 85
    ? "ready"
    : finalScore >= 70
      ? "watch"
      : "at_risk";
  const blockedReasons = uniqValues([
    ...(Array.isArray(decisionOsObservability?.blocked_reasons) ? decisionOsObservability.blocked_reasons : []),
    ...normalizedBlockingChecks,
  ]);
  const regressionItems = uniqValues([
    ...blockedReasons,
    ...normalizedDrilldown.representative_fail_case,
    ...(
      Array.isArray(verificationFailTaxonomy?.top_regression_cases)
        ? verificationFailTaxonomy.top_regression_cases.slice(0, 2).map((item) => (
          `${cleanText(item?.line) || "unknown"}:${cleanText(item?.case_id) || "unknown"}`
        ))
        : []
    ),
  ]).slice(0, 5);

  return {
    version: DECISION_OS_READINESS_VERSION,
    final_score: finalScore,
    readiness_level: readinessLevel,
    gate_pass_rate: roundNumber(gatePassRate, 4),
    gate_summary: gateSummary,
    blocked_reasons: blockedReasons,
    verification_fail_taxonomy: verificationFailTaxonomy,
    closed_loop_metrics: {
      routing_closed_loop: routingSignal,
      memory_influence: memoryInfluenceSignal,
    },
    regression_items: regressionItems,
    rollback_candidates: buildReleaseRollbackCandidates(normalizedBlockingChecks),
  };
}

function hasBlockingRoutingIssue(selfCheckResult = {}) {
  return (
    cleanText(selfCheckResult?.routing_summary?.status) !== "pass"
    || selfCheckResult?.routing_summary?.compare?.has_obvious_regression === true
  );
}

function hasBlockingControlIssue(selfCheckResult = {}) {
  const controlStatus = cleanText(
    selfCheckResult?.control_summary?.status || selfCheckResult?.system_summary?.control_status,
  );
  if (!controlStatus) {
    return false;
  }
  return controlStatus !== "pass";
}

function hasBlockingWritePolicyIssue(selfCheckResult = {}) {
  const writePolicyStatus = cleanText(
    selfCheckResult?.write_summary?.status || selfCheckResult?.system_summary?.write_policy_status,
  );
  if (!writePolicyStatus) {
    return false;
  }
  return writePolicyStatus !== "pass";
}

function hasBlockingDependencyIssue(selfCheckResult = {}) {
  const dependencyStatus = cleanText(
    selfCheckResult?.dependency_summary?.status || selfCheckResult?.system_summary?.dependency_status || "pass",
  );
  return dependencyStatus !== "pass";
}

function hasBlockingUsageLayerIssue(selfCheckResult = {}) {
  const usageLayerStatus = cleanText(
    selfCheckResult?.usage_layer_summary?.status || selfCheckResult?.system_summary?.usage_layer_status,
  );
  if (!usageLayerStatus) {
    return false;
  }
  return usageLayerStatus !== "pass";
}

function hasBlockingCompanyBrainIssue(selfCheckResult = {}) {
  const companyBrainStatus = cleanText(
    selfCheckResult?.company_brain_summary?.status || selfCheckResult?.system_summary?.company_brain_status,
  );
  if (!companyBrainStatus) {
    return false;
  }
  return companyBrainStatus !== "pass";
}

function hasBlockingPlannerIssue(selfCheckResult = {}) {
  return (
    cleanText(selfCheckResult?.planner_summary?.gate) !== "pass"
    || selfCheckResult?.planner_summary?.compare?.has_obvious_regression === true
  );
}

function uniqValues(values = []) {
  return Array.from(new Set(
    values.map((value) => cleanText(value)).filter(Boolean),
  ));
}

function normalizeFailingArea(area = "") {
  const normalized = cleanText(area);
  if (
    normalized === FAILING_AREA_DOC
    || normalized === FAILING_AREA_MEETING
    || normalized === FAILING_AREA_RUNTIME
    || normalized === FAILING_AREA_MIXED
  ) {
    return normalized;
  }
  return null;
}

function coalesceFailingArea(areas = []) {
  const normalizedAreas = uniqValues(areas.map((area) => normalizeFailingArea(area)));
  if (normalizedAreas.length === 1) {
    return normalizedAreas[0];
  }
  if (normalizedAreas.length > 1) {
    return FAILING_AREA_MIXED;
  }
  return null;
}

function normalizeRepresentativeFailCases(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => cleanText(item)).filter(Boolean).slice(0, 2);
}

function normalizeBlockingChecks(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => cleanText(item)).filter(Boolean);
}

function normalizeDrilldownSource(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqValues(value);
}

function inferAreaFromPathOrIdentifier(value = "") {
  const normalized = cleanText(normalizeRepoPath(value) || value).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (
    normalized.includes("meeting")
    || normalized.includes("capture")
  ) {
    return FAILING_AREA_MEETING;
  }
  if (
    normalized.includes("runtime")
    || normalized.includes("db path")
    || normalized.includes("pid")
    || normalized.includes("cwd")
    || normalized.includes("control-kernel")
    || normalized.includes("lane-executor")
    || normalized.includes("ownership")
  ) {
    return FAILING_AREA_RUNTIME;
  }
  if (
    normalized.includes("doc")
    || normalized.includes("wiki")
    || normalized.includes("drive")
    || normalized.includes("company_brain")
    || normalized.includes("okr")
    || normalized.includes("delivery")
    || normalized.includes("bd")
    || normalized.includes("rewrite")
    || normalized.includes("learning")
  ) {
    return FAILING_AREA_DOC;
  }
  return null;
}

function buildRoutingFallbackArea(selfCheckResult = {}) {
  return normalizeFailingArea(
    selfCheckResult?.routing_summary?.diagnostics_summary?.top_category,
  ) || FAILING_AREA_MIXED;
}

function formatRoutingRepresentativeCase(miss = {}) {
  const caseId = cleanText(miss?.id) || "unknown";
  const category = normalizeFailingArea(miss?.category) || FAILING_AREA_MIXED;
  const mismatch = Array.isArray(miss?.miss_dimensions) && miss.miss_dimensions.length > 0
    ? miss.miss_dimensions.map((item) => cleanText(item)).filter(Boolean).join("+")
    : "unknown";
  const routeSource = cleanText(miss?.actual?.route_source) || "unknown";

  return `${caseId} [${category}] ${mismatch} via ${routeSource}`;
}

function buildRoutingDrilldown({ latestRoutingSnapshot = null, selfCheckResult = {} } = {}) {
  const topMissCases = Array.isArray(latestRoutingSnapshot?.run?.summary?.top_miss_cases)
    ? latestRoutingSnapshot.run.summary.top_miss_cases.slice(0, 2)
    : [];
  const representativeFailCase = topMissCases.map((miss) => formatRoutingRepresentativeCase(miss));
  const failingArea = coalesceFailingArea(topMissCases.map((miss) => miss?.category))
    || buildRoutingFallbackArea(selfCheckResult);

  return {
    failing_area: failingArea,
    representative_fail_case: representativeFailCase.length > 0
      ? representativeFailCase
      : ["routing latest snapshot unavailable or has no miss case"],
    drilldown_source: [
      RELEASE_CHECK_TRIAGE_SOURCE,
      ROUTING_DRILLDOWN_SOURCE,
    ],
  };
}

function formatControlRepresentativeIssue(issue = {}) {
  const code = cleanText(issue?.code) || "control_issue";
  const file = normalizeRepoPath(issue?.file);
  return file ? `${code} via ${file}` : code;
}

function buildControlDrilldown({ controlSnapshot = null, selfCheckResult = {} } = {}) {
  const controlSummary = controlSnapshot?.report?.control_summary || selfCheckResult?.control_summary || {};
  const issues = Array.isArray(controlSummary?.issues)
    ? controlSummary.issues.slice(0, 2)
    : [];
  const representativeFailCase = issues.map((issue) => formatControlRepresentativeIssue(issue));
  const failingArea = coalesceFailingArea(issues.map((issue) => inferAreaFromPathOrIdentifier(issue?.file)))
    || FAILING_AREA_RUNTIME;

  return {
    failing_area: failingArea,
    representative_fail_case: representativeFailCase.length > 0
      ? representativeFailCase
      : ["control diagnostics found no representative issue"],
    drilldown_source: controlSnapshot
      ? [RELEASE_CHECK_TRIAGE_SOURCE, CONTROL_DRILLDOWN_SOURCE]
      : [RELEASE_CHECK_TRIAGE_SOURCE],
  };
}

function formatPlannerRepresentativeFinding(finding = {}) {
  const findingCategory = cleanText(finding?.category) || "unknown";
  const target = cleanText(finding?.target) || "unknown";
  const sourceId = cleanText(finding?.source_id) || "unknown";
  return `${findingCategory}:${target} via ${sourceId}`;
}

function inferPlannerFindingArea(finding = {}) {
  const target = cleanText(finding?.target).toLowerCase();
  const sourceId = cleanText(finding?.source_id).toLowerCase();
  const file = cleanText(finding?.file).toLowerCase();
  const combined = `${target} ${sourceId} ${file}`;

  if (target === "create_and_list_doc" || target === "create_search_detail_list_doc") {
    return FAILING_AREA_MIXED;
  }

  return inferAreaFromPathOrIdentifier(combined) || FAILING_AREA_MIXED;
}

function buildPlannerCompareRepresentativeCases(compareSummary = {}) {
  return Object.entries(compareSummary || {})
    .filter(([, delta]) => delta?.status === "worse")
    .slice(0, 2)
    .map(([field, delta]) => (
      `${field}:${Number(delta?.previous ?? 0)}->${Number(delta?.current ?? 0)}`
    ));
}

function buildPlannerDrilldown({ plannerReport = null } = {}) {
  const orderedFindings = PLANNER_FINDING_ORDER.flatMap((category) => (
    Array.isArray(plannerReport?.findings?.[category]) ? plannerReport.findings[category] : []
  ));
  const representativeFindings = orderedFindings.slice(0, 2);
  const compareSummary = plannerReport?.compare_summary || {};
  const representativeFailCase = representativeFindings.length > 0
    ? representativeFindings.map((finding) => formatPlannerRepresentativeFinding(finding))
    : buildPlannerCompareRepresentativeCases(compareSummary);
  const failingArea = representativeFindings.length > 0
    ? coalesceFailingArea(representativeFindings.map((finding) => inferPlannerFindingArea(finding))) || FAILING_AREA_MIXED
    : FAILING_AREA_MIXED;

  return {
    failing_area: failingArea,
    representative_fail_case: representativeFailCase.length > 0
      ? representativeFailCase
      : ["planner diagnostics drift detected but no representative finding was captured"],
    drilldown_source: [
      RELEASE_CHECK_TRIAGE_SOURCE,
      PLANNER_DRILLDOWN_SOURCE,
    ],
  };
}

function buildSystemRepresentativeCase(item = {}) {
  if (item?.type === "service") {
    return `service_init_failed:${cleanText(item?.module) || "unknown"}`;
  }
  if (item?.type === "route") {
    return `route_missing:${cleanText(item?.pathname) || "unknown"}`;
  }
  if (item?.type === "agent") {
    return `agent_missing:${cleanText(item?.agent_id) || "unknown"}`;
  }
  if (item?.type === "agent_contract") {
    return `agent_contract_invalid:${cleanText(item?.agent_id) || "unknown"}`;
  }
  if (item?.type === "knowledge_subcommand") {
    return `knowledge_subcommand_missing:${cleanText(item?.subcommand) || "unknown"}`;
  }
  return "system regression detected";
}

function inferSystemCaseArea(item = {}) {
  if (item?.type === "service") {
    return inferAreaFromPathOrIdentifier(item?.module) || FAILING_AREA_MIXED;
  }
  if (item?.type === "route") {
    return inferAreaFromPathOrIdentifier(item?.pathname) || FAILING_AREA_MIXED;
  }
  return FAILING_AREA_MIXED;
}

function buildSystemDrilldown(selfCheckResult = {}) {
  const candidates = [
    ...(Array.isArray(selfCheckResult?.services)
      ? selfCheckResult.services
        .filter((item) => item?.ok !== true)
        .map((item) => ({ type: "service", module: normalizeServiceModule(item?.module) }))
      : []),
    ...(Array.isArray(selfCheckResult?.routes?.missing)
      ? selfCheckResult.routes.missing
        .map((pathname) => ({ type: "route", pathname }))
      : []),
    ...(Array.isArray(selfCheckResult?.agents?.missing)
      ? selfCheckResult.agents.missing
        .map((agentId) => ({ type: "agent", agent_id: agentId }))
      : []),
    ...(Array.isArray(selfCheckResult?.agents?.invalid_contracts)
      ? selfCheckResult.agents.invalid_contracts
        .map((item) => ({ type: "agent_contract", agent_id: item?.agent_id }))
      : []),
    ...(Array.isArray(selfCheckResult?.agents?.knowledge_subcommands_missing)
      ? selfCheckResult.agents.knowledge_subcommands_missing
        .map((subcommand) => ({ type: "knowledge_subcommand", subcommand }))
      : []),
  ].slice(0, 2);

  return {
    failing_area: coalesceFailingArea(candidates.map((item) => inferSystemCaseArea(item))) || FAILING_AREA_MIXED,
    representative_fail_case: candidates.length > 0
      ? candidates.map((item) => buildSystemRepresentativeCase(item))
      : ["system regression detected but no representative case was captured"],
    drilldown_source: [RELEASE_CHECK_TRIAGE_SOURCE],
  };
}

function buildCompanyBrainDrilldown(selfCheckResult = {}) {
  const summary = selfCheckResult?.company_brain_summary || {};
  const representativeFailCase = [
    ...(Array.isArray(summary?.failing_routes)
      ? summary.failing_routes.map((item) => `company_brain_route_contract:${cleanText(item?.pathname) || "unknown"}`)
      : []),
    ...(Array.isArray(summary?.failing_cases)
      ? summary.failing_cases.map((item) => `company_brain_apply_gate:${cleanText(item?.case_id) || "unknown"}`)
      : []),
    ...(Array.isArray(summary?.failing_transitions)
      ? summary.failing_transitions.map((item) => (
        `company_brain_transition:${cleanText(item?.from) || "unknown"}->${cleanText(item?.to) || "unknown"}`
      ))
      : []),
  ].slice(0, 2);

  return {
    failing_area: FAILING_AREA_DOC,
    representative_fail_case: representativeFailCase.length > 0
      ? representativeFailCase
      : ["company-brain lifecycle self-check failed without representative case"],
    drilldown_source: [RELEASE_CHECK_TRIAGE_SOURCE],
  };
}

function buildDependencyDrilldown(selfCheckResult = {}) {
  const dependencySummary = selfCheckResult?.dependency_summary || {};
  const representativeFailCase = [
    ...(Array.isArray(dependencySummary?.violations)
      ? dependencySummary.violations.map((item) => (
        `${cleanText(item?.package_name) || "unknown"}@${cleanText(item?.detected_version) || "unknown"} via ${cleanText(item?.lockfile_path) || "unknown"}`
      ))
      : []),
    ...(Array.isArray(dependencySummary?.errors)
      ? dependencySummary.errors.map((item) => `dependency_guardrails_error:${cleanText(item?.lockfile_path) || "unknown"}`)
      : []),
  ].slice(0, 2);

  return {
    failing_area: FAILING_AREA_RUNTIME,
    representative_fail_case: representativeFailCase.length > 0
      ? representativeFailCase
      : ["dependency guardrails failed without representative case"],
    drilldown_source: [RELEASE_CHECK_TRIAGE_SOURCE],
  };
}

function formatWriteRepresentativeIssue(issue = {}) {
  const code = cleanText(issue?.code) || "write_issue";
  const file = normalizeRepoPath(issue?.file);
  return file ? `${code} via ${file}` : code;
}

function buildWriteDrilldown(selfCheckResult = {}) {
  const writeSummary = selfCheckResult?.write_summary || {};
  const issues = Array.isArray(writeSummary?.issues)
    ? writeSummary.issues.slice(0, 2)
    : [];
  const representativeFailCase = issues.map((issue) => formatWriteRepresentativeIssue(issue));
  const failingArea = coalesceFailingArea(issues.map((issue) => inferAreaFromPathOrIdentifier(issue?.file || issue?.code)))
    || FAILING_AREA_RUNTIME;

  return {
    failing_area: failingArea,
    representative_fail_case: representativeFailCase.length > 0
      ? representativeFailCase
      : ["write governance failed without representative issue"],
    drilldown_source: [RELEASE_CHECK_TRIAGE_SOURCE],
  };
}

function buildUsageLayerDrilldown(selfCheckResult = {}) {
  const usageSummary = selfCheckResult?.usage_layer_summary || {};
  const metrics = usageSummary?.metrics || {};
  const thresholds = usageSummary?.thresholds || {};
  const representativeFailCase = [];
  const fthrTarget = Number.isFinite(Number(thresholds?.fthr_min_percent))
    ? Number(thresholds.fthr_min_percent).toFixed(0)
    : "70";
  const genericTarget = Number.isFinite(Number(thresholds?.generic_rate_max_percent))
    ? Number(thresholds.generic_rate_max_percent).toFixed(0)
    : "30";
  const fthrMetric = cleanText(metrics?.FTHR)
    || (Number.isFinite(Number(metrics?.fthr_percent)) ? `${Number(metrics.fthr_percent).toFixed(2)}%` : "unknown");
  const genericMetric = cleanText(metrics?.generic_rate)
    || (Number.isFinite(Number(metrics?.generic_rate_percent)) ? `${Number(metrics.generic_rate_percent).toFixed(2)}%` : "unknown");

  representativeFailCase.push(`usage_layer_fthr:${fthrMetric} target>=${fthrTarget}%`);
  representativeFailCase.push(`usage_layer_generic_rate:${genericMetric} target<=${genericTarget}%`);

  return {
    failing_area: FAILING_AREA_RUNTIME,
    representative_fail_case: representativeFailCase,
    drilldown_source: [RELEASE_CHECK_TRIAGE_SOURCE],
  };
}

export function buildReleaseCheckDrilldown({
  selfCheckResult = {},
  controlSnapshot = null,
  latestRoutingSnapshot = null,
  plannerReport = null,
  blockingChecks = null,
} = {}) {
  const resolvedBlockingChecks = Array.isArray(blockingChecks)
    ? blockingChecks
    : [
        ...(cleanText(selfCheckResult?.system_summary?.core_checks) !== "pass" ? [BLOCKING_SYSTEM_REGRESSION] : []),
        ...(hasBlockingControlIssue(selfCheckResult) ? [BLOCKING_CONTROL_REGRESSION] : []),
        ...(hasBlockingDependencyIssue(selfCheckResult) ? [BLOCKING_DEPENDENCY_POLICY_FAILURE] : []),
        ...(hasBlockingWritePolicyIssue(selfCheckResult) ? [BLOCKING_WRITE_POLICY_FAILURE] : []),
        ...(hasBlockingUsageLayerIssue(selfCheckResult) ? [BLOCKING_USAGE_LAYER_FAILURE] : []),
        ...(hasBlockingCompanyBrainIssue(selfCheckResult) ? [BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE] : []),
        ...(hasBlockingRoutingIssue(selfCheckResult) ? [BLOCKING_ROUTING_REGRESSION] : []),
        ...(hasBlockingPlannerIssue(selfCheckResult) ? [BLOCKING_PLANNER_CONTRACT_FAILURE] : []),
      ];
  const firstBlockingCheck = resolvedBlockingChecks[0] || null;

  if (firstBlockingCheck === BLOCKING_SYSTEM_REGRESSION) {
    return buildSystemDrilldown(selfCheckResult);
  }
  if (firstBlockingCheck === BLOCKING_CONTROL_REGRESSION) {
    return buildControlDrilldown({ controlSnapshot, selfCheckResult });
  }
  if (firstBlockingCheck === BLOCKING_DEPENDENCY_POLICY_FAILURE) {
    return buildDependencyDrilldown(selfCheckResult);
  }
  if (firstBlockingCheck === BLOCKING_WRITE_POLICY_FAILURE) {
    return buildWriteDrilldown(selfCheckResult);
  }
  if (firstBlockingCheck === BLOCKING_USAGE_LAYER_FAILURE) {
    return buildUsageLayerDrilldown(selfCheckResult);
  }
  if (firstBlockingCheck === BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE) {
    return buildCompanyBrainDrilldown(selfCheckResult);
  }
  if (firstBlockingCheck === BLOCKING_ROUTING_REGRESSION) {
    return buildRoutingDrilldown({ latestRoutingSnapshot, selfCheckResult });
  }
  if (firstBlockingCheck === BLOCKING_PLANNER_CONTRACT_FAILURE) {
    return buildPlannerDrilldown({ plannerReport });
  }
  return {
    failing_area: null,
    representative_fail_case: [],
    drilldown_source: [],
  };
}

export function buildReleaseCheckReport({ selfCheckResult = {}, drilldown = null } = {}) {
  const blockingChecks = [];

  if (cleanText(selfCheckResult?.system_summary?.core_checks) !== "pass") {
    blockingChecks.push(BLOCKING_SYSTEM_REGRESSION);
  }

  if (hasBlockingControlIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_CONTROL_REGRESSION);
  }

  if (hasBlockingDependencyIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_DEPENDENCY_POLICY_FAILURE);
  }

  if (hasBlockingWritePolicyIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_WRITE_POLICY_FAILURE);
  }

  if (hasBlockingUsageLayerIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_USAGE_LAYER_FAILURE);
  }

  if (hasBlockingCompanyBrainIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE);
  }

  if (hasBlockingRoutingIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_ROUTING_REGRESSION);
  }

  if (hasBlockingPlannerIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_PLANNER_CONTRACT_FAILURE);
  }

  const docBoundaryRegression = hasBlockingRoutingIssue(selfCheckResult)
    && (
      selfCheckResult?.doc_boundary_regression === true
      || selfCheckResult?.routing_summary?.doc_boundary_regression === true
    );
  const firstBlockingCheck = blockingChecks[0] || null;
  const suggestedNextStep = firstBlockingCheck === BLOCKING_SYSTEM_REGRESSION
    ? buildSystemRegressionNextStep(selfCheckResult)
    : firstBlockingCheck === BLOCKING_CONTROL_REGRESSION
      ? buildControlRegressionNextStep(selfCheckResult)
    : firstBlockingCheck === BLOCKING_DEPENDENCY_POLICY_FAILURE
      ? buildDependencyRegressionNextStep(selfCheckResult)
    : firstBlockingCheck === BLOCKING_WRITE_POLICY_FAILURE
      ? buildWritePolicyRegressionNextStep(selfCheckResult)
    : firstBlockingCheck === BLOCKING_USAGE_LAYER_FAILURE
      ? buildUsageLayerRegressionNextStep(selfCheckResult)
    : firstBlockingCheck === BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE
      ? buildCompanyBrainRegressionNextStep(selfCheckResult)
    : firstBlockingCheck === BLOCKING_ROUTING_REGRESSION
      ? buildRoutingRegressionNextStep(selfCheckResult)
      : firstBlockingCheck === BLOCKING_PLANNER_CONTRACT_FAILURE
        ? buildPlannerContractFailureNextStep(selfCheckResult)
        : "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。";
  const normalizedDrilldown = {
    failing_area: normalizeFailingArea(drilldown?.failing_area),
    representative_fail_case: normalizeRepresentativeFailCases(drilldown?.representative_fail_case),
    drilldown_source: normalizeDrilldownSource(drilldown?.drilldown_source),
  };
  const actionHint = buildReleaseCheckActionHint({
    blockingChecks,
    suggestedNextStep,
    drilldown: normalizedDrilldown,
    docBoundaryRegression,
  });
  const decisionOsReadiness = buildDecisionOsReadiness({
    selfCheckResult,
    blockingChecks,
    drilldown: normalizedDrilldown,
  });

  return {
    overall_status: blockingChecks.length === 0 && selfCheckResult?.ok === true ? "pass" : "fail",
    blocking_checks: blockingChecks,
    doc_boundary_regression: docBoundaryRegression,
    ...(selfCheckResult?.write_summary ? { write_governance: buildWriteGovernanceSummary(selfCheckResult) } : {}),
    suggested_next_step: suggestedNextStep,
    action_hint: actionHint,
    failing_area: normalizedDrilldown.failing_area,
    representative_fail_case: normalizedDrilldown.representative_fail_case,
    drilldown_source: normalizedDrilldown.drilldown_source,
    decision_os_readiness: decisionOsReadiness,
  };
}

export function applyFullTestGateFailureReport(report = {}, { failedCommand = "", failedExitCode = null } = {}) {
  const normalizedBlockingChecks = normalizeBlockingChecks(report?.blocking_checks);
  const blockingChecks = normalizedBlockingChecks.includes(BLOCKING_FULL_TEST_FAILURE)
    ? normalizedBlockingChecks
    : [...normalizedBlockingChecks, BLOCKING_FULL_TEST_FAILURE];
  const drilldown = {
    failing_area: normalizeFailingArea(report?.failing_area) || FAILING_AREA_RUNTIME,
    representative_fail_case: [
      `full_test_gate:${cleanText(failedCommand) || "unknown"} exit ${
        Number.isFinite(Number(failedExitCode)) ? Number(failedExitCode) : "unknown"
      }`,
    ],
    drilldown_source: normalizeDrilldownSource([
      ...(Array.isArray(report?.drilldown_source) ? report.drilldown_source : []),
      "full test gate",
    ]),
  };
  const suggestedNextStep = buildFullTestFailureNextStep({ failedCommand });
  const decisionOsReadiness = buildDecisionOsReadiness({
    selfCheckResult: {
      decision_os_observability: report?.decision_os_readiness,
      routing_summary: {
        ...(report?.decision_os_readiness?.closed_loop_metrics?.routing_closed_loop || {}),
      },
      ok: cleanText(report?.overall_status) === "pass",
    },
    blockingChecks,
    drilldown,
  });

  return {
    ...report,
    overall_status: "fail",
    blocking_checks: blockingChecks,
    suggested_next_step: suggestedNextStep,
    action_hint: buildReleaseCheckActionHint({
      blockingChecks,
      suggestedNextStep,
      drilldown,
      docBoundaryRegression: false,
    }),
    failing_area: drilldown.failing_area,
    representative_fail_case: drilldown.representative_fail_case,
    drilldown_source: drilldown.drilldown_source,
    decision_os_readiness: decisionOsReadiness,
  };
}

function renderBlockingLineLabel(blockingCheck = "") {
  if (blockingCheck === BLOCKING_SYSTEM_REGRESSION) {
    return "system regression";
  }
  if (blockingCheck === BLOCKING_CONTROL_REGRESSION) {
    return "control regression";
  }
  if (blockingCheck === BLOCKING_DEPENDENCY_POLICY_FAILURE) {
    return "dependency policy failure";
  }
  if (blockingCheck === BLOCKING_WRITE_POLICY_FAILURE) {
    return "write policy failure";
  }
  if (blockingCheck === BLOCKING_USAGE_LAYER_FAILURE) {
    return "usage-layer failure";
  }
  if (blockingCheck === BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE) {
    return "company-brain lifecycle failure";
  }
  if (blockingCheck === BLOCKING_ROUTING_REGRESSION) {
    return "routing regression";
  }
  if (blockingCheck === BLOCKING_PLANNER_CONTRACT_FAILURE) {
    return "planner contract failure";
  }
  if (blockingCheck === BLOCKING_FULL_TEST_FAILURE) {
    return "full test failure";
  }
  return "無";
}

export function renderReleaseCheckReport(report = {}) {
  const canMergeOrRelease = cleanText(report?.overall_status) === "pass" ? "可以" : "先不要";
  const firstBlockingLine = Array.isArray(report?.blocking_checks) ? report.blocking_checks[0] : null;
  const actionHint = cleanText(report?.action_hint) || "無";
  const decisionOsReadiness = report?.decision_os_readiness || {};
  const decisionOsScore = Number.isFinite(Number(decisionOsReadiness?.final_score))
    ? Number(decisionOsReadiness.final_score)
    : null;
  const decisionOsLevel = cleanText(decisionOsReadiness?.readiness_level) || "unknown";
  const decisionOsGatePassRate = Number.isFinite(Number(decisionOsReadiness?.gate_pass_rate))
    ? `${(Number(decisionOsReadiness.gate_pass_rate) * 100).toFixed(2)}%`
    : "unknown";
  const decisionOsBlockedReasons = Array.isArray(decisionOsReadiness?.blocked_reasons)
    ? decisionOsReadiness.blocked_reasons
    : [];
  const decisionOsRollbackCandidates = Array.isArray(decisionOsReadiness?.rollback_candidates)
    ? decisionOsReadiness.rollback_candidates
    : [];
  const docBoundaryNote = report?.doc_boundary_regression === true && firstBlockingLine === BLOCKING_ROUTING_REGRESSION
    ? "這是 doc-boundary 類問題，優先檢查 intent guard；"
    : "";
  const rolloutBasisSummary = report?.write_governance?.rollout_basis_summary || {};
  const upgradeReady = Array.isArray(report?.write_governance?.upgrade_ready_routes)
    ? uniqValues(report.write_governance.upgrade_ready_routes.map((route) => cleanText(route?.action) || cleanText(route?.pathname)))
    : [];
  const highRisk = Array.isArray(report?.write_governance?.high_risk_routes)
    ? uniqValues(report.write_governance.high_risk_routes.map((route) => cleanText(route?.action) || cleanText(route?.pathname)))
    : [];
  const highRiskHints = Array.isArray(report?.write_governance?.high_risk_routes)
    ? uniqValues(report.write_governance.high_risk_routes.map((route) => {
      const label = cleanText(route?.action) || cleanText(route?.pathname) || "unknown";
      const hint = cleanText(route?.risk_hint);
      return hint ? `${label}=${hint}` : "";
    }).filter(Boolean))
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
    `能否放心合併/發布：${canMergeOrRelease}`,
    `若不能，先修哪一條線：${renderBlockingLineLabel(firstBlockingLine)}`,
    `下一步：${docBoundaryNote}${actionHint}`,
    `write evidence：real_only_violation ${realOnlyLine} | rollout_basis ${rolloutBasisLine}`,
    `write rollout：ready ${upgradeReady.length > 0 ? upgradeReady.join(",") : "none"} | high_risk ${highRisk.length > 0 ? highRisk.join(",") : "none"}`,
    `write rollout risk：${highRiskHints.length > 0 ? highRiskHints.join(",") : "none"}`,
    `decision-os：score ${decisionOsScore == null ? "unknown" : decisionOsScore}/100 | level ${decisionOsLevel} | gate_pass_rate ${decisionOsGatePassRate}`,
    `decision-os blockers：${decisionOsBlockedReasons.length > 0 ? decisionOsBlockedReasons.join(",") : "none"}`,
    `decision-os rollback：${decisionOsRollbackCandidates.length > 0 ? decisionOsRollbackCandidates.join(" | ") : "none"}`,
  ].join("\n");
}

export function getReleaseCheckExitCode(report = {}) {
  return cleanText(report?.overall_status) === "pass" ? 0 : 1;
}

export function normalizeReleaseCheckStatus(report = {}) {
  return cleanText(report?.overall_status) === "pass" ? "pass" : "fail";
}

function compareStatusDirection(currentStatus = "", previousStatus = "") {
  const currentRank = Number(RELEASE_STATUS_ORDER[currentStatus] ?? RELEASE_STATUS_ORDER.fail);
  const previousRank = Number(RELEASE_STATUS_ORDER[previousStatus] ?? RELEASE_STATUS_ORDER.fail);

  if (currentRank > previousRank) {
    return "better";
  }
  if (currentRank < previousRank) {
    return "worse";
  }
  return "unchanged";
}

function hasArrayChanged(currentValue = [], previousValue = []) {
  if (currentValue.length !== previousValue.length) {
    return true;
  }

  return currentValue.some((value, index) => value !== previousValue[index]);
}

export function buildReleaseCheckCompareSummary({
  currentReport = {},
  previousReport = {},
} = {}) {
  return {
    release_status: compareStatusDirection(
      normalizeReleaseCheckStatus(currentReport),
      normalizeReleaseCheckStatus(previousReport),
    ),
    blocking_checks_changed: hasArrayChanged(
      normalizeBlockingChecks(currentReport?.blocking_checks),
      normalizeBlockingChecks(previousReport?.blocking_checks),
    ),
    suggested_next_step_changed: cleanText(currentReport?.suggested_next_step)
      !== cleanText(previousReport?.suggested_next_step),
  };
}

export async function runReleaseCheck(options = {}) {
  const selfCheckResult = await runSystemSelfCheck(options);
  let latestControlSnapshot = null;
  let latestRoutingSnapshot = null;
  let plannerReport = null;

  try {
    latestControlSnapshot = await resolveControlDiagnosticsSnapshot({
      reference: "latest",
      ...(options?.controlArchiveDir ? { baseDir: options.controlArchiveDir } : {}),
    });
  } catch {
    latestControlSnapshot = null;
  }

  try {
    latestRoutingSnapshot = await resolveRoutingDiagnosticsSnapshot({
      reference: "latest",
      ...(options?.routingArchiveDir ? { baseDir: options.routingArchiveDir } : {}),
    });
  } catch {
    latestRoutingSnapshot = null;
  }

  if (
    selfCheckResult?.routing_summary
    && selfCheckResult.routing_summary.doc_boundary_regression !== true
    && latestRoutingSnapshot?.run
  ) {
    selfCheckResult.routing_summary.doc_boundary_regression = detectDocBoundaryRoutingRegression({
      run: latestRoutingSnapshot.run,
    });
    selfCheckResult.doc_boundary_regression = selfCheckResult.routing_summary.doc_boundary_regression === true;
  }

  try {
    plannerReport = runPlannerContractConsistencyCheck();
  } catch {
    plannerReport = null;
  }

  const blockingChecks = [];
  if (cleanText(selfCheckResult?.system_summary?.core_checks) !== "pass") {
    blockingChecks.push(BLOCKING_SYSTEM_REGRESSION);
  }
  if (hasBlockingControlIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_CONTROL_REGRESSION);
  }
  if (hasBlockingDependencyIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_DEPENDENCY_POLICY_FAILURE);
  }
  if (hasBlockingWritePolicyIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_WRITE_POLICY_FAILURE);
  }
  if (hasBlockingUsageLayerIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_USAGE_LAYER_FAILURE);
  }
  if (hasBlockingCompanyBrainIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE);
  }
  if (hasBlockingRoutingIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_ROUTING_REGRESSION);
  }
  if (hasBlockingPlannerIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_PLANNER_CONTRACT_FAILURE);
  }
  const drilldown = buildReleaseCheckDrilldown({
    selfCheckResult,
    controlSnapshot: latestControlSnapshot,
    latestRoutingSnapshot,
    plannerReport,
    blockingChecks,
  });
  const report = buildReleaseCheckReport({
    selfCheckResult,
    drilldown,
  });
  const releaseCheckArchive = await archiveReleaseCheckSnapshot({
    ...(options?.releaseCheckArchiveDir ? { baseDir: options.releaseCheckArchiveDir } : {}),
    report,
  });

  return {
    report,
    self_check_result: selfCheckResult,
    release_check_archive: releaseCheckArchive,
  };
}
