import { cleanText } from "./message-intent-utils.mjs";
import { runSystemSelfCheck } from "./system-self-check.mjs";

const BLOCKING_SELF_CHECK_BASE = "self_check_base";
const BLOCKING_ROUTING = "routing";
const BLOCKING_PLANNER = "planner";

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
    blockingChecks.push(BLOCKING_SELF_CHECK_BASE);
  }

  if (hasBlockingRoutingIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_ROUTING);
  }

  if (hasBlockingPlannerIssue(selfCheckResult)) {
    blockingChecks.push(BLOCKING_PLANNER);
  }

  const firstBlockingCheck = blockingChecks[0] || null;
  const suggestedNextStep = firstBlockingCheck === BLOCKING_SELF_CHECK_BASE
    ? "先修 self-check 基礎項目：補齊 agent / route / service 問題後，再看 routing 與 planner。"
    : firstBlockingCheck === BLOCKING_ROUTING
      ? "先修 routing 線：先看 latest snapshot 與 compare，判斷是 fixture coverage 還是 routing rule regression。"
      : firstBlockingCheck === BLOCKING_PLANNER
        ? "先修 planner 線：先看 gate，依序處理 undefined_actions、undefined_presets、selector_contract_mismatches。"
        : "目前這個入口沒有 blocking check；若要正式 release，仍需跑既有測試與發布驗證流程。";

  return {
    overall_status: blockingChecks.length === 0 && selfCheckResult?.ok === true ? "pass" : "fail",
    blocking_checks: blockingChecks,
    suggested_next_step: suggestedNextStep,
  };
}

function renderBlockingLineLabel(blockingCheck = "") {
  if (blockingCheck === BLOCKING_SELF_CHECK_BASE) {
    return "self-check 基礎項目";
  }
  if (blockingCheck === BLOCKING_ROUTING) {
    return "routing";
  }
  if (blockingCheck === BLOCKING_PLANNER) {
    return "planner";
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
