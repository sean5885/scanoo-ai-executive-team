import { readFile } from "node:fs/promises";
import path from "node:path";

import { decideIntent } from "./control-kernel.mjs";
import { getRouteContract } from "./http-route-contracts.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import {
  FALLBACK_DISABLED,
  INVALID_ACTION,
  ROUTING_NO_MATCH,
} from "./planner-error-codes.mjs";
import { buildRoutingDiagnosticsSummary } from "./routing-eval-diagnostics.mjs";
import {
  resolvePreviousRoutingDiagnosticsSnapshot,
  resolveRoutingDiagnosticsSnapshot,
} from "./routing-diagnostics-history.mjs";
import { decideWriteGuard } from "./write-guard.mjs";
import { planDocumentCreateGuard } from "./lark-write-guard.mjs";
import {
  collectWritePolicyMissingFields,
  listPhase1RouteWritePolicyFixtures,
} from "./write-policy-contract.mjs";
import {
  evaluateWritePolicyEnforcement,
  listWritePolicyEnforcementFixtures,
  WRITE_POLICY_VIOLATION_TYPES,
} from "./write-policy-enforcement.mjs";

const STATUS_ORDER = {
  fail: 0,
  degrade: 1,
  pass: 2,
};
const DIAGNOSTIC_LINE_PRIORITY = {
  control: 0,
  write: 1,
  routing: 2,
};
const DIAGNOSTIC_SOURCE_PRIORITY = {
  issue: 0,
  routing_top_miss: 1,
};
const ROUTING_DIAGNOSTIC_ERROR_CODES = new Set([
  ROUTING_NO_MATCH,
  INVALID_ACTION,
  FALLBACK_DISABLED,
]);

export const CONTROL_DIAGNOSTICS_COMPARE_FIELDS = [
  "overall_status",
  "control_status",
  "routing_status",
  "write_status",
  "control_issue_count",
  "routing_issue_count",
  "write_issue_count",
];

const ROOT_DIR = process.cwd();
const SRC_DIR = path.join(ROOT_DIR, "src");

const FILES = {
  controlKernel: path.join(SRC_DIR, "control-kernel.mjs"),
  laneExecutor: path.join(SRC_DIR, "lane-executor.mjs"),
  writeGuard: path.join(SRC_DIR, "write-guard.mjs"),
  larkWriteGuard: path.join(SRC_DIR, "lark-write-guard.mjs"),
  httpServer: path.join(SRC_DIR, "http-server.mjs"),
  httpRouteContracts: path.join(SRC_DIR, "http-route-contracts.mjs"),
  meetingAgent: path.join(SRC_DIR, "meeting-agent.mjs"),
  larkContent: path.join(SRC_DIR, "lark-content.mjs"),
  writePolicyContract: path.join(SRC_DIR, "write-policy-contract.mjs"),
};
const CLOUD_DOC_WORKFLOW = "cloud_doc";

function buildCloudDocWorkflowScopeKey({
  sessionKey = "",
  folderToken = "",
  spaceId = "",
  parentNodeToken = "",
  spaceName = "",
} = {}) {
  if (cleanText(folderToken)) {
    return `drive:${cleanText(folderToken)}`;
  }
  if (cleanText(spaceId) || cleanText(parentNodeToken) || cleanText(spaceName)) {
    return `wiki:${cleanText(spaceId) || cleanText(parentNodeToken) || cleanText(spaceName)}`;
  }
  if (cleanText(sessionKey)) {
    return `chat:${cleanText(sessionKey)}`;
  }
  return "";
}

function compareStatusDirection(currentStatus = "", previousStatus = "") {
  const currentScore = STATUS_ORDER[cleanText(currentStatus)] ?? -1;
  const previousScore = STATUS_ORDER[cleanText(previousStatus)] ?? -1;
  if (currentScore === previousScore) {
    return "same";
  }
  return currentScore > previousScore ? "better" : "worse";
}

function buildCountDelta(currentValue = 0, previousValue = 0) {
  const current = Number(currentValue || 0);
  const previous = Number(previousValue || 0);
  const delta = current - previous;
  return {
    previous,
    current,
    delta,
    status: delta === 0 ? "same" : delta < 0 ? "better" : "worse",
  };
}

function pushIssue(issues = [], condition, issue = {}) {
  if (!condition) {
    return;
  }
  issues.push({
    code: cleanText(issue?.code) || "diagnostic_issue",
    summary: cleanText(issue?.summary) || "Diagnostics issue detected.",
    file: cleanText(issue?.file) || null,
    details: issue?.details && typeof issue.details === "object" ? { ...issue.details } : null,
  });
}

function normalizeScenarioResult({
  name = "",
  ok = false,
  expected = {},
  actual = {},
  file = null,
} = {}) {
  return {
    name: cleanText(name) || "scenario",
    ok: ok === true,
    expected,
    actual,
    file: cleanText(file) || null,
  };
}

function tallyRecord(items = []) {
  const tally = {};
  for (const item of items) {
    const key = cleanText(item);
    if (!key) {
      continue;
    }
    tally[key] = Number(tally[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(tally).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeIntegrationPoint({
  name = "",
  file = "",
  ok = false,
  details = {},
} = {}) {
  return {
    name: cleanText(name) || "integration",
    file: cleanText(file) || null,
    ok: ok === true,
    details: details && typeof details === "object" ? { ...details } : {},
  };
}

async function readText(filePath = "") {
  return readFile(filePath, "utf8");
}

function buildWritePolicyRouteChecks() {
  return listPhase1RouteWritePolicyFixtures().map((fixture) => {
    const routeContract = getRouteContract(fixture.pathname);
    const actualPolicy = routeContract?.write_policy || null;
    const missingFields = collectWritePolicyMissingFields(actualPolicy);
    const actionMatches = cleanText(routeContract?.action) === cleanText(fixture.action);
    return {
      pathname: fixture.pathname,
      action: fixture.action,
      ok: actionMatches && missingFields.length === 0,
      missing_fields: missingFields,
      actual_action: cleanText(routeContract?.action) || null,
      has_write_policy: Boolean(actualPolicy),
    };
  });
}

function buildWritePolicyEnforcementRouteChecks() {
  return listWritePolicyEnforcementFixtures().map((fixture) => {
    const routeContract = getRouteContract(fixture.pathname);
    const actual = routeContract?.write_policy_enforcement || null;
    const expectedChecks = fixture.checks || {};
    const actualChecks = actual?.checks || {};
    const checksMatch = (
      expectedChecks.scope_key === actualChecks.scope_key
      && expectedChecks.idempotency_key === actualChecks.idempotency_key
      && expectedChecks.confirm_required === actualChecks.confirm_required
      && expectedChecks.review_required === actualChecks.review_required
    );
    return {
      pathname: fixture.pathname,
      action: fixture.action,
      ok: cleanText(actual?.mode) === cleanText(fixture.mode) && checksMatch,
      mode: cleanText(actual?.mode) || null,
      checks: {
        scope_key: actualChecks.scope_key === true,
        idempotency_key: actualChecks.idempotency_key === true,
        confirm_required: actualChecks.confirm_required === true,
        review_required: actualChecks.review_required === true,
      },
    };
  });
}

function buildWritePolicyCoverageSummary({
  writePolicyRouteChecks = [],
  writePolicyEnforcementRouteChecks = [],
} = {}) {
  const metadataRoutes = writePolicyRouteChecks.length;
  const enforcedRoutes = writePolicyEnforcementRouteChecks.length;
  const metadataActions = buildUniqueSorted(writePolicyRouteChecks.map((item) => item.action));
  const enforcedActions = buildUniqueSorted(writePolicyEnforcementRouteChecks.map((item) => item.action));

  return {
    metadata_route_count: metadataRoutes,
    enforced_route_count: enforcedRoutes,
    metadata_action_count: metadataActions.length,
    enforced_action_count: enforcedActions.length,
    route_coverage_ratio: metadataRoutes > 0 ? Number((enforcedRoutes / metadataRoutes).toFixed(2)) : 0,
    action_coverage_ratio: metadataActions.length > 0
      ? Number((enforcedActions.length / metadataActions.length).toFixed(2))
      : 0,
  };
}

function buildWritePolicyEnforcementModeSummary(routeChecks = []) {
  const modeCounts = tallyRecord(routeChecks.map((item) => item.mode));
  return {
    mode_counts: modeCounts,
    routes: routeChecks.map((item) => ({
      pathname: item.pathname,
      action: item.action,
      mode: item.mode,
      checks: item.checks,
    })),
  };
}

function buildWritePolicyViolationTypeStats(routeChecks = []) {
  const stats = Object.fromEntries(WRITE_POLICY_VIOLATION_TYPES.map((type) => [type, 0]));

  for (const route of routeChecks) {
    const routeContract = getRouteContract(route.pathname);
    const writePolicy = routeContract?.write_policy || {};
    const action = cleanText(route.action);
    const pathname = cleanText(route.pathname);

    if (route.checks?.scope_key === true) {
      const result = evaluateWritePolicyEnforcement({
        action,
        pathname,
        writePolicy: {
          ...writePolicy,
          scope_key: null,
        },
        confirmed: true,
        reviewCompleted: true,
        reviewRequirementActive: cleanText(writePolicy?.review_required) === "conditional",
      });
      if (result.violation_types.includes("missing_scope_key")) {
        stats.missing_scope_key += 1;
      }
    }

    if (route.checks?.idempotency_key === true) {
      const result = evaluateWritePolicyEnforcement({
        action,
        pathname,
        writePolicy: {
          ...writePolicy,
          idempotency_key: null,
        },
        confirmed: true,
        reviewCompleted: true,
        reviewRequirementActive: cleanText(writePolicy?.review_required) === "conditional",
      });
      if (result.violation_types.includes("missing_idempotency_key")) {
        stats.missing_idempotency_key += 1;
      }
    }

    if (route.checks?.confirm_required === true && writePolicy?.confirm_required === true) {
      const result = evaluateWritePolicyEnforcement({
        action,
        pathname,
        writePolicy,
        confirmed: false,
        reviewCompleted: true,
        reviewRequirementActive: cleanText(writePolicy?.review_required) === "conditional",
      });
      if (result.violation_types.includes("confirm_required")) {
        stats.confirm_required += 1;
      }
    }

    if (route.checks?.review_required === true) {
      const result = evaluateWritePolicyEnforcement({
        action,
        pathname,
        writePolicy,
        confirmed: true,
        reviewCompleted: false,
        reviewRequirementActive: cleanText(writePolicy?.review_required) === "conditional",
      });
      if (result.violation_types.includes("review_required")) {
        stats.review_required += 1;
      }
    }
  }

  return stats;
}

function countMatches(text = "", pattern) {
  if (!text) {
    return 0;
  }
  const matches = text.match(pattern);
  return Array.isArray(matches) ? matches.length : 0;
}

function extractOperationNames(text = "") {
  const matches = [...String(text || "").matchAll(/operation:\s*"([^"]+)"/g)];
  return [...new Set(matches.map((match) => cleanText(match[1])).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function buildUniqueSorted(items = []) {
  return [...new Set(items.map((item) => cleanText(item)).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizeDiagnosticsStatus(status = "") {
  return cleanText(status) || "fail";
}

function normalizeErrorCodeClass({ line = "", source = "issue", code = "" } = {}) {
  const normalizedLine = cleanText(line) || "diagnostics";
  const normalizedCode = cleanText(code) || "diagnostic_issue";
  const prefix = normalizedCode.split(":")[0] || normalizedCode;

  if (source === "routing_top_miss") {
    return `routing_top_miss:${normalizedCode}`;
  }

  return prefix.startsWith(`${normalizedLine}_`)
    ? prefix
    : `${normalizedLine}:${prefix}`;
}

function normalizeFailureGroup({ line = "", source = "issue", code = "" } = {}) {
  const normalizedLine = cleanText(line) || "diagnostics";
  const normalizedCode = cleanText(code) || "diagnostic_issue";
  const prefix = normalizedCode.split(":")[0] || normalizedCode;

  if (source === "routing_top_miss") {
    return "routing:top_miss_cases";
  }
  if (prefix.endsWith("_scenario_failed")) {
    return `${normalizedLine}:deterministic_scenarios`;
  }
  if (prefix.endsWith("_integration_missing")) {
    return `${normalizedLine}:integration_surface`;
  }
  if (prefix === "routing_snapshot_missing") {
    return "routing:snapshot_history";
  }
  if (prefix === "routing_accuracy_below_threshold") {
    return "routing:accuracy_threshold";
  }
  if (prefix === "routing_compare_regression") {
    return "routing:compare_regression";
  }
  if (prefix === "routing_doc_boundary_regression") {
    return "routing:doc_boundary";
  }
  if (prefix === "routing_decision_requires_review") {
    return "routing:decision_review";
  }
  return `${normalizedLine}:other`;
}

function extractRoutingMissErrorCode(miss = {}) {
  const candidates = [
    cleanText(miss?.actual?.planner_action),
    cleanText(miss?.expected?.planner_action),
    cleanText(miss?.actual?.agent_or_tool).replace(/^error:/, ""),
    cleanText(miss?.expected?.agent_or_tool).replace(/^error:/, ""),
  ].filter(Boolean);

  return candidates.find((candidate) => ROUTING_DIAGNOSTIC_ERROR_CODES.has(candidate)) || null;
}

function buildRoutingMissSummary(miss = {}) {
  const caseId = cleanText(miss?.id) || "routing-miss";
  const category = cleanText(miss?.category) || "mixed";
  const mismatch = Array.isArray(miss?.miss_dimensions) && miss.miss_dimensions.length > 0
    ? miss.miss_dimensions.map((item) => cleanText(item)).filter(Boolean).join("+")
    : "unknown";
  const routeSource = cleanText(miss?.actual?.route_source) || "unknown";

  return `${caseId} [${category}] ${mismatch} via ${routeSource}`;
}

function buildDiagnosticsIssueEntry({ line = "", status = "", issue = {} } = {}) {
  const code = cleanText(issue?.code) || `${cleanText(line) || "diagnostics"}_issue`;
  const normalizedLine = cleanText(line) || "diagnostics";
  return {
    line: normalizedLine,
    status: normalizeDiagnosticsStatus(status),
    source: "issue",
    case_id: code,
    code,
    summary: cleanText(issue?.summary) || code,
    file: cleanText(issue?.file) || null,
    error_code_class: normalizeErrorCodeClass({
      line: normalizedLine,
      source: "issue",
      code,
    }),
    failure_group: normalizeFailureGroup({
      line: normalizedLine,
      source: "issue",
      code,
    }),
  };
}

function buildRoutingTopMissEntry({ miss = {}, status = "", file = null } = {}) {
  const errorCode = extractRoutingMissErrorCode(miss) || "unknown";
  return {
    line: "routing",
    status: normalizeDiagnosticsStatus(status || "degrade"),
    source: "routing_top_miss",
    case_id: cleanText(miss?.id) || "routing-miss",
    code: cleanText(errorCode) || "unknown",
    summary: buildRoutingMissSummary(miss),
    file: cleanText(file) || null,
    error_code_class: normalizeErrorCodeClass({
      line: "routing",
      source: "routing_top_miss",
      code: errorCode,
    }),
    failure_group: normalizeFailureGroup({
      line: "routing",
      source: "routing_top_miss",
      code: errorCode,
    }),
  };
}

function buildDiagnosticsEntries({
  controlSummary = {},
  routingSummary = {},
  writeSummary = {},
} = {}) {
  const entries = [];

  for (const issue of Array.isArray(controlSummary?.issues) ? controlSummary.issues : []) {
    entries.push(buildDiagnosticsIssueEntry({
      line: "control",
      status: controlSummary?.status,
      issue,
    }));
  }

  for (const issue of Array.isArray(writeSummary?.issues) ? writeSummary.issues : []) {
    entries.push(buildDiagnosticsIssueEntry({
      line: "write",
      status: writeSummary?.status,
      issue,
    }));
  }

  for (const issue of Array.isArray(routingSummary?.issues) ? routingSummary.issues : []) {
    entries.push(buildDiagnosticsIssueEntry({
      line: "routing",
      status: routingSummary?.status,
      issue,
    }));
  }

  const topMissCases = Array.isArray(routingSummary?.diagnostics_summary?.top_miss_cases)
    ? routingSummary.diagnostics_summary.top_miss_cases.slice(0, 3)
    : [];
  const shouldIncludeRoutingMisses = cleanText(routingSummary?.status) !== "pass"
    || Number(routingSummary?.issue_count || 0) > 0;

  if (shouldIncludeRoutingMisses) {
    for (const miss of topMissCases) {
      entries.push(buildRoutingTopMissEntry({
        miss,
        status: routingSummary?.status,
        file: routingSummary?.latest_snapshot?.snapshot_path,
      }));
    }
  }

  return entries;
}

function buildErrorCodeClasses(entries = []) {
  const groups = new Map();

  for (const entry of entries) {
    const key = cleanText(entry?.error_code_class);
    if (!key) {
      continue;
    }
    const existing = groups.get(key) || {
      class_key: key,
      line: cleanText(entry?.line) || "diagnostics",
      status: normalizeDiagnosticsStatus(entry?.status),
      count: 0,
      source_types: [],
      sample_codes: [],
    };
    existing.count += 1;
    existing.status = normalizeDiagnosticsStatus(existing.status);
    existing.source_types = buildUniqueSorted([...existing.source_types, entry?.source]);
    existing.sample_codes = buildUniqueSorted([...existing.sample_codes, entry?.code]).slice(0, 3);
    groups.set(key, existing);
  }

  return [...groups.values()].sort((left, right) => (
    (DIAGNOSTIC_LINE_PRIORITY[left.line] ?? Number.MAX_SAFE_INTEGER)
    - (DIAGNOSTIC_LINE_PRIORITY[right.line] ?? Number.MAX_SAFE_INTEGER)
    || (STATUS_ORDER[left.status] ?? Number.MAX_SAFE_INTEGER)
      - (STATUS_ORDER[right.status] ?? Number.MAX_SAFE_INTEGER)
    || Number(right.count || 0) - Number(left.count || 0)
    || left.class_key.localeCompare(right.class_key)
  ));
}

function buildFailureGroups(entries = []) {
  const groups = new Map();

  for (const entry of entries) {
    const key = cleanText(entry?.failure_group);
    if (!key) {
      continue;
    }
    const existing = groups.get(key) || {
      group_key: key,
      line: cleanText(entry?.line) || "diagnostics",
      status: normalizeDiagnosticsStatus(entry?.status),
      count: 0,
      error_code_classes: [],
      sample_cases: [],
      files: [],
    };
    existing.count += 1;
    existing.status = normalizeDiagnosticsStatus(existing.status);
    existing.error_code_classes = buildUniqueSorted([
      ...existing.error_code_classes,
      entry?.error_code_class,
    ]).slice(0, 5);
    existing.sample_cases = buildUniqueSorted([
      ...existing.sample_cases,
      entry?.case_id,
    ]).slice(0, 3);
    existing.files = buildUniqueSorted([
      ...existing.files,
      entry?.file,
    ]).slice(0, 3);
    groups.set(key, existing);
  }

  return [...groups.values()].sort((left, right) => (
    (DIAGNOSTIC_LINE_PRIORITY[left.line] ?? Number.MAX_SAFE_INTEGER)
    - (DIAGNOSTIC_LINE_PRIORITY[right.line] ?? Number.MAX_SAFE_INTEGER)
    || (STATUS_ORDER[left.status] ?? Number.MAX_SAFE_INTEGER)
      - (STATUS_ORDER[right.status] ?? Number.MAX_SAFE_INTEGER)
    || Number(right.count || 0) - Number(left.count || 0)
    || left.group_key.localeCompare(right.group_key)
  ));
}

function buildTopRegressionCases(entries = []) {
  return [...entries]
    .sort((left, right) => (
      (DIAGNOSTIC_LINE_PRIORITY[left.line] ?? Number.MAX_SAFE_INTEGER)
      - (DIAGNOSTIC_LINE_PRIORITY[right.line] ?? Number.MAX_SAFE_INTEGER)
      || (DIAGNOSTIC_SOURCE_PRIORITY[left.source] ?? Number.MAX_SAFE_INTEGER)
        - (DIAGNOSTIC_SOURCE_PRIORITY[right.source] ?? Number.MAX_SAFE_INTEGER)
      || (STATUS_ORDER[left.status] ?? Number.MAX_SAFE_INTEGER)
        - (STATUS_ORDER[right.status] ?? Number.MAX_SAFE_INTEGER)
      || left.case_id.localeCompare(right.case_id)
      || left.summary.localeCompare(right.summary)
    ))
    .slice(0, 5)
    .map((entry, index) => ({
      rank: index + 1,
      line: entry.line,
      status: entry.status,
      source: entry.source,
      case_id: entry.case_id,
      code: entry.code,
      summary: entry.summary,
      file: entry.file,
      error_code_class: entry.error_code_class,
      failure_group: entry.failure_group,
    }));
}

export function buildDiagnosticsReportingSummary({
  controlSummary = {},
  routingSummary = {},
  writeSummary = {},
} = {}) {
  const entries = buildDiagnosticsEntries({
    controlSummary,
    routingSummary,
    writeSummary,
  });
  const errorCodeClasses = buildErrorCodeClasses(entries);
  const failureGroups = buildFailureGroups(entries);
  const topRegressionCases = buildTopRegressionCases(entries);

  return {
    error_code_class_count: errorCodeClasses.length,
    failure_group_count: failureGroups.length,
    top_regression_case_count: topRegressionCases.length,
    error_code_classes: errorCodeClasses,
    failure_groups: failureGroups,
    top_regression_cases: topRegressionCases,
  };
}

function withEnv(values = {}, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return callback();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export async function buildControlSummary() {
  const laneExecutorText = await readText(FILES.laneExecutor);
  const sameScopeKey = buildCloudDocWorkflowScopeKey({ folderToken: "fld-control" });
  const otherScopeKey = buildCloudDocWorkflowScopeKey({ folderToken: "fld-other" });

  const scenarios = [
    (() => {
      const actual = decideIntent({
        text: "/cmo 規劃本季主題",
        lane: "personal-assistant",
        activeTask: {
          id: "task-exec-command",
          workflow: "executive",
          status: "active",
        },
      });
      const ok = actual.decision === "explicit_executive_intent"
        && actual.precedence_source === "explicit_intent"
        && actual.final_owner === "executive";
      return normalizeScenarioResult({
        name: "explicit_executive_intent_takes_control",
        ok,
        expected: {
          decision: "explicit_executive_intent",
          precedence_source: "explicit_intent",
          final_owner: "executive",
        },
        actual: {
          decision: actual.decision,
          precedence_source: actual.precedence_source,
          final_owner: actual.final_owner,
        },
        file: FILES.controlKernel,
      });
    })(),
    (() => {
      const actual = decideIntent({
        text: "請繼續改這份文件",
        lane: "personal-assistant",
        activeTask: {
          id: "task-doc-rewrite",
          workflow: "doc_rewrite",
          status: "active",
        },
      });
      const ok = actual.decision === "continue_active_workflow"
        && actual.precedence_source === "same_session_same_workflow"
        && actual.final_owner === "doc-editor";
      return normalizeScenarioResult({
        name: "doc_rewrite_follow_up_stays_on_doc_editor",
        ok,
        expected: {
          decision: "continue_active_workflow",
          precedence_source: "same_session_same_workflow",
          final_owner: "doc-editor",
        },
        actual: {
          decision: actual.decision,
          precedence_source: actual.precedence_source,
          final_owner: actual.final_owner,
        },
        file: FILES.controlKernel,
      });
    })(),
    (() => {
      const actual = decideIntent({
        text: "好的，幫我看同一批文檔",
        lane: "personal-assistant",
        activeTask: {
          id: "task-cloud-same-scope",
          workflow: CLOUD_DOC_WORKFLOW,
          status: "active",
          meta: {
            scope_key: sameScopeKey,
          },
        },
        cloudDocScopeKey: sameScopeKey,
      });
      const ok = actual.decision === "continue_active_workflow"
        && actual.precedence_source === "same_session_same_workflow_same_scope"
        && actual.guard.same_scope === true
        && actual.final_owner === "personal-assistant";
      return normalizeScenarioResult({
        name: "cloud_doc_follow_up_requires_same_scope_to_continue",
        ok,
        expected: {
          decision: "continue_active_workflow",
          precedence_source: "same_session_same_workflow_same_scope",
          same_scope: true,
          final_owner: "personal-assistant",
        },
        actual: {
          decision: actual.decision,
          precedence_source: actual.precedence_source,
          same_scope: actual.guard.same_scope,
          final_owner: actual.final_owner,
        },
        file: FILES.controlKernel,
      });
    })(),
    (() => {
      const actual = decideIntent({
        text: "好的，現在請告訴我還有什麼內容是需要我二次做確認的",
        lane: "personal-assistant",
        activeTask: {
          id: "task-cloud-mismatch",
          workflow: CLOUD_DOC_WORKFLOW,
          status: "active",
          meta: {
            scope_key: sameScopeKey,
          },
        },
        cloudDocScopeKey: otherScopeKey,
      });
      const ok = actual.decision === "lane_default"
        && actual.precedence_source === "lane_default"
        && actual.guard.same_scope === false
        && actual.final_owner === "personal-assistant";
      return normalizeScenarioResult({
        name: "cloud_doc_scope_mismatch_falls_back_to_lane_default",
        ok,
        expected: {
          decision: "lane_default",
          precedence_source: "lane_default",
          same_scope: false,
          final_owner: "personal-assistant",
        },
        actual: {
          decision: actual.decision,
          precedence_source: actual.precedence_source,
          same_scope: actual.guard.same_scope,
          final_owner: actual.final_owner,
        },
        file: FILES.controlKernel,
      });
    })(),
    (() => {
      const actual = decideIntent({
        text: "幫我整理一下目前進度",
        lane: "personal-assistant",
        activeTask: {
          id: "task-executive-followup",
          workflow: "executive",
          status: "active",
        },
      });
      const ok = actual.decision === "continue_active_workflow"
        && actual.precedence_source === "same_session_same_workflow"
        && actual.final_owner === "executive";
      return normalizeScenarioResult({
        name: "active_executive_task_keeps_follow_up_ownership",
        ok,
        expected: {
          decision: "continue_active_workflow",
          precedence_source: "same_session_same_workflow",
          final_owner: "executive",
        },
        actual: {
          decision: actual.decision,
          precedence_source: actual.precedence_source,
          final_owner: actual.final_owner,
        },
        file: FILES.controlKernel,
      });
    })(),
  ];

  const integrationPoints = [
    normalizeIntegrationPoint({
      name: "lane_executor_decide_intent_callsite",
      file: FILES.laneExecutor,
      ok: laneExecutorText.includes("const routingDecision = decideIntent({"),
      details: {
        decide_intent_calls: countMatches(laneExecutorText, /decideIntent\(\{/g),
      },
    }),
    normalizeIntegrationPoint({
      name: "lane_executor_control_kernel_log",
      file: FILES.laneExecutor,
      ok: laneExecutorText.includes("logger.info(\"control_kernel_decision\", routingDecision);"),
      details: {
        control_kernel_logs: countMatches(laneExecutorText, /control_kernel_decision/g),
      },
    }),
    normalizeIntegrationPoint({
      name: "lane_executor_owner_assertions",
      file: FILES.laneExecutor,
      ok: laneExecutorText.includes("assertRoutingDecisionFinalOwner(routingDecision)")
        && laneExecutorText.includes("assertRoutingDecisionOwner({ expected: expectedOwner"),
      details: {
        final_owner_assertions: countMatches(laneExecutorText, /assertRoutingDecisionFinalOwner\(/g),
        owner_match_assertions: countMatches(laneExecutorText, /assertRoutingDecisionOwner\(/g),
      },
    }),
  ];

  const issues = [];
  for (const scenario of scenarios) {
    pushIssue(issues, scenario.ok !== true, {
      code: `control_scenario_failed:${scenario.name}`,
      summary: `Control scenario failed: ${scenario.name}`,
      file: scenario.file,
      details: {
        expected: scenario.expected,
        actual: scenario.actual,
      },
    });
  }
  for (const integration of integrationPoints) {
    pushIssue(issues, integration.ok !== true, {
      code: `control_integration_missing:${integration.name}`,
      summary: `Control integration missing: ${integration.name}`,
      file: integration.file,
      details: integration.details,
    });
  }

  return {
    status: issues.length === 0 ? "pass" : "fail",
    issue_count: issues.length,
    summary: issues.length === 0
      ? "control kernel decisions and lane-executor integration are stable"
      : "control kernel decision surface or lane-executor integration drift detected",
    guidance: issues.length === 0
      ? "Keep `src/control-kernel.mjs` and `src/lane-executor.mjs` aligned; no control repair is needed."
      : "Inspect `src/control-kernel.mjs` and `src/lane-executor.mjs` first; fix control ownership or same-scope drift before changing downstream workflow behavior.",
    scenario_results: scenarios,
    decision_counts: tallyRecord(scenarios.map((item) => item.actual?.decision)),
    precedence_counts: tallyRecord(scenarios.map((item) => item.actual?.precedence_source)),
    owner_counts: tallyRecord(scenarios.map((item) => item.actual?.final_owner)),
    integration_points: integrationPoints,
    issues,
  };
}

function buildWriteGuardScenarios() {
  return [
    (() => {
      const actual = decideWriteGuard({
        externalWrite: false,
        confirmed: false,
        preview: true,
        verifierCompleted: false,
      });
      const ok = actual.allow === true && actual.reason === "internal_write";
      return normalizeScenarioResult({
        name: "internal_write_allowed",
        ok,
        expected: {
          allow: true,
          reason: "internal_write",
        },
        actual: {
          allow: actual.allow,
          reason: actual.reason,
          error_code: actual.error_code,
        },
        file: FILES.writeGuard,
      });
    })(),
    (() => {
      const actual = decideWriteGuard({
        externalWrite: true,
        confirmed: true,
        preview: true,
        verifierCompleted: true,
      });
      const ok = actual.allow === false && actual.reason === "preview_write_blocked";
      return normalizeScenarioResult({
        name: "preview_external_write_denied",
        ok,
        expected: {
          allow: false,
          reason: "preview_write_blocked",
        },
        actual: {
          allow: actual.allow,
          reason: actual.reason,
          error_code: actual.error_code,
        },
        file: FILES.writeGuard,
      });
    })(),
    (() => {
      const actual = decideWriteGuard({
        externalWrite: true,
        confirmed: false,
        verifierCompleted: true,
      });
      const ok = actual.allow === false && actual.reason === "confirmation_required";
      return normalizeScenarioResult({
        name: "external_write_requires_confirmation",
        ok,
        expected: {
          allow: false,
          reason: "confirmation_required",
        },
        actual: {
          allow: actual.allow,
          reason: actual.reason,
          error_code: actual.error_code,
        },
        file: FILES.writeGuard,
      });
    })(),
    (() => {
      const actual = decideWriteGuard({
        externalWrite: true,
        confirmed: true,
        verifierCompleted: false,
      });
      const ok = actual.allow === false && actual.reason === "verifier_incomplete";
      return normalizeScenarioResult({
        name: "external_write_requires_verifier_completion",
        ok,
        expected: {
          allow: false,
          reason: "verifier_incomplete",
        },
        actual: {
          allow: actual.allow,
          reason: actual.reason,
          error_code: actual.error_code,
        },
        file: FILES.writeGuard,
      });
    })(),
    (() => {
      const actual = decideWriteGuard({
        externalWrite: true,
        confirmed: true,
        verifierCompleted: true,
      });
      const ok = actual.allow === true && actual.reason === "allowed";
      return normalizeScenarioResult({
        name: "external_write_allowed_after_confirmation_and_verifier",
        ok,
        expected: {
          allow: true,
          reason: "allowed",
        },
        actual: {
          allow: actual.allow,
          reason: actual.reason,
          error_code: actual.error_code,
        },
        file: FILES.writeGuard,
      });
    })(),
  ];
}

function buildLarkCreateGuardScenarios() {
  return [
    (() => {
      const actual = withEnv({
        NODE_ENV: null,
        ALLOW_LARK_WRITES: null,
        LARK_WRITE_SANDBOX_FOLDER_TOKEN: null,
      }, () => planDocumentCreateGuard({
        title: "Ops Runbook",
        confirmed: true,
        requireConfirmation: true,
      }));
      const ok = actual.ok === false && actual.error === "lark_writes_disabled";
      return normalizeScenarioResult({
        name: "lark_create_blocked_by_default",
        ok,
        expected: {
          ok: false,
          error: "lark_writes_disabled",
        },
        actual: {
          ok: actual.ok,
          error: actual.error,
        },
        file: FILES.larkWriteGuard,
      });
    })(),
    (() => {
      const actual = withEnv({
        NODE_ENV: null,
        ALLOW_LARK_WRITES: "true",
        LARK_WRITE_REQUIRE_CONFIRM: "true",
      }, () => planDocumentCreateGuard({
        title: "Ops Runbook",
        confirmed: false,
        requireConfirmation: true,
      }));
      const ok = actual.ok === false && actual.error === "lark_write_confirmation_required";
      return normalizeScenarioResult({
        name: "lark_create_requires_confirmation_when_enabled",
        ok,
        expected: {
          ok: false,
          error: "lark_write_confirmation_required",
        },
        actual: {
          ok: actual.ok,
          error: actual.error,
        },
        file: FILES.larkWriteGuard,
      });
    })(),
    (() => {
      const actual = withEnv({
        NODE_ENV: null,
        ALLOW_LARK_WRITES: "true",
        LARK_WRITE_SANDBOX_FOLDER_TOKEN: "sandbox-folder",
      }, () => planDocumentCreateGuard({
        title: "Planner Tool Success Verify",
        requestedFolderToken: "prod-folder",
        confirmed: true,
        requireConfirmation: true,
      }));
      const ok = actual.ok === true && actual.classification?.demo_like === true && actual.resolved_folder_token === "sandbox-folder";
      return normalizeScenarioResult({
        name: "demo_like_create_redirects_to_sandbox",
        ok,
        expected: {
          ok: true,
          demo_like: true,
          resolved_folder_token: "sandbox-folder",
        },
        actual: {
          ok: actual.ok,
          demo_like: actual.classification?.demo_like === true,
          resolved_folder_token: actual.resolved_folder_token,
        },
        file: FILES.larkWriteGuard,
      });
    })(),
  ];
}

export async function buildWriteSummary() {
  const writeGuardText = await readText(FILES.writeGuard);
  const httpServerText = await readText(FILES.httpServer);
  const httpRouteContractsText = await readText(FILES.httpRouteContracts);
  const meetingAgentText = await readText(FILES.meetingAgent);
  const larkContentText = await readText(FILES.larkContent);
  const writePolicyContractText = await readText(FILES.writePolicyContract);

  const writeGuardScenarios = buildWriteGuardScenarios();
  const larkCreateGuardScenarios = buildLarkCreateGuardScenarios();
  const scenarioResults = [
    ...writeGuardScenarios,
    ...larkCreateGuardScenarios,
  ];

  const guardedOperations = [
    ...extractOperationNames(httpServerText),
    ...extractOperationNames(meetingAgentText),
  ].filter(Boolean);
  const uniqueGuardedOperations = [...new Set(guardedOperations)].sort((left, right) => left.localeCompare(right));
  const expectedGuardedOperations = [
    "document_comment_rewrite_apply",
    "document_company_brain_ingest",
    "drive_organize_apply",
    "meeting_confirm_write",
    "wiki_organize_apply",
  ];
  const writePolicyRouteChecks = buildWritePolicyRouteChecks();
  const writePolicyEnforcementRouteChecks = buildWritePolicyEnforcementRouteChecks();
  const writePolicyCoverage = buildWritePolicyCoverageSummary({
    writePolicyRouteChecks,
    writePolicyEnforcementRouteChecks,
  });
  const writePolicyEnforcementModes = buildWritePolicyEnforcementModeSummary(writePolicyEnforcementRouteChecks);
  const writePolicyViolationTypeStats = buildWritePolicyViolationTypeStats(writePolicyEnforcementRouteChecks);
  const uniquePolicyActions = buildUniqueSorted(writePolicyRouteChecks.map((item) => item.action));
  const writePolicyLogReferences =
    countMatches(httpServerText, /write_policy:/g)
    + countMatches(meetingAgentText, /write_policy:/g);

  const integrationPoints = [
    normalizeIntegrationPoint({
      name: "write_guard_runtime_log_surface",
      file: FILES.writeGuard,
      ok: writeGuardText.includes("write_guard_decision"),
      details: {
        log_events: countMatches(writeGuardText, /write_guard_decision/g),
      },
    }),
    normalizeIntegrationPoint({
      name: "http_server_guarded_operations",
      file: FILES.httpServer,
      ok: expectedGuardedOperations.every((operation) => uniqueGuardedOperations.includes(operation)),
      details: {
        guarded_operations: uniqueGuardedOperations,
      },
    }),
    normalizeIntegrationPoint({
      name: "meeting_agent_guarded_confirm_write",
      file: FILES.meetingAgent,
      ok: meetingAgentText.includes("operation: \"meeting_confirm_write\""),
      details: {
        guarded_operations: extractOperationNames(meetingAgentText),
      },
    }),
    normalizeIntegrationPoint({
      name: "phase1_write_policy_route_contracts",
      file: FILES.httpRouteContracts,
      ok: writePolicyRouteChecks.every((item) => item.ok),
      details: {
        route_checks: writePolicyRouteChecks,
      },
    }),
    normalizeIntegrationPoint({
      name: "phase1_write_policy_log_fields",
      file: FILES.writePolicyContract,
      ok:
        httpRouteContractsText.includes("write_policy:")
        && writePolicyContractText.includes("policy_version")
        && writePolicyLogReferences >= expectedGuardedOperations.length,
      details: {
        write_policy_log_references: writePolicyLogReferences,
        expected_minimum: expectedGuardedOperations.length,
      },
    }),
    normalizeIntegrationPoint({
      name: "phase2_write_policy_enforcement_route_contracts",
      file: FILES.httpRouteContracts,
      ok: writePolicyEnforcementRouteChecks.every((item) => item.ok),
      details: {
        route_checks: writePolicyEnforcementRouteChecks,
      },
    }),
    normalizeIntegrationPoint({
      name: "phase2_write_policy_enforcement_runtime_surface",
      file: FILES.writeGuard,
      ok:
        writeGuardText.includes("write_policy_enforcement_warning")
        && writeGuardText.includes("write_policy_enforcement_observed")
        && httpServerText.includes("evaluateWritePolicyEnforcement(")
        && meetingAgentText.includes("pathname: \"/api/meeting/confirm\""),
      details: {
        enforcement_warning_logs: countMatches(writeGuardText, /write_policy_enforcement_warning/g),
        enforcement_observe_logs: countMatches(writeGuardText, /write_policy_enforcement_observed/g),
      },
    }),
    normalizeIntegrationPoint({
      name: "document_create_route_uses_plan_guard",
      file: FILES.httpServer,
      ok: httpServerText.includes("const createGuard = planDocumentCreateGuard({"),
      details: {
        plan_guard_calls: countMatches(httpServerText, /planDocumentCreateGuard\(\{/g),
      },
    }),
    normalizeIntegrationPoint({
      name: "lark_content_uses_assert_create_guard",
      file: FILES.larkContent,
      ok: larkContentText.includes("const createGuard = assertDocumentCreateAllowed({"),
      details: {
        assert_guard_calls: countMatches(larkContentText, /assertDocumentCreateAllowed\(\{/g),
      },
    }),
  ];

  const issues = [];
  for (const scenario of scenarioResults) {
    pushIssue(issues, scenario.ok !== true, {
      code: `write_scenario_failed:${scenario.name}`,
      summary: `Write guard scenario failed: ${scenario.name}`,
      file: scenario.file,
      details: {
        expected: scenario.expected,
        actual: scenario.actual,
      },
    });
  }
  for (const integration of integrationPoints) {
    pushIssue(issues, integration.ok !== true, {
      code: `write_integration_missing:${integration.name}`,
      summary: `Write guard integration missing: ${integration.name}`,
      file: integration.file,
      details: integration.details,
    });
  }

  return {
    status: issues.length === 0 ? "pass" : "fail",
    issue_count: issues.length,
    summary: issues.length === 0
      ? "write guard and document-create guard paths are stable"
      : "write guard or document-create guard drift detected",
    guidance: issues.length === 0
      ? "Keep `src/write-guard.mjs`, `src/lark-write-guard.mjs`, and write callsites aligned; no write repair is needed."
      : "Inspect `src/write-guard.mjs`, `src/lark-write-guard.mjs`, and guarded callsites in `src/http-server.mjs`, `src/meeting-agent.mjs`, and `src/lark-content.mjs` before changing any write runtime.",
    scenario_results: scenarioResults,
    guarded_operations: uniqueGuardedOperations,
    policy_actions: uniquePolicyActions,
    policy_route_checks: writePolicyRouteChecks,
    enforcement_route_checks: writePolicyEnforcementRouteChecks,
    enforcement_modes: writePolicyEnforcementModes,
    policy_coverage: writePolicyCoverage,
    violation_type_stats: writePolicyViolationTypeStats,
    create_guard_surfaces: [
      {
        file: FILES.httpServer,
        surface: "planDocumentCreateGuard",
      },
      {
        file: FILES.larkContent,
        surface: "assertDocumentCreateAllowed",
      },
    ],
    integration_points: integrationPoints,
    issues,
  };
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
  threshold = 0.9,
  decisionSeverity = "info",
  hasObviousRegression = false,
  snapshotAvailable = false,
} = {}) {
  if (!snapshotAvailable) {
    return "fail";
  }
  if (Number(accuracyRatio) < Number(threshold) || cleanText(decisionSeverity) === "high") {
    return "fail";
  }
  if (hasObviousRegression || cleanText(decisionSeverity) === "warning") {
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
      issue_count: 1,
      summary: "routing latest snapshot unavailable",
      guidance: "Run `node scripts/routing-eval.mjs --json` or `npm run routing:closed-loop` first so routing evidence can be traced from an archived snapshot.",
      latest_snapshot: null,
      compare: {
        available: false,
        target: null,
        has_obvious_regression: false,
        summary: "routing compare unavailable",
      },
      diagnostics_summary: null,
      issues: [
        {
          code: "routing_snapshot_missing",
          summary: error instanceof Error ? error.message : String(error),
          file: null,
          details: null,
        },
      ],
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
  const threshold = Number(latestSnapshot?.run?.threshold?.min_accuracy_ratio || 0.9);
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

  const issues = [];
  pushIssue(issues, Number(diagnosticsSummary?.accuracy_ratio || 0) < threshold, {
    code: "routing_accuracy_below_threshold",
    summary: `Routing accuracy ratio ${Number(diagnosticsSummary?.accuracy_ratio || 0)} is below threshold ${threshold}.`,
    file: cleanText(latestSnapshot?.path) || null,
    details: {
      accuracy_ratio: Number(diagnosticsSummary?.accuracy_ratio || 0),
      threshold,
    },
  });
  pushIssue(issues, hasObviousRegression, {
    code: "routing_compare_regression",
    summary: "Routing compare shows an obvious regression against the previous archived snapshot.",
    file: cleanText(latestSnapshot?.path) || null,
    details: {
      compare_target_run_id: cleanText(compareSnapshot?.snapshot?.run_id) || null,
    },
  });
  pushIssue(issues, diagnosticsSummary?.doc_boundary_regression === true, {
    code: "routing_doc_boundary_regression",
    summary: "Routing miss evidence currently matches the checked-in doc/company-brain boundary regression family.",
    file: cleanText(latestSnapshot?.path) || null,
    details: {
      run_id: cleanText(latestSnapshot?.snapshot?.run_id) || null,
    },
  });
  pushIssue(issues, cleanText(decision?.severity) === "warning" || cleanText(decision?.severity) === "high", {
    code: "routing_decision_requires_review",
    summary: cleanText(decision?.summary) || "Routing diagnostics require manual review.",
    file: cleanText(latestSnapshot?.path) || null,
    details: {
      decision_action: cleanText(decision?.action) || null,
      decision_severity: cleanText(decision?.severity) || null,
    },
  });

  return {
    status,
    issue_count: issues.length,
    summary: status === "pass"
      ? "routing snapshot stable"
      : status === "degrade"
        ? "routing snapshot passes, but compare or diagnostics show drift"
        : "routing snapshot is not safe",
    guidance: status === "pass"
      ? "Routing evidence is stable; no routing repair is needed."
      : status === "degrade"
        ? "Inspect the archived routing compare first; if it is only a coverage gap, review fixtures before changing routing rules."
        : "Inspect the latest routing snapshot and compare evidence before changing routing logic; do not add fallback to mask the regression.",
    latest_snapshot: latestSnapshot?.snapshot
      ? {
          run_id: latestSnapshot.snapshot.run_id || null,
          timestamp: latestSnapshot.snapshot.timestamp || null,
          snapshot_path: latestSnapshot.path || null,
        }
      : null,
    compare: {
      available: Boolean(compareSnapshot),
      target: compareSnapshot?.snapshot
        ? {
            run_id: compareSnapshot.snapshot.run_id || null,
            timestamp: compareSnapshot.snapshot.timestamp || null,
            snapshot_path: compareSnapshot.path || null,
          }
        : null,
      has_obvious_regression: hasObviousRegression,
      summary: compareSnapshot
        ? (hasObviousRegression ? "obvious regression detected from compare" : "no obvious regression from compare")
        : "routing compare unavailable",
    },
    diagnostics_summary: diagnosticsSummary,
    issues,
  };
}

function buildOverallStatus(...statuses) {
  return [...statuses]
    .map((status) => cleanText(status) || "fail")
    .sort((left, right) => (STATUS_ORDER[left] ?? -1) - (STATUS_ORDER[right] ?? -1))[0] || "fail";
}

function buildDecision({ controlSummary = {}, routingSummary = {}, writeSummary = {} } = {}) {
  if (cleanText(controlSummary?.status) === "fail") {
    return {
      action: "inspect_control_kernel",
      line: "control",
      summary: controlSummary.summary || "Control drift detected.",
      suggested_next_step: controlSummary.guidance || "Inspect control-kernel and lane-executor integration.",
    };
  }
  if (cleanText(writeSummary?.status) === "fail") {
    return {
      action: "inspect_write_guard",
      line: "write",
      summary: writeSummary.summary || "Write guard drift detected.",
      suggested_next_step: writeSummary.guidance || "Inspect write-guard and document-create guard integrations.",
    };
  }
  if (cleanText(routingSummary?.status) !== "pass") {
    return {
      action: "inspect_routing_snapshot",
      line: "routing",
      summary: routingSummary.summary || "Routing diagnostics require review.",
      suggested_next_step: routingSummary.guidance || "Inspect latest routing snapshot and compare evidence first.",
    };
  }
  return {
    action: "observe_only",
    line: "none",
    summary: "Control, write, and routing diagnostics are stable.",
    suggested_next_step: "No repair is needed; keep using the archived diagnostics snapshots for regression checks.",
  };
}

function buildDiagnosticsSummary({
  controlSummary = {},
  routingSummary = {},
  writeSummary = {},
} = {}) {
  return {
    overall_status: buildOverallStatus(
      controlSummary?.status,
      routingSummary?.status,
      writeSummary?.status,
    ),
    control_status: cleanText(controlSummary?.status) || "fail",
    routing_status: cleanText(routingSummary?.status) || "fail",
    write_status: cleanText(writeSummary?.status) || "fail",
    control_issue_count: Number(controlSummary?.issue_count || 0),
    routing_issue_count: Number(routingSummary?.issue_count || 0),
    write_issue_count: Number(writeSummary?.issue_count || 0),
  };
}

export async function runControlDiagnostics({ routingArchiveDir } = {}) {
  const [controlSummary, routingSummary, writeSummary] = await Promise.all([
    buildControlSummary(),
    buildRoutingSummary({ routingArchiveDir }),
    buildWriteSummary(),
  ]);
  const diagnosticsSummary = buildDiagnosticsSummary({
    controlSummary,
    routingSummary,
    writeSummary,
  });
  const reportingSummary = buildDiagnosticsReportingSummary({
    controlSummary,
    routingSummary,
    writeSummary,
  });

  return {
    ok: diagnosticsSummary.overall_status === "pass",
    diagnostics_summary: diagnosticsSummary,
    control_summary: controlSummary,
    routing_summary: routingSummary,
    write_summary: writeSummary,
    reporting_summary: reportingSummary,
    decision: buildDecision({
      controlSummary,
      routingSummary,
      writeSummary,
    }),
  };
}

export function buildControlDiagnosticsCompareSummary({
  currentSummary = {},
  previousSummary = {},
} = {}) {
  const compareSummary = {};

  for (const field of CONTROL_DIAGNOSTICS_COMPARE_FIELDS) {
    if (field.endsWith("_status")) {
      const current = cleanText(currentSummary?.[field]) || "fail";
      const previous = cleanText(previousSummary?.[field]) || "fail";
      const status = compareStatusDirection(current, previous);
      if (status !== "same") {
        compareSummary[field] = {
          previous,
          current,
          status,
        };
      }
      continue;
    }

    const delta = buildCountDelta(currentSummary?.[field], previousSummary?.[field]);
    if (delta.status !== "same") {
      compareSummary[field] = delta;
    }
  }

  return compareSummary;
}
