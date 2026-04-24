import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
const BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE = "company_brain_lifecycle_failure";
const BLOCKING_ROUTING_REGRESSION = "routing_regression";
const BLOCKING_PLANNER_CONTRACT_FAILURE = "planner_contract_failure";
const BLOCKING_CLOSED_LOOP_NON_REGRESSION_FAILURE = "closed_loop_non_regression_failure";
const FAILING_AREA_DOC = "doc";
const FAILING_AREA_MEETING = "meeting";
const FAILING_AREA_RUNTIME = "runtime";
const FAILING_AREA_MIXED = "mixed";
const RELEASE_CHECK_TRIAGE_SOURCE = "release-check triage";
const CONTROL_DRILLDOWN_SOURCE = "control diagnostics/history";
const ROUTING_DRILLDOWN_SOURCE = "routing-eval diagnostics/history";
const PLANNER_DRILLDOWN_SOURCE = "planner diagnostics/history";
const CLOSED_LOOP_DRILLDOWN_SOURCE = "closed-loop non-regression gate";
const DOC_BOUNDARY_ACTION_HINT = "run routing-eval doc-boundary pack and inspect message-intent-utils / lane-executor guard";
const CLOSED_LOOP_RELEASE_GATE_ID = "closed_loop_non_regression_v1";
const PLANNER_CONTRACT_FILE = fileURLToPath(new URL("../docs/system/planner_contract.json", import.meta.url));
const PLANNER_FINDING_ORDER = [
  "undefined_actions",
  "undefined_presets",
  "selector_contract_mismatches",
  "action_governance_mismatches",
  "deprecated_reachable_targets",
];
const CLOSED_LOOP_DEFAULT_GATE_CONFIG = Object.freeze({
  gate_id: CLOSED_LOOP_RELEASE_GATE_ID,
  feature_flag: {
    env: "RELEASE_CHECK_CLOSED_LOOP_NON_REGRESSION",
    default: false,
  },
  required_elements: ["memory", "retrieval", "learning", "non_regression"],
  contract_tests: [
    "planner_contract_gate",
    "planner_contract_consistency",
  ],
  snapshot_gate: {
    required_checks: [
      "routing_latest_snapshot",
      "routing_compare_available",
      "planner_latest_snapshot",
      "planner_compare_available",
    ],
  },
});
const RELEASE_STATUS_ORDER = {
  fail: 0,
  pass: 1,
};

function parseFlagBoolean(value, defaultValue = false) {
  const normalized = cleanText(value).toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "enabled") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off" || normalized === "disabled") {
    return false;
  }
  return defaultValue;
}

function resolveClosedLoopGateContract({ gateConfigOverride = null } = {}) {
  if (gateConfigOverride && typeof gateConfigOverride === "object" && !Array.isArray(gateConfigOverride)) {
    const releaseGate = gateConfigOverride?.release_gates?.[CLOSED_LOOP_RELEASE_GATE_ID];
    if (releaseGate && typeof releaseGate === "object" && !Array.isArray(releaseGate)) {
      return releaseGate;
    }
    return gateConfigOverride;
  }

  try {
    const plannerContract = JSON.parse(readFileSync(PLANNER_CONTRACT_FILE, "utf8"));
    const releaseGate = plannerContract?.release_gates?.[CLOSED_LOOP_RELEASE_GATE_ID];
    if (releaseGate && typeof releaseGate === "object" && !Array.isArray(releaseGate)) {
      return releaseGate;
    }
  } catch {
    return {};
  }

  return {};
}

function resolveClosedLoopGateConfig({ gateConfigOverride = null } = {}) {
  const contractGate = resolveClosedLoopGateContract({ gateConfigOverride });
  const featureFlagContract = contractGate?.feature_flag && typeof contractGate.feature_flag === "object"
    ? contractGate.feature_flag
    : {};
  const envName = cleanText(featureFlagContract?.env) || CLOSED_LOOP_DEFAULT_GATE_CONFIG.feature_flag.env;
  const featureFlagDefault = parseFlagBoolean(featureFlagContract?.default, CLOSED_LOOP_DEFAULT_GATE_CONFIG.feature_flag.default);
  const featureFlagEnabled = parseFlagBoolean(process.env?.[envName], featureFlagDefault);
  const requiredElements = Array.isArray(contractGate?.required_elements)
    ? contractGate.required_elements.map((item) => cleanText(item)).filter(Boolean)
    : CLOSED_LOOP_DEFAULT_GATE_CONFIG.required_elements;
  const contractTests = Array.isArray(contractGate?.contract_tests)
    ? contractGate.contract_tests.map((item) => cleanText(item)).filter(Boolean)
    : CLOSED_LOOP_DEFAULT_GATE_CONFIG.contract_tests;
  const snapshotGateRequiredChecks = Array.isArray(contractGate?.snapshot_gate?.required_checks)
    ? contractGate.snapshot_gate.required_checks.map((item) => cleanText(item)).filter(Boolean)
    : CLOSED_LOOP_DEFAULT_GATE_CONFIG.snapshot_gate.required_checks;

  return {
    gate_id: cleanText(contractGate?.gate_id) || CLOSED_LOOP_DEFAULT_GATE_CONFIG.gate_id,
    feature_flag: {
      env: envName,
      default: featureFlagDefault,
      enabled: featureFlagEnabled,
    },
    required_elements: requiredElements,
    contract_tests: contractTests,
    snapshot_gate: {
      required_checks: snapshotGateRequiredChecks,
    },
  };
}

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

function buildClosedLoopNonRegressionNextStep(closedLoopGate = {}) {
  const failingElements = Array.isArray(closedLoopGate?.failing_elements)
    ? closedLoopGate.failing_elements.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const failedContractTests = Array.isArray(closedLoopGate?.contract_tests?.failed)
    ? closedLoopGate.contract_tests.failed
    : [];
  const failedSnapshotChecks = Array.isArray(closedLoopGate?.snapshot_gate?.failed)
    ? closedLoopGate.snapshot_gate.failed
    : [];
  const failFocus = [
    ...(failingElements.length > 0 ? [`elements=${failingElements.join("/")}`] : []),
    ...(failedContractTests.length > 0 ? [`contract_tests=${failedContractTests.join("/")}`] : []),
    ...(failedSnapshotChecks.length > 0 ? [`snapshot_gate=${failedSnapshotChecks.join("/")}`] : []),
  ];
  const focusLine = failFocus.length > 0 ? `（${failFocus.join(" | ")}）` : "";
  return `先看閉環 non-regression gate${focusLine}：檢查 feature flag、planner contract test、diagnostics snapshot gate，並補齊 memory/retrieval/learning/non-regression 四要素。`;
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
  if (firstBlockingCheck === BLOCKING_PLANNER_CONTRACT_FAILURE) {
    return buildPlannerActionHint({ suggestedNextStep, drilldown });
  }
  if (firstBlockingCheck === BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE) {
    return "inspect company-brain lifecycle contract and apply gate";
  }
  if (firstBlockingCheck === BLOCKING_CLOSED_LOOP_NON_REGRESSION_FAILURE) {
    return "inspect closed-loop feature flag, contract tests, snapshot gate, and four-element evidence";
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

function evaluateClosedLoopNonRegressionGate({
  selfCheckResult = {},
  gateConfigOverride = null,
  closedLoopGateOverride = null,
} = {}) {
  if (
    closedLoopGateOverride
    && typeof closedLoopGateOverride === "object"
    && !Array.isArray(closedLoopGateOverride)
  ) {
    return closedLoopGateOverride;
  }

  const gateConfig = resolveClosedLoopGateConfig({ gateConfigOverride });
  if (gateConfig?.feature_flag?.enabled !== true) {
    return {
      gate_id: cleanText(gateConfig?.gate_id) || CLOSED_LOOP_RELEASE_GATE_ID,
      enabled: false,
      status: "disabled",
      feature_flag: gateConfig.feature_flag,
      contract_tests: {
        status: "skipped",
        required: gateConfig.contract_tests,
        failed: [],
        checks: {},
      },
      snapshot_gate: {
        status: "skipped",
        required_checks: gateConfig.snapshot_gate.required_checks,
        failed: [],
        checks: {},
      },
      elements: {
        status: "skipped",
        required: gateConfig.required_elements,
        failed: [],
        checks: {},
      },
      failing_elements: [],
      failing_checks: [],
    };
  }

  const contractChecks = {
    planner_contract_gate: selfCheckResult?.planner_contract?.gate_ok === true,
    planner_contract_consistency: selfCheckResult?.planner_contract?.consistency_ok === true,
  };
  const requiredContractChecks = Array.isArray(gateConfig.contract_tests)
    ? gateConfig.contract_tests
    : [];
  const failedContractChecks = requiredContractChecks.filter((checkId) => contractChecks[checkId] !== true);
  const contractStatus = failedContractChecks.length === 0 ? "pass" : "fail";

  const snapshotChecks = {
    routing_latest_snapshot: Boolean(cleanText(selfCheckResult?.routing_summary?.latest_snapshot?.run_id)),
    routing_compare_available: selfCheckResult?.routing_summary?.compare?.available === true,
    planner_latest_snapshot: Boolean(cleanText(selfCheckResult?.planner_summary?.latest_snapshot?.run_id)),
    planner_compare_available: selfCheckResult?.planner_summary?.compare?.available === true,
  };
  const requiredSnapshotChecks = Array.isArray(gateConfig?.snapshot_gate?.required_checks)
    ? gateConfig.snapshot_gate.required_checks
    : [];
  const failedSnapshotChecks = requiredSnapshotChecks.filter((checkId) => snapshotChecks[checkId] !== true);
  const snapshotStatus = failedSnapshotChecks.length === 0 ? "pass" : "fail";

  const elementChecks = {
    memory: {
      pass: cleanText(selfCheckResult?.planner_summary?.gate) === "pass",
      reason: "planner_summary.gate must be pass",
    },
    retrieval: {
      pass: cleanText(selfCheckResult?.routing_summary?.status) === "pass",
      reason: "routing_summary.status must be pass",
    },
    learning: {
      pass: cleanText(selfCheckResult?.company_brain_summary?.status) === "pass",
      reason: "company_brain_summary.status must be pass",
    },
    non_regression: {
      pass: (
        selfCheckResult?.routing_summary?.compare?.has_obvious_regression !== true
        && selfCheckResult?.planner_summary?.compare?.has_obvious_regression !== true
      ),
      reason: "routing/planner compare must not show obvious regression",
    },
  };
  const requiredElements = Array.isArray(gateConfig.required_elements)
    ? gateConfig.required_elements
    : [];
  const failedElements = requiredElements.filter((elementId) => elementChecks[elementId]?.pass !== true);
  const elementStatus = failedElements.length === 0 ? "pass" : "fail";

  const overallStatus = contractStatus === "pass" && snapshotStatus === "pass" && elementStatus === "pass"
    ? "pass"
    : "fail";

  return {
    gate_id: cleanText(gateConfig?.gate_id) || CLOSED_LOOP_RELEASE_GATE_ID,
    enabled: true,
    status: overallStatus,
    feature_flag: gateConfig.feature_flag,
    contract_tests: {
      status: contractStatus,
      required: requiredContractChecks,
      failed: failedContractChecks,
      checks: contractChecks,
    },
    snapshot_gate: {
      status: snapshotStatus,
      required_checks: requiredSnapshotChecks,
      failed: failedSnapshotChecks,
      checks: snapshotChecks,
    },
    elements: {
      status: elementStatus,
      required: requiredElements,
      failed: failedElements,
      checks: elementChecks,
    },
    failing_elements: failedElements,
    failing_checks: [
      ...(contractStatus === "fail" ? ["contract_tests"] : []),
      ...(snapshotStatus === "fail" ? ["snapshot_gate"] : []),
      ...failedElements.map((element) => `element:${element}`),
    ],
  };
}

function hasBlockingClosedLoopNonRegressionIssue(closedLoopGate = null) {
  return closedLoopGate?.enabled === true && cleanText(closedLoopGate?.status) !== "pass";
}

function collectBlockingChecks({
  selfCheckResult = {},
  closedLoopGate = null,
} = {}) {
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
  if (hasBlockingCompanyBrainIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE);
  }
  if (hasBlockingRoutingIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_ROUTING_REGRESSION);
  }
  if (hasBlockingPlannerIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_PLANNER_CONTRACT_FAILURE);
  }
  if (hasBlockingClosedLoopNonRegressionIssue(closedLoopGate)) {
    blockingChecks.push(BLOCKING_CLOSED_LOOP_NON_REGRESSION_FAILURE);
  }

  return blockingChecks;
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

function buildClosedLoopNonRegressionDrilldown(closedLoopGate = {}) {
  const failingElements = Array.isArray(closedLoopGate?.failing_elements)
    ? closedLoopGate.failing_elements.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const failedContractTests = Array.isArray(closedLoopGate?.contract_tests?.failed)
    ? closedLoopGate.contract_tests.failed
    : [];
  const failedSnapshotChecks = Array.isArray(closedLoopGate?.snapshot_gate?.failed)
    ? closedLoopGate.snapshot_gate.failed
    : [];
  const representativeFailCase = [
    ...(failingElements.length > 0 ? failingElements.map((item) => `closed_loop_element_failed:${item}`) : []),
    ...(failedContractTests.length > 0 ? [`closed_loop_contract_tests_failed:${failedContractTests.join(",")}`] : []),
    ...(failedSnapshotChecks.length > 0 ? [`closed_loop_snapshot_gate_failed:${failedSnapshotChecks.join(",")}`] : []),
  ].slice(0, 2);

  const failingArea = coalesceFailingArea([
    ...failingElements.map((item) => (
      item === "retrieval" || item === "learning"
        ? FAILING_AREA_DOC
        : item === "memory"
          ? FAILING_AREA_RUNTIME
          : FAILING_AREA_MIXED
    )),
    ...(failedContractTests.length > 0 ? [FAILING_AREA_MIXED] : []),
    ...(failedSnapshotChecks.length > 0 ? [FAILING_AREA_RUNTIME] : []),
  ]) || FAILING_AREA_MIXED;

  return {
    failing_area: failingArea,
    representative_fail_case: representativeFailCase.length > 0
      ? representativeFailCase
      : ["closed-loop non-regression gate failed without representative case"],
    drilldown_source: [
      RELEASE_CHECK_TRIAGE_SOURCE,
      CLOSED_LOOP_DRILLDOWN_SOURCE,
    ],
  };
}

export function buildReleaseCheckDrilldown({
  selfCheckResult = {},
  controlSnapshot = null,
  latestRoutingSnapshot = null,
  plannerReport = null,
  blockingChecks = null,
  closedLoopGate = null,
  gateConfigOverride = null,
} = {}) {
  const resolvedClosedLoopGate = evaluateClosedLoopNonRegressionGate({
    selfCheckResult,
    gateConfigOverride,
    closedLoopGateOverride: closedLoopGate,
  });
  const resolvedBlockingChecks = Array.isArray(blockingChecks)
    ? blockingChecks
    : collectBlockingChecks({
      selfCheckResult,
      closedLoopGate: resolvedClosedLoopGate,
    });
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
  if (firstBlockingCheck === BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE) {
    return buildCompanyBrainDrilldown(selfCheckResult);
  }
  if (firstBlockingCheck === BLOCKING_ROUTING_REGRESSION) {
    return buildRoutingDrilldown({ latestRoutingSnapshot, selfCheckResult });
  }
  if (firstBlockingCheck === BLOCKING_PLANNER_CONTRACT_FAILURE) {
    return buildPlannerDrilldown({ plannerReport });
  }
  if (firstBlockingCheck === BLOCKING_CLOSED_LOOP_NON_REGRESSION_FAILURE) {
    return buildClosedLoopNonRegressionDrilldown(resolvedClosedLoopGate);
  }
  return {
    failing_area: null,
    representative_fail_case: [],
    drilldown_source: [],
  };
}

export function buildReleaseCheckReport({
  selfCheckResult = {},
  drilldown = null,
  closedLoopGate = null,
  gateConfigOverride = null,
} = {}) {
  const resolvedClosedLoopGate = evaluateClosedLoopNonRegressionGate({
    selfCheckResult,
    gateConfigOverride,
    closedLoopGateOverride: closedLoopGate,
  });
  const blockingChecks = collectBlockingChecks({
    selfCheckResult,
    closedLoopGate: resolvedClosedLoopGate,
  });

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
    : firstBlockingCheck === BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE
      ? buildCompanyBrainRegressionNextStep(selfCheckResult)
    : firstBlockingCheck === BLOCKING_ROUTING_REGRESSION
      ? buildRoutingRegressionNextStep(selfCheckResult)
      : firstBlockingCheck === BLOCKING_PLANNER_CONTRACT_FAILURE
        ? buildPlannerContractFailureNextStep(selfCheckResult)
        : firstBlockingCheck === BLOCKING_CLOSED_LOOP_NON_REGRESSION_FAILURE
          ? buildClosedLoopNonRegressionNextStep(resolvedClosedLoopGate)
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

  return {
    overall_status: blockingChecks.length === 0 && selfCheckResult?.ok === true ? "pass" : "fail",
    blocking_checks: blockingChecks,
    doc_boundary_regression: docBoundaryRegression,
    ...(selfCheckResult?.write_summary ? { write_governance: buildWriteGovernanceSummary(selfCheckResult) } : {}),
    ...(resolvedClosedLoopGate?.enabled === true ? { closed_loop_non_regression: resolvedClosedLoopGate } : {}),
    suggested_next_step: suggestedNextStep,
    action_hint: actionHint,
    failing_area: normalizedDrilldown.failing_area,
    representative_fail_case: normalizedDrilldown.representative_fail_case,
    drilldown_source: normalizedDrilldown.drilldown_source,
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
  if (blockingCheck === BLOCKING_COMPANY_BRAIN_LIFECYCLE_FAILURE) {
    return "company-brain lifecycle failure";
  }
  if (blockingCheck === BLOCKING_ROUTING_REGRESSION) {
    return "routing regression";
  }
  if (blockingCheck === BLOCKING_PLANNER_CONTRACT_FAILURE) {
    return "planner contract failure";
  }
  if (blockingCheck === BLOCKING_CLOSED_LOOP_NON_REGRESSION_FAILURE) {
    return "closed-loop non-regression failure";
  }
  return "無";
}

export function renderReleaseCheckReport(report = {}) {
  const canMergeOrRelease = cleanText(report?.overall_status) === "pass" ? "可以" : "先不要";
  const firstBlockingLine = Array.isArray(report?.blocking_checks) ? report.blocking_checks[0] : null;
  const actionHint = cleanText(report?.action_hint) || "無";
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

  const closedLoopGate = evaluateClosedLoopNonRegressionGate({
    selfCheckResult,
    gateConfigOverride: options?.plannerContractOverride,
    closedLoopGateOverride: options?.closedLoopGate,
  });
  const blockingChecks = collectBlockingChecks({
    selfCheckResult,
    closedLoopGate,
  });
  const drilldown = buildReleaseCheckDrilldown({
    selfCheckResult,
    controlSnapshot: latestControlSnapshot,
    latestRoutingSnapshot,
    plannerReport,
    blockingChecks,
    closedLoopGate,
    gateConfigOverride: options?.plannerContractOverride,
  });
  const report = buildReleaseCheckReport({
    selfCheckResult,
    drilldown,
    closedLoopGate,
    gateConfigOverride: options?.plannerContractOverride,
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
