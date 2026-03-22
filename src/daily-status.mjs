import { cleanText } from "./message-intent-utils.mjs";
import { buildReleaseCheckCompareSummary } from "./release-check.mjs";
import {
  readReleaseCheckManifest,
  resolveReleaseCheckSnapshot,
} from "./release-check-history.mjs";
import {
  readSystemSelfCheckManifest,
  resolveSystemSelfCheckSnapshot,
} from "./system-self-check-history.mjs";

const ROUTING_LINE = "routing";
const PLANNER_LINE = "planner";
const RELEASE_LINE = "release";
const NO_BLOCKING_LINE = "none";
const TREND_STABLE = "stable";
const TREND_IMPROVING = "improving";
const TREND_WORSENING = "worsening";
const DEFAULT_TREND_COUNT = 5;
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

function normalizeTrend(trend = "") {
  const normalized = cleanText(trend);
  if (normalized === TREND_IMPROVING || normalized === TREND_WORSENING) {
    return normalized;
  }
  return TREND_STABLE;
}

function normalizeTrendLine(line = "") {
  const normalized = cleanText(line);
  if (normalized === ROUTING_LINE || normalized === PLANNER_LINE || normalized === RELEASE_LINE) {
    return normalized;
  }
  return NO_BLOCKING_LINE;
}

function parseTimestampMs(timestamp = null) {
  const parsed = Date.parse(timestamp || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTrendCount(value = DEFAULT_TREND_COUNT) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TREND_COUNT;
}

function buildDailyTrendScore(run = {}) {
  const routingScore = normalizeRoutingStatus(run?.routing_status) === "pass"
    ? 2
    : normalizeRoutingStatus(run?.routing_status) === "degrade"
      ? 1
      : 0;
  const plannerScore = normalizePlannerStatus(run?.planner_status) === "pass" ? 1 : 0;
  const releaseScore = normalizeReleaseStatus(run?.release_status) === "pass" ? 1 : 0;

  return routingScore + plannerScore + releaseScore;
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

function buildRoutingActionHint(reasonHint = "") {
  const area = ROUTING_REASON_HINTS.has(cleanText(reasonHint)) ? cleanText(reasonHint) : "mixed";
  return `run routing-eval and inspect ${area} fixtures`;
}

function buildPlannerActionHint(reasonHint = "") {
  const type = cleanText(reasonHint) === "selector" ? "selector" : "contract";
  return `run planner-contract-check and fix ${type} mismatch`;
}

function buildActionHint(changedLine = "", reasonHint = "") {
  if (changedLine === ROUTING_LINE) {
    return buildRoutingActionHint(reasonHint);
  }
  if (changedLine === PLANNER_LINE) {
    return buildPlannerActionHint(reasonHint);
  }
  if (changedLine === RELEASE_LINE) {
    return "inspect blocking_checks and representative_fail_case";
  }
  return null;
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
  const changeReasonHint = buildChangeReasonHint(changedLine, releaseCheckResult);

  return {
    ...report,
    changed_line: changedLine,
    change_reason_hint: changeReasonHint,
    action_hint: buildActionHint(changedLine, changeReasonHint),
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

function buildDailyStatusTrendEntry({
  releaseReport = {},
  selfCheckReport = {},
} = {}) {
  return {
    run_id: cleanText(releaseReport?.run_id) || null,
    timestamp: releaseReport?.timestamp || selfCheckReport?.timestamp || null,
    ...buildDailyStatusReport({
      report: releaseReport,
      self_check_result: selfCheckReport,
    }),
  };
}

function buildMostChangedLine(recentRuns = []) {
  const chronologicalRuns = [...recentRuns].reverse();
  const changes = {
    [ROUTING_LINE]: { count: 0, last_changed_at: -1 },
    [PLANNER_LINE]: { count: 0, last_changed_at: -1 },
    [RELEASE_LINE]: { count: 0, last_changed_at: -1 },
  };

  for (let index = 1; index < chronologicalRuns.length; index += 1) {
    const previousRun = chronologicalRuns[index - 1];
    const currentRun = chronologicalRuns[index];

    if (normalizeRoutingStatus(previousRun?.routing_status) !== normalizeRoutingStatus(currentRun?.routing_status)) {
      changes[ROUTING_LINE] = {
        count: changes[ROUTING_LINE].count + 1,
        last_changed_at: index,
      };
    }
    if (normalizePlannerStatus(previousRun?.planner_status) !== normalizePlannerStatus(currentRun?.planner_status)) {
      changes[PLANNER_LINE] = {
        count: changes[PLANNER_LINE].count + 1,
        last_changed_at: index,
      };
    }
    if (normalizeReleaseStatus(previousRun?.release_status) !== normalizeReleaseStatus(currentRun?.release_status)) {
      changes[RELEASE_LINE] = {
        count: changes[RELEASE_LINE].count + 1,
        last_changed_at: index,
      };
    }
  }

  const mostChangedLine = [ROUTING_LINE, PLANNER_LINE, RELEASE_LINE].reduce((best, line) => {
    const current = changes[line];
    if (!best) {
      return { line, ...current };
    }
    if (current.count > best.count) {
      return { line, ...current };
    }
    if (current.count === best.count && current.last_changed_at > best.last_changed_at) {
      return { line, ...current };
    }
    return best;
  }, null);

  if (!mostChangedLine || mostChangedLine.count === 0) {
    return NO_BLOCKING_LINE;
  }
  return mostChangedLine.line;
}

export function buildDailyStatusTrendSummary({
  recent_runs: recentRuns = [],
} = {}) {
  const normalizedRuns = Array.isArray(recentRuns)
    ? recentRuns.map((run) => ({
        run_id: cleanText(run?.run_id) || null,
        timestamp: run?.timestamp || null,
        routing_status: normalizeRoutingStatus(run?.routing_status),
        planner_status: normalizePlannerStatus(run?.planner_status),
        release_status: normalizeReleaseStatus(run?.release_status),
        overall_recommendation: cleanText(run?.overall_recommendation) || "check_release_first",
      }))
    : [];
  const chronologicalRuns = [...normalizedRuns].reverse();
  let improvingTransitions = 0;
  let worseningTransitions = 0;

  for (let index = 1; index < chronologicalRuns.length; index += 1) {
    const previousScore = buildDailyTrendScore(chronologicalRuns[index - 1]);
    const currentScore = buildDailyTrendScore(chronologicalRuns[index]);

    if (currentScore > previousScore) {
      improvingTransitions += 1;
    } else if (currentScore < previousScore) {
      worseningTransitions += 1;
    }
  }

  let trend = TREND_STABLE;
  if (improvingTransitions > worseningTransitions) {
    trend = TREND_IMPROVING;
  } else if (worseningTransitions > improvingTransitions) {
    trend = TREND_WORSENING;
  } else if (normalizedRuns.length >= 2) {
    const newestScore = buildDailyTrendScore(normalizedRuns[0]);
    const oldestScore = buildDailyTrendScore(normalizedRuns[normalizedRuns.length - 1]);
    if (newestScore > oldestScore) {
      trend = TREND_IMPROVING;
    } else if (newestScore < oldestScore) {
      trend = TREND_WORSENING;
    }
  }

  return {
    sample_count: normalizedRuns.length,
    trend,
    most_changed_line: buildMostChangedLine(normalizedRuns),
    recent_runs: normalizedRuns,
  };
}

function findMatchingSelfCheckEntry(releaseSnapshot = {}, selfCheckEntries = []) {
  const releaseTimestampMs = parseTimestampMs(releaseSnapshot?.timestamp);
  if (releaseTimestampMs === null) {
    return selfCheckEntries[0] || null;
  }

  const candidates = selfCheckEntries
    .map((entry, index) => ({
      entry,
      index,
      timestamp_ms: parseTimestampMs(entry?.timestamp),
    }))
    .filter((item) => item.timestamp_ms !== null && item.timestamp_ms <= releaseTimestampMs);

  if (candidates.length > 0) {
    return candidates
      .sort((left, right) => right.timestamp_ms - left.timestamp_ms)[0]
      ?.entry || null;
  }

  return selfCheckEntries[0] || null;
}

export async function readDailyStatusTrendSummary({
  count = DEFAULT_TREND_COUNT,
  releaseCheckArchiveDir,
  selfCheckArchiveDir,
} = {}) {
  const sampleCount = normalizeTrendCount(count);
  const releaseManifest = await readReleaseCheckManifest(releaseCheckArchiveDir);
  const selfCheckManifest = await readSystemSelfCheckManifest(selfCheckArchiveDir);
  const releaseEntries = Array.isArray(releaseManifest?.snapshots)
    ? releaseManifest.snapshots.slice(0, sampleCount)
    : [];
  const selfCheckEntries = Array.isArray(selfCheckManifest?.snapshots)
    ? selfCheckManifest.snapshots
    : [];

  if (releaseEntries.length === 0) {
    throw new Error(`No release-check snapshot found in ${releaseManifest?.manifest_path}`);
  }
  if (selfCheckEntries.length === 0) {
    throw new Error(`No system self-check snapshot found in ${selfCheckManifest?.manifest_path}`);
  }

  const recentRuns = [];
  for (const releaseEntry of releaseEntries) {
    const releaseRunId = cleanText(releaseEntry?.run_id);
    if (!releaseRunId) {
      continue;
    }

    const releaseSnapshot = await resolveReleaseCheckSnapshot({
      reference: releaseRunId,
      ...(releaseCheckArchiveDir ? { baseDir: releaseCheckArchiveDir } : {}),
    });
    const matchedSelfCheckEntry = findMatchingSelfCheckEntry(releaseSnapshot?.snapshot || releaseEntry, selfCheckEntries);

    if (!cleanText(matchedSelfCheckEntry?.run_id)) {
      throw new Error(`No matching system self-check snapshot found for release-check run_id: ${releaseRunId}`);
    }

    const selfCheckSnapshot = await resolveSystemSelfCheckSnapshot({
      reference: matchedSelfCheckEntry.run_id,
      ...(selfCheckArchiveDir ? { baseDir: selfCheckArchiveDir } : {}),
    });

    recentRuns.push(buildDailyStatusTrendEntry({
      releaseReport: releaseSnapshot?.report || {},
      selfCheckReport: selfCheckSnapshot?.report || {},
    }));
  }

  return buildDailyStatusTrendSummary({
    recent_runs: recentRuns,
  });
}

function renderTrendLabel(trend = "") {
  const normalized = normalizeTrend(trend);
  if (normalized === TREND_IMPROVING) {
    return "改善";
  }
  if (normalized === TREND_WORSENING) {
    return "惡化";
  }
  return "穩定";
}

export function renderDailyStatusTrendReport(trendSummary = {}) {
  return [
    `最近趨勢：${renderTrendLabel(trendSummary?.trend)}`,
    `最常變動：${renderLineLabel(normalizeTrendLine(trendSummary?.most_changed_line))}`,
  ].join("\n");
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
    `下一步：${renderReasonHintLabel(compareSummary.action_hint)}`,
  ].join("\n");
}

export function getDailyStatusExitCode(report = {}) {
  return cleanText(report?.release_status) === "pass" ? 0 : 1;
}
