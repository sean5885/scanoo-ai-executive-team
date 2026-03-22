import { cleanText } from "./message-intent-utils.mjs";
import { runSystemSelfCheck } from "./system-self-check.mjs";

const BLOCKING_SYSTEM_REGRESSION = "system_regression";
const BLOCKING_ROUTING_REGRESSION = "routing_regression";
const BLOCKING_PLANNER_CONTRACT_FAILURE = "planner_contract_failure";

function normalizeServiceModule(modulePath = "") {
  const normalized = cleanText(modulePath);
  if (!normalized) {
    return null;
  }
  return normalized.startsWith("./")
    ? `src/${normalized.slice(2)}`
    : normalized;
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

function buildRoutingRegressionNextStep(selfCheckResult = {}) {
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

  if (hasRegistryDrift && !hasSelectorMismatch) {
    return "先看 planner contract failure 的 registry 模組：src/executive-planner.mjs；只有 intentional stable target 才改 docs/system/planner_contract.json。";
  }

  if (hasSelectorMismatch && !hasRegistryDrift) {
    return "先看 planner contract failure 的 route 模組：src/router.js 與 src/planner-*-flow.mjs；只有 intentional stable target 才改 docs/system/planner_contract.json。";
  }

  return "先看 planner contract failure：src/executive-planner.mjs 與 src/planner-*-flow.mjs；只有 intentional stable target 才改 docs/system/planner_contract.json。";
}

function hasBlockingRoutingIssue(selfCheckResult = {}) {
  return (
    cleanText(selfCheckResult?.routing_summary?.status) !== "pass"
    || selfCheckResult?.routing_summary?.compare?.has_obvious_regression === true
  );
}

function hasBlockingPlannerIssue(selfCheckResult = {}) {
  return (
    cleanText(selfCheckResult?.planner_summary?.gate) !== "pass"
    || selfCheckResult?.planner_summary?.compare?.has_obvious_regression === true
  );
}

export function buildReleaseCheckReport({ selfCheckResult = {} } = {}) {
  const blockingChecks = [];

  if (cleanText(selfCheckResult?.system_summary?.core_checks) !== "pass") {
    blockingChecks.push(BLOCKING_SYSTEM_REGRESSION);
  }

  if (hasBlockingRoutingIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_ROUTING_REGRESSION);
  }

  if (hasBlockingPlannerIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_PLANNER_CONTRACT_FAILURE);
  }

  const firstBlockingCheck = blockingChecks[0] || null;
  const suggestedNextStep = firstBlockingCheck === BLOCKING_SYSTEM_REGRESSION
    ? buildSystemRegressionNextStep(selfCheckResult)
    : firstBlockingCheck === BLOCKING_ROUTING_REGRESSION
      ? buildRoutingRegressionNextStep(selfCheckResult)
      : firstBlockingCheck === BLOCKING_PLANNER_CONTRACT_FAILURE
        ? buildPlannerContractFailureNextStep(selfCheckResult)
        : "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。";

  return {
    overall_status: blockingChecks.length === 0 && selfCheckResult?.ok === true ? "pass" : "fail",
    blocking_checks: blockingChecks,
    suggested_next_step: suggestedNextStep,
  };
}

function renderBlockingLineLabel(blockingCheck = "") {
  if (blockingCheck === BLOCKING_SYSTEM_REGRESSION) {
    return "system regression";
  }
  if (blockingCheck === BLOCKING_ROUTING_REGRESSION) {
    return "routing regression";
  }
  if (blockingCheck === BLOCKING_PLANNER_CONTRACT_FAILURE) {
    return "planner contract failure";
  }
  return "無";
}

export function renderReleaseCheckReport(report = {}) {
  const canMergeOrRelease = cleanText(report?.overall_status) === "pass" ? "可以" : "先不要";
  const firstBlockingLine = Array.isArray(report?.blocking_checks) ? report.blocking_checks[0] : null;

  return [
    `能否放心合併/發布：${canMergeOrRelease}`,
    `若不能，先修哪一條線：${renderBlockingLineLabel(firstBlockingLine)}`,
  ].join("\n");
}

export function getReleaseCheckExitCode(report = {}) {
  return cleanText(report?.overall_status) === "pass" ? 0 : 1;
}

export async function runReleaseCheck(options = {}) {
  const selfCheckResult = await runSystemSelfCheck(options);
  const report = buildReleaseCheckReport({
    selfCheckResult,
  });

  return {
    report,
    self_check_result: selfCheckResult,
  };
}
