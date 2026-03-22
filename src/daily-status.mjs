import { cleanText } from "./message-intent-utils.mjs";
import { buildReleaseCheckCompareSummary } from "./release-check.mjs";

const ROUTING_LINE = "routing";
const PLANNER_LINE = "planner";
const RELEASE_LINE = "release";
const NO_BLOCKING_LINE = "none";
const PLANNER_SELECTOR_CATEGORY = "selector_contract_mismatches";
const ROUTING_REASON_HINTS = new Set(["doc", "meeting", "runtime", "mixed"]);
const RELEASE_REASON_HINTS = new Set([
  "system_regression",
  "routing_regression",
  "planner_contract_failure",
]);

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

function normalizeReleaseStatus(status = "") {
  return cleanText(status) === "pass" ? "pass" : "fail";
}

function resolveFirstLineToCheck(releaseCheckResult = {}) {
  const firstBlockingCheck = Array.isArray(releaseCheckResult?.report?.blocking_checks)
    ? cleanText(releaseCheckResult.report.blocking_checks[0])
    : "";

  if (firstBlockingCheck === "routing_regression") {
    return ROUTING_LINE;
  }
  if (firstBlockingCheck === "planner_contract_failure") {
    return PLANNER_LINE;
  }
  if (firstBlockingCheck === "system_regression") {
    return RELEASE_LINE;
  }

  return normalizeReleaseStatus(releaseCheckResult?.report?.overall_status) === "pass"
    ? NO_BLOCKING_LINE
    : RELEASE_LINE;
}

function renderLineLabel(line = "") {
  if (line === ROUTING_LINE) {
    return "routing";
  }
  if (line === PLANNER_LINE) {
    return "planner";
  }
  if (line === RELEASE_LINE) {
    return "release";
  }
  return "無";
}

function renderReasonHintLabel(reasonHint = "") {
  return cleanText(reasonHint) || "無";
}

function buildOverallRecommendation(releaseCheckResult = {}) {
  const releaseStatus = normalizeReleaseStatus(releaseCheckResult?.report?.overall_status);
  const safeToDevelop = releaseCheckResult?.self_check_result?.system_summary?.safe_to_change === true;
  const firstLineToCheck = resolveFirstLineToCheck(releaseCheckResult);

  if (releaseStatus === "pass" && safeToDevelop) {
    return "safe_to_develop_merge_release";
  }
  if (firstLineToCheck === ROUTING_LINE) {
    return "check_routing_first";
  }
  if (firstLineToCheck === PLANNER_LINE) {
    return "check_planner_first";
  }
  return "check_release_first";
}

export function buildDailyStatusReport(releaseCheckResult = {}) {
  return {
    routing_status: normalizeRoutingStatus(releaseCheckResult?.self_check_result?.routing_summary?.status),
    planner_status: normalizePlannerStatus(releaseCheckResult?.self_check_result?.planner_summary?.gate),
    release_status: normalizeReleaseStatus(releaseCheckResult?.report?.overall_status),
    overall_recommendation: buildOverallRecommendation(releaseCheckResult),
  };
}

function buildRoutingChangeReasonHint(releaseCheckResult = {}) {
  const failingArea = cleanText(releaseCheckResult?.report?.failing_area);
  return ROUTING_REASON_HINTS.has(failingArea) ? failingArea : null;
}

function buildPlannerChangeReasonHint(releaseCheckResult = {}) {
  const compareSummary = releaseCheckResult?.self_check_result?.planner_summary?.compare?.compare_summary || {};
  const worseFields = Object.entries(compareSummary)
    .filter(([, item]) => cleanText(item?.status) === "worse")
    .map(([field]) => cleanText(field));

  if (worseFields.includes(PLANNER_SELECTOR_CATEGORY)) {
    return "selector";
  }
  if (worseFields.length > 0) {
    return "contract";
  }

  const failingCategories = Array.isArray(releaseCheckResult?.self_check_result?.planner_contract?.failing_categories)
    ? releaseCheckResult.self_check_result.planner_contract.failing_categories.map((item) => cleanText(item))
    : [];

  if (failingCategories.includes(PLANNER_SELECTOR_CATEGORY)) {
    return "selector";
  }
  if (failingCategories.length > 0) {
    return "contract";
  }

  return null;
}

function buildReleaseChangeReasonHint(releaseCheckResult = {}) {
  const firstBlockingCheck = Array.isArray(releaseCheckResult?.report?.blocking_checks)
    ? cleanText(releaseCheckResult.report.blocking_checks[0])
    : "";
  return RELEASE_REASON_HINTS.has(firstBlockingCheck) ? firstBlockingCheck : null;
}

function resolveChangedLine(releaseCheckResult = {}, releaseCompareSummary = {}) {
  const firstLineToCheck = resolveFirstLineToCheck(releaseCheckResult);
  const routingRegression = releaseCheckResult?.self_check_result?.routing_summary?.compare?.has_obvious_regression === true;
  const plannerRegression = releaseCheckResult?.self_check_result?.planner_summary?.compare?.has_obvious_regression === true
    || normalizePlannerStatus(releaseCheckResult?.self_check_result?.planner_summary?.gate) === "fail";
  const releaseRegression = releaseCompareSummary?.release_status === "worse"
    || releaseCompareSummary?.blocking_checks_changed === true;

  if (firstLineToCheck === ROUTING_LINE && (routingRegression || releaseRegression)) {
    return ROUTING_LINE;
  }
  if (firstLineToCheck === PLANNER_LINE && (plannerRegression || releaseRegression)) {
    return PLANNER_LINE;
  }
  if (firstLineToCheck === RELEASE_LINE && releaseRegression) {
    return RELEASE_LINE;
  }

  return NO_BLOCKING_LINE;
}

function buildChangeReasonHint(changedLine = "", releaseCheckResult = {}) {
  if (changedLine === ROUTING_LINE) {
    return buildRoutingChangeReasonHint(releaseCheckResult);
  }
  if (changedLine === PLANNER_LINE) {
    return buildPlannerChangeReasonHint(releaseCheckResult);
  }
  if (changedLine === RELEASE_LINE) {
    return buildReleaseChangeReasonHint(releaseCheckResult);
  }
  return null;
}

export function buildDailyStatusCompareSummary({
  releaseCheckResult = {},
  previousReleaseReport = {},
} = {}) {
  const report = buildDailyStatusReport(releaseCheckResult);
  const releaseCompareSummary = buildReleaseCheckCompareSummary({
    currentReport: releaseCheckResult?.report || {},
    previousReport: previousReleaseReport,
  });
  const changedLine = resolveChangedLine(releaseCheckResult, releaseCompareSummary);

  return {
    ...report,
    changed_line: changedLine,
    change_reason_hint: buildChangeReasonHint(changedLine, releaseCheckResult),
  };
}

export function buildDailyStatusHumanSummary(releaseCheckResult = {}) {
  const safeToDevelop = releaseCheckResult?.self_check_result?.system_summary?.safe_to_change === true;
  const safeToMergeOrRelease = normalizeReleaseStatus(releaseCheckResult?.report?.overall_status) === "pass";

  return {
    develop: safeToDevelop ? "可以" : "先不要",
    merge: safeToMergeOrRelease ? "可以" : "先不要",
    release: safeToMergeOrRelease ? "可以" : "先不要",
    first_line_to_check: resolveFirstLineToCheck(releaseCheckResult),
  };
}

export function renderDailyStatusReport(releaseCheckResult = {}) {
  const summary = buildDailyStatusHumanSummary(releaseCheckResult);

  return [
    `今天能不能安心開發：${summary.develop}`,
    `今天能不能安心合併：${summary.merge}`,
    `今天能不能安心發布：${summary.release}`,
    `若不能，先看哪一條線：${renderLineLabel(summary.first_line_to_check)}`,
  ].join("\n");
}

export function renderDailyStatusCompareReport({
  releaseCheckResult = {},
  previousReleaseReport = {},
} = {}) {
  const compareSummary = buildDailyStatusCompareSummary({
    releaseCheckResult,
    previousReleaseReport,
  });

  return [
    renderDailyStatusReport(releaseCheckResult),
    `為什麼變差：${renderReasonHintLabel(compareSummary.change_reason_hint)}`,
  ].join("\n");
}

export function getDailyStatusExitCode(report = {}) {
  return cleanText(report?.release_status) === "pass" ? 0 : 1;
}
