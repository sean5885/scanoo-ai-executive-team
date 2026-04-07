import { cleanText } from "./message-intent-utils.mjs";

export const WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES = Object.freeze({
  SUCCESSFUL_BUT_SLOW: "successful_but_slow",
  TIMEOUT_ACCEPTABLE: "timeout_acceptable",
  TIMEOUT_FAIL_CLOSED: "timeout_fail_closed",
  WORKFLOW_TOO_SLOW: "workflow_too_slow",
  NEEDS_FIXTURE_MOCK: "needs_fixture_mock",
  UNCLASSIFIED_TIMEOUT: "unclassified_timeout",
});

export const DEFAULT_WORKFLOW_SLOW_WARNING_MS = 3_500;

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function normalizeWorkflowTimeoutGovernanceFamily(value = "") {
  const normalized = cleanText(value || "");
  return Object.values(WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES).includes(normalized)
    ? normalized
    : null;
}

export function classifyWorkflowTimeoutGovernanceFamily({
  explicitFamily = null,
  timedOut = false,
  timeoutObserved = false,
  durationMs = null,
  slowWarningMs = DEFAULT_WORKFLOW_SLOW_WARNING_MS,
  fallbackUsed = false,
  failClosed = false,
  workflowStillRunning = false,
  needsFixtureMock = false,
} = {}) {
  const normalizedExplicitFamily = normalizeWorkflowTimeoutGovernanceFamily(explicitFamily);
  if (normalizedExplicitFamily) {
    return normalizedExplicitFamily;
  }
  if (needsFixtureMock) {
    return WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES.NEEDS_FIXTURE_MOCK;
  }
  if (workflowStillRunning) {
    return WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES.WORKFLOW_TOO_SLOW;
  }
  if (timedOut || timeoutObserved) {
    if (fallbackUsed) {
      return WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES.TIMEOUT_ACCEPTABLE;
    }
    if (failClosed) {
      return WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES.TIMEOUT_FAIL_CLOSED;
    }
    return WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES.UNCLASSIFIED_TIMEOUT;
  }
  const normalizedDurationMs = normalizeNumber(durationMs);
  const normalizedSlowWarningMs = normalizeNumber(slowWarningMs);
  if (
    normalizedDurationMs != null
    && normalizedSlowWarningMs != null
    && normalizedDurationMs >= normalizedSlowWarningMs
  ) {
    return WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES.SUCCESSFUL_BUT_SLOW;
  }
  return null;
}

export function formatWorkflowDurationMs(durationMs = null) {
  const normalizedDurationMs = normalizeNumber(durationMs);
  if (normalizedDurationMs == null) {
    return "";
  }
  if (normalizedDurationMs < 1000) {
    return `${normalizedDurationMs}ms`;
  }
  return `${(normalizedDurationMs / 1000).toFixed(normalizedDurationMs >= 10_000 ? 0 : 1)} 秒`;
}

export function buildWorkflowTimeoutGovernanceLine({
  family = null,
  workflowLabel = "這條 workflow",
  durationMs = null,
} = {}) {
  const normalizedFamily = normalizeWorkflowTimeoutGovernanceFamily(family);
  const durationLabel = formatWorkflowDurationMs(durationMs);
  if (normalizedFamily === WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES.SUCCESSFUL_BUT_SLOW) {
    return `- ${workflowLabel}這輪花了${durationLabel || "較久時間"}，屬於可接受慢路徑，結果已整理完成。`;
  }
  if (normalizedFamily === WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES.TIMEOUT_ACCEPTABLE) {
    return `- ${workflowLabel}這輪有超時，但屬於可接受慢路徑 timeout，所以我先回退到保底結果，不假裝完整複審已完成。`;
  }
  if (normalizedFamily === WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES.TIMEOUT_FAIL_CLOSED) {
    return `- ${workflowLabel}這輪超時後沒有安全保底結果，所以目前維持 fail-closed 邊界。`;
  }
  if (normalizedFamily === WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES.WORKFLOW_TOO_SLOW) {
    return `- ${workflowLabel}這輪還沒超時，但已慢到不適合再把它包裝成正常完成。`;
  }
  if (normalizedFamily === WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES.NEEDS_FIXTURE_MOCK) {
    return `- 這條 case 目前仍需要 fixture/mock 或本地帳號上下文，否則只能停在受控邊界。`;
  }
  if (normalizedFamily === WORKFLOW_TIMEOUT_GOVERNANCE_FAMILIES.UNCLASSIFIED_TIMEOUT) {
    return `- 這輪 timeout 目前還沒有被歸進明確 family，應再補分類。`;
  }
  return "";
}
