import { cleanText } from "./message-intent-utils.mjs";

const ROUTING_LINE = "routing";
const PLANNER_LINE = "planner";
const RELEASE_LINE = "release";
const NO_BLOCKING_LINE = "none";

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

export function getDailyStatusExitCode(report = {}) {
  return cleanText(report?.release_status) === "pass" ? 0 : 1;
}
