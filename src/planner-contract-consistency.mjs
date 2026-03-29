import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cleanText } from "./message-intent-utils.mjs";
import { getRouteContract } from "./http-route-contracts.mjs";
import {
  listPlannerSkillBridges,
  listPlannerPresets,
  listPlannerTools,
  selectPlannerTool,
} from "./executive-planner.mjs";
import {
  resolveDocQueryRoute,
} from "./planner-doc-query-flow.mjs";
import {
  resolveRuntimeInfoRoute,
} from "./planner-runtime-info-flow.mjs";
import {
  resolveOkrFlowRoute,
} from "./planner-okr-flow.mjs";
import {
  resolveBdFlowRoute,
} from "./planner-bd-flow.mjs";
import {
  resolveDeliveryFlowRoute,
} from "./planner-delivery-flow.mjs";
import { route as routeDocQuery } from "./router.js";

const CONTRACT_FILE = fileURLToPath(new URL("../docs/system/planner_contract.json", import.meta.url));
const EXECUTIVE_PLANNER_FILE = fileURLToPath(new URL("./executive-planner.mjs", import.meta.url));
const HTTP_ROUTE_CONTRACTS_FILE = fileURLToPath(new URL("./http-route-contracts.mjs", import.meta.url));
const ROUTER_FILE = fileURLToPath(new URL("./router.js", import.meta.url));
const DOC_QUERY_FLOW_FILE = fileURLToPath(new URL("./planner-doc-query-flow.mjs", import.meta.url));
const RUNTIME_INFO_FLOW_FILE = fileURLToPath(new URL("./planner-runtime-info-flow.mjs", import.meta.url));
const OKR_FLOW_FILE = fileURLToPath(new URL("./planner-okr-flow.mjs", import.meta.url));
const BD_FLOW_FILE = fileURLToPath(new URL("./planner-bd-flow.mjs", import.meta.url));
const DELIVERY_FLOW_FILE = fileURLToPath(new URL("./planner-delivery-flow.mjs", import.meta.url));
const TASK_LIFECYCLE_FILE = fileURLToPath(new URL("./planner-task-lifecycle-v1.mjs", import.meta.url));
const GATE_FAILURE_CATEGORIES = [
  "undefined_actions",
  "undefined_presets",
  "undefined_routing_reasons",
  "selector_contract_mismatches",
  "action_governance_mismatches",
];
const FINDING_CATEGORY_ORDER = [
  "undefined_actions",
  "undefined_presets",
  "undefined_routing_reasons",
  "selector_contract_mismatches",
  "action_governance_mismatches",
  "deprecated_reachable_targets",
];
export const PLANNER_DIAGNOSTICS_COMPARE_FIELDS = [
  "gate",
  "undefined_actions",
  "undefined_presets",
  "undefined_routing_reasons",
  "selector_contract_mismatches",
  "action_governance_mismatches",
  "deprecated_reachable_targets",
];
const GOVERNANCE_FIELDS = [
  "external_write",
  "confirm_required",
  "review_required",
  "required_entry_fields",
];

function loadPlannerContract({ contractOverride } = {}) {
  if (contractOverride && typeof contractOverride === "object") {
    return contractOverride;
  }
  return JSON.parse(readFileSync(CONTRACT_FILE, "utf8"));
}

function buildContractCatalog(contract = {}) {
  const actions = Object.keys(contract?.actions || {}).map((name) => cleanText(name)).filter(Boolean);
  const presets = Object.keys(contract?.presets || {}).map((name) => cleanText(name)).filter(Boolean);
  const routingReasons = Object.keys(contract?.routing_reason || {}).map((name) => cleanText(name)).filter(Boolean);
  return {
    actions,
    presets,
    routing_reasons: routingReasons,
    targets: [...actions, ...presets],
  };
}

function getContractTargetKind(contract = {}, target = "") {
  const normalizedTarget = cleanText(target);
  if (!normalizedTarget) {
    return null;
  }
  if (contract?.actions?.[normalizedTarget]) {
    return "action";
  }
  if (contract?.presets?.[normalizedTarget]) {
    return "preset";
  }
  return null;
}

function getContractTargetEntry(contract = {}, target = "") {
  const normalizedTarget = cleanText(target);
  if (!normalizedTarget) {
    return null;
  }
  return contract?.actions?.[normalizedTarget] || contract?.presets?.[normalizedTarget] || null;
}

function isDeprecatedContractTarget(entry = null) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  return entry.deprecated === true || cleanText(entry.status).toLowerCase() === "deprecated";
}

function uniqTargets(values = []) {
  return Array.from(new Set(
    values
      .map((value) => cleanText(value))
      .filter(Boolean),
  ));
}

function normalizeGovernanceField(field = "", value) {
  const normalizedField = cleanText(field);
  if (normalizedField === "external_write" || normalizedField === "confirm_required") {
    if (value === true) {
      return true;
    }
    if (value === false) {
      return false;
    }
    return null;
  }

  if (normalizedField === "review_required") {
    if (value === true) {
      return "always";
    }
    if (value === false) {
      return "never";
    }
    const normalizedValue = cleanText(value).toLowerCase();
    if (normalizedValue === "always" || normalizedValue === "never" || normalizedValue === "conditional") {
      return normalizedValue;
    }
    return null;
  }

  if (normalizedField === "required_entry_fields") {
    if (!Array.isArray(value)) {
      return null;
    }
    const normalizedValues = value.map((item) => cleanText(item)).filter(Boolean);
    return normalizedValues.length > 0 ? normalizedValues : null;
  }

  return null;
}

function governanceValuesEqual(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function normalizeGovernanceContract(governance = null) {
  if (!governance || typeof governance !== "object" || Array.isArray(governance)) {
    return null;
  }

  const normalized = Object.fromEntries(
    GOVERNANCE_FIELDS.map((field) => [
      field,
      normalizeGovernanceField(field, governance[field]),
    ]),
  );

  return GOVERNANCE_FIELDS.some((field) => normalized[field] !== null)
    ? normalized
    : null;
}

function formatGovernanceValue(value) {
  if (value === null || value === undefined) {
    return "missing";
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join("|") : "missing";
  }
  if (value === true) {
    return "true";
  }
  if (value === false) {
    return "false";
  }
  return cleanText(value) || "missing";
}

function buildGovernanceFinding({
  action = "",
  comparison = "",
  field = "",
  expected = null,
  actual = null,
  sourceFile = "",
  counterpartFile = "",
  reason = "",
} = {}) {
  return {
    category: "action_governance_mismatches",
    source_id: `action_governance:${cleanText(action)}:${cleanText(comparison)}`,
    file: cleanText(sourceFile) || null,
    target: cleanText(action) || null,
    reason: cleanText(reason) || "governance_mismatch",
    field: cleanText(field) || null,
    expected,
    actual,
    counterpart_file: cleanText(counterpartFile) || null,
  };
}

function collectActionGovernanceFindings(contract = {}) {
  const findings = [];
  for (const tool of listPlannerTools()) {
    const action = cleanText(tool?.action);
    if (!action) {
      continue;
    }

    const contractEntry = getContractTargetEntry(contract, action);
    const contractGovernance = normalizeGovernanceContract(contractEntry?.governance);
    const toolGovernance = normalizeGovernanceContract(tool?.governance);
    const routeContract = getRouteContract(tool?.pathname || "");
    const routeGovernance = normalizeGovernanceContract(routeContract?.governance);
    const hasGovernance = Boolean(contractGovernance || toolGovernance || routeGovernance);

    if (!hasGovernance) {
      continue;
    }

    for (const field of GOVERNANCE_FIELDS) {
      const contractValue = contractGovernance?.[field] ?? null;
      const toolValue = toolGovernance?.[field] ?? null;
      const routeValue = routeGovernance?.[field] ?? null;

      if (!governanceValuesEqual(contractValue, toolValue)) {
        findings.push(buildGovernanceFinding({
          action,
          comparison: "contract_vs_tool_registry",
          field,
          expected: contractValue,
          actual: toolValue,
          sourceFile: CONTRACT_FILE,
          counterpartFile: EXECUTIVE_PLANNER_FILE,
          reason: `${field}_mismatch`,
        }));
      }

      if (!governanceValuesEqual(contractValue, routeValue)) {
        findings.push(buildGovernanceFinding({
          action,
          comparison: "contract_vs_route_contract",
          field,
          expected: contractValue,
          actual: routeValue,
          sourceFile: CONTRACT_FILE,
          counterpartFile: HTTP_ROUTE_CONTRACTS_FILE,
          reason: `${field}_mismatch`,
        }));
      }

      if (!governanceValuesEqual(toolValue, routeValue)) {
        findings.push(buildGovernanceFinding({
          action,
          comparison: "tool_registry_vs_route_contract",
          field,
          expected: toolValue,
          actual: routeValue,
          sourceFile: EXECUTIVE_PLANNER_FILE,
          counterpartFile: HTTP_ROUTE_CONTRACTS_FILE,
          reason: `${field}_mismatch`,
        }));
      }
    }
  }

  return findings;
}

function buildObservedSource({
  sourceId = "",
  file = "",
  kind = "",
  allowedKinds = [],
  targets = [],
} = {}) {
  return {
    source_id: cleanText(sourceId) || null,
    file: cleanText(file) || null,
    kind: cleanText(kind) || null,
    allowed_kinds: Array.isArray(allowedKinds)
      ? allowedKinds.map((value) => cleanText(value)).filter(Boolean)
      : [],
    targets: uniqTargets(targets),
  };
}

function buildObservedDecisionSources({
  sourceId = "",
  file = "",
  kind = "",
  decisions = [],
} = {}) {
  const actionTargets = uniqTargets(
    decisions.map((decision) => cleanText(decision?.action)),
  );
  const presetTargets = uniqTargets(
    decisions.map((decision) => cleanText(decision?.preset)),
  );

  return [
    actionTargets.length > 0
      ? buildObservedSource({
          sourceId: `${sourceId}:action`,
          file,
          kind,
          allowedKinds: ["action"],
          targets: actionTargets,
        })
      : null,
    presetTargets.length > 0
      ? buildObservedSource({
          sourceId: `${sourceId}:preset`,
          file,
          kind,
          allowedKinds: ["preset"],
          targets: presetTargets,
        })
      : null,
  ].filter(Boolean);
}

function scanLiteralFieldValuesFromFile(file = "", fieldName = "") {
  const normalizedFile = cleanText(file);
  const normalizedFieldName = cleanText(fieldName);
  if (!normalizedFile || !normalizedFieldName) {
    return [];
  }

  const pattern = new RegExp(`${normalizedFieldName}:\\s*["'\`]([^"'\\\`]+)["'\`]`, "g");
  const sourceText = readFileSync(normalizedFile, "utf8");
  const values = [];
  let match = pattern.exec(sourceText);
  while (match) {
    values.push(cleanText(match[1]));
    match = pattern.exec(sourceText);
  }
  return uniqTargets(values);
}

function buildObservedRoutingReasonSource({
  sourceId = "",
  file = "",
  kind = "",
  reasons = [],
} = {}) {
  return {
    source_id: cleanText(sourceId) || null,
    file: cleanText(file) || null,
    kind: cleanText(kind) || null,
    routing_reasons: uniqTargets(reasons),
  };
}

function buildObservedDecisionRoutingReasonSource({
  sourceId = "",
  file = "",
  kind = "",
  decisions = [],
} = {}) {
  return buildObservedRoutingReasonSource({
    sourceId,
    file,
    kind,
    reasons: decisions.map((decision) => cleanText(decision?.routing_reason)),
  });
}

function observePlannerSelectorTargets() {
  const selectorSamples = [
    { userIntent: "幫我整理 launch checklist", taskType: "skill_read" },
    { userIntent: "建立文件並查詢", taskType: "" },
    { userIntent: "建立文件後列出知識庫", taskType: "" },
    { userIntent: "搜尋後打開內容", taskType: "" },
    { userIntent: "", taskType: "doc_write" },
    { userIntent: "列出文件", taskType: "" },
    { userIntent: "學習這份文件", taskType: "" },
    { userIntent: "update learning state", taskType: "" },
    { userIntent: "runtime", taskType: "" },
  ];
  return uniqTargets(
    selectorSamples.map((sample) => selectPlannerTool({
      userIntent: sample.userIntent,
      taskType: sample.taskType,
      logger: null,
    })?.selected_action),
  );
}

function observePlannerSelectorRoutingReasons() {
  const selectorSamples = [
    { userIntent: "幫我整理 launch checklist", taskType: "skill_read" },
    { userIntent: "建立文件並查詢", taskType: "" },
    { userIntent: "建立文件後列出知識庫", taskType: "" },
    { userIntent: "搜尋後打開內容", taskType: "" },
    { userIntent: "", taskType: "doc_write" },
    { userIntent: "列出文件", taskType: "" },
    { userIntent: "學習這份文件", taskType: "" },
    { userIntent: "update learning state", taskType: "" },
    { userIntent: "runtime", taskType: "" },
    { userIntent: "幫我看看", taskType: "" },
  ];

  return uniqTargets(
    selectorSamples.map((sample) => selectPlannerTool({
      userIntent: sample.userIntent,
      taskType: sample.taskType,
      logger: null,
    })?.routing_reason),
  );
}

function observeDocQueryRouterTargets() {
  return [
    routeDocQuery("找 OKR 文件"),
    routeDocQuery("你把我的雲端文件再看一遍，把不屬於scanoo的內容摘出去讓我確認"),
    routeDocQuery("整理這份文件"),
    routeDocQuery("這份文件寫了什麼", {
      activeDoc: {
        doc_id: "doc_active",
        title: "Active doc",
      },
    }),
  ];
}

function observeDocQueryFlowTargets() {
  return [
    resolveDocQueryRoute({
      userIntent: "找 OKR 文件",
      payload: {},
      activeDoc: null,
      activeCandidates: [],
      logger: null,
    }),
    resolveDocQueryRoute({
      userIntent: "你把我的雲端文件再看一遍，把不屬於scanoo的內容摘出去讓我確認",
      payload: {},
      activeDoc: null,
      activeCandidates: [],
      logger: null,
    }),
    resolveDocQueryRoute({
      userIntent: "整理這份文件",
      payload: {},
      activeDoc: null,
      activeCandidates: [],
      logger: null,
    }),
    resolveDocQueryRoute({
      userIntent: "這份文件寫了什麼",
      payload: {},
      activeDoc: {
        doc_id: "doc_active",
        title: "Active doc",
      },
      activeCandidates: [],
      logger: null,
    }),
  ];
}

function observeRuntimeInfoFlowTargets() {
  return uniqTargets([
    resolveRuntimeInfoRoute({
      userIntent: "runtime",
      payload: {},
      logger: null,
    })?.action,
  ]);
}

function observeOkrFlowTargets() {
  return [
    resolveOkrFlowRoute({
      userIntent: "OKR 本週重點",
      payload: {},
      context: {},
      logger: null,
    }),
    resolveOkrFlowRoute({
      userIntent: "整理 OKR 進度",
      payload: {},
      context: {},
      logger: null,
    }),
    resolveOkrFlowRoute({
      userIntent: "這份文件寫了什麼",
      payload: {},
      context: {
        activeTheme: "okr",
        activeDoc: {
          doc_id: "doc_okr",
          title: "OKR doc",
        },
        activeCandidates: [],
      },
      logger: null,
    }),
  ];
}

function observeBdFlowTargets() {
  return [
    resolveBdFlowRoute({
      userIntent: "BD 提案",
      payload: {},
      context: {},
      logger: null,
    }),
    resolveBdFlowRoute({
      userIntent: "整理 BD 跟進",
      payload: {},
      context: {},
      logger: null,
    }),
    resolveBdFlowRoute({
      userIntent: "這份文件寫了什麼",
      payload: {},
      context: {
        activeTheme: "bd",
        activeDoc: {
          doc_id: "doc_bd",
          title: "BD doc",
        },
        activeCandidates: [],
      },
      logger: null,
    }),
  ];
}

function observeDeliveryFlowTargets() {
  return [
    resolveDeliveryFlowRoute({
      userIntent: "交付 SOP",
      payload: {},
      context: {},
      logger: null,
    }),
    resolveDeliveryFlowRoute({
      userIntent: "整理交付驗收流程",
      payload: {},
      context: {},
      logger: null,
    }),
    resolveDeliveryFlowRoute({
      userIntent: "這份文件寫了什麼",
      payload: {},
      context: {
        activeTheme: "delivery",
        activeDoc: {
          doc_id: "doc_delivery",
          title: "Delivery doc",
        },
        activeCandidates: [],
      },
      logger: null,
    }),
  ];
}

function observeTaskLifecycleTargets() {
  return scanLiteralFieldValuesFromFile(TASK_LIFECYCLE_FILE, "selected_action");
}

function observeTaskLifecycleRoutingReasons() {
  return scanLiteralFieldValuesFromFile(TASK_LIFECYCLE_FILE, "routing_reason");
}

function dedupeFindings(findings = []) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = [
      cleanText(finding.category),
      cleanText(finding.source_id),
      cleanText(finding.target),
      cleanText(finding.reason),
    ].join("::");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function classifyObservedRoutingReasonSource(contract = {}, source = {}) {
  const findings = [];
  for (const routingReason of Array.isArray(source.routing_reasons) ? source.routing_reasons : []) {
    if (contract?.routing_reason?.[routingReason]) {
      continue;
    }
    findings.push({
      category: "undefined_routing_reasons",
      source_id: source.source_id,
      file: source.file,
      target: routingReason,
      reason: "routing_reason_missing_from_contract",
      contract_kind: null,
    });
  }
  return findings;
}

function classifyObservedSource(contract = {}, source = {}) {
  const findings = [];
  for (const target of Array.isArray(source.targets) ? source.targets : []) {
    const contractKind = getContractTargetKind(contract, target);
    const contractEntry = getContractTargetEntry(contract, target);

    if (!contractKind) {
      if (source.kind === "preset_registry") {
        findings.push({
          category: "undefined_presets",
          source_id: source.source_id,
          file: source.file,
          target,
          reason: "preset_missing_from_contract",
          allowed_kinds: source.allowed_kinds,
          contract_kind: null,
        });
        continue;
      }

      if (source.allowed_kinds.length === 1 && source.allowed_kinds[0] === "action") {
        findings.push({
          category: "undefined_actions",
          source_id: source.source_id,
          file: source.file,
          target,
          reason: "action_missing_from_contract",
          allowed_kinds: source.allowed_kinds,
          contract_kind: null,
        });
        continue;
      }

      findings.push({
        category: "selector_contract_mismatches",
        source_id: source.source_id,
        file: source.file,
        target,
        reason: "target_missing_from_contract",
        allowed_kinds: source.allowed_kinds,
        contract_kind: null,
      });
      continue;
    }

    if (isDeprecatedContractTarget(contractEntry)) {
      findings.push({
        category: "deprecated_reachable_targets",
        source_id: source.source_id,
        file: source.file,
        target,
        reason: "deprecated_target_still_reachable",
        allowed_kinds: source.allowed_kinds,
        contract_kind: contractKind,
      });
    }

    if (!source.allowed_kinds.includes(contractKind)) {
      findings.push({
        category: "selector_contract_mismatches",
        source_id: source.source_id,
        file: source.file,
        target,
        reason: "target_kind_mismatch",
        allowed_kinds: source.allowed_kinds,
        contract_kind: contractKind,
      });
    }
  }
  return findings;
}

function collectObservedSources() {
  const toolTargets = listPlannerTools().map((tool) => cleanText(tool.action));
  const skillTargets = listPlannerSkillBridges().map((skill) => cleanText(skill.action));
  const presets = listPlannerPresets();
  const presetTargets = presets.map((preset) => cleanText(preset.preset));
  const presetStepSources = presets.map((preset) => buildObservedSource({
    sourceId: `preset_steps:${preset.preset}`,
    file: EXECUTIVE_PLANNER_FILE,
    kind: "preset_steps",
    allowedKinds: ["action"],
    targets: preset.step_actions,
  }));

  return [
    buildObservedSource({
      sourceId: "planner_tool_registry",
      file: EXECUTIVE_PLANNER_FILE,
      kind: "tool_registry",
      allowedKinds: ["action"],
      targets: toolTargets,
    }),
    buildObservedSource({
      sourceId: "planner_skill_registry",
      file: EXECUTIVE_PLANNER_FILE,
      kind: "skill_registry",
      allowedKinds: ["action"],
      targets: skillTargets,
    }),
    buildObservedSource({
      sourceId: "planner_preset_registry",
      file: EXECUTIVE_PLANNER_FILE,
      kind: "preset_registry",
      allowedKinds: ["preset"],
      targets: presetTargets,
    }),
    ...presetStepSources,
    buildObservedSource({
      sourceId: "planner_selector",
      file: EXECUTIVE_PLANNER_FILE,
      kind: "selector",
      allowedKinds: ["action", "preset"],
      targets: observePlannerSelectorTargets(),
    }),
    ...buildObservedDecisionSources({
      sourceId: "doc_query_router",
      file: ROUTER_FILE,
      kind: "selector_route",
      decisions: observeDocQueryRouterTargets(),
    }),
    ...buildObservedDecisionSources({
      sourceId: "planner_doc_query_flow.route",
      file: DOC_QUERY_FLOW_FILE,
      kind: "flow_route",
      decisions: observeDocQueryFlowTargets(),
    }),
    buildObservedSource({
      sourceId: "planner_runtime_info_flow.route",
      file: RUNTIME_INFO_FLOW_FILE,
      kind: "flow_route",
      allowedKinds: ["action"],
      targets: observeRuntimeInfoFlowTargets(),
    }),
    ...buildObservedDecisionSources({
      sourceId: "planner_okr_flow.route",
      file: OKR_FLOW_FILE,
      kind: "flow_route",
      decisions: observeOkrFlowTargets(),
    }),
    ...buildObservedDecisionSources({
      sourceId: "planner_bd_flow.route",
      file: BD_FLOW_FILE,
      kind: "flow_route",
      decisions: observeBdFlowTargets(),
    }),
    ...buildObservedDecisionSources({
      sourceId: "planner_delivery_flow.route",
      file: DELIVERY_FLOW_FILE,
      kind: "flow_route",
      decisions: observeDeliveryFlowTargets(),
    }),
    buildObservedSource({
      sourceId: "planner_task_lifecycle_v1.actions",
      file: TASK_LIFECYCLE_FILE,
      kind: "internal_follow_up",
      allowedKinds: ["action"],
      targets: observeTaskLifecycleTargets(),
    }),
  ];
}

function collectObservedRoutingReasonSources() {
  return [
    buildObservedRoutingReasonSource({
      sourceId: "planner_selector",
      file: EXECUTIVE_PLANNER_FILE,
      kind: "selector",
      reasons: observePlannerSelectorRoutingReasons(),
    }),
    buildObservedDecisionRoutingReasonSource({
      sourceId: "doc_query_router",
      file: ROUTER_FILE,
      kind: "selector_route",
      decisions: observeDocQueryRouterTargets(),
    }),
    buildObservedDecisionRoutingReasonSource({
      sourceId: "planner_doc_query_flow.route",
      file: DOC_QUERY_FLOW_FILE,
      kind: "flow_route",
      decisions: observeDocQueryFlowTargets(),
    }),
    buildObservedRoutingReasonSource({
      sourceId: "planner_task_lifecycle_v1.routing_reason",
      file: TASK_LIFECYCLE_FILE,
      kind: "internal_follow_up",
      reasons: observeTaskLifecycleRoutingReasons(),
    }),
  ];
}

export function buildPlannerContractGate(findings = {}) {
  const counts = Object.fromEntries(
    GATE_FAILURE_CATEGORIES.map((category) => [
      category,
      Array.isArray(findings?.[category]) ? findings[category].length : 0,
    ]),
  );
  const failingCategories = GATE_FAILURE_CATEGORIES
    .filter((category) => counts[category] > 0);

  return {
    ok: failingCategories.length === 0,
    failing_categories: failingCategories,
    fail_summary: failingCategories.map((category) => ({
      category,
      count: counts[category],
    })),
  };
}

export function buildPlannerDiagnosticsSummary(report = {}) {
  return {
    gate: report?.gate?.ok ? "pass" : "fail",
    undefined_actions: Number.isFinite(report?.summary?.undefined_actions)
      ? report.summary.undefined_actions
      : 0,
    undefined_presets: Number.isFinite(report?.summary?.undefined_presets)
      ? report.summary.undefined_presets
      : 0,
    undefined_routing_reasons: Number.isFinite(report?.summary?.undefined_routing_reasons)
      ? report.summary.undefined_routing_reasons
      : 0,
    selector_contract_mismatches: Number.isFinite(report?.summary?.selector_contract_mismatches)
      ? report.summary.selector_contract_mismatches
      : 0,
    action_governance_mismatches: Number.isFinite(report?.summary?.action_governance_mismatches)
      ? report.summary.action_governance_mismatches
      : 0,
    deprecated_reachable_targets: Number.isFinite(report?.summary?.deprecated_reachable_targets)
      ? report.summary.deprecated_reachable_targets
      : 0,
  };
}

export function buildPlannerDiagnosticsDecision(summary = {}) {
  const gate = cleanText(summary?.gate) || "fail";
  const blockingCategories = GATE_FAILURE_CATEGORIES
    .filter((category) => Number(summary?.[category] || 0) > 0);
  const hasDeprecatedReachableTargets = Number(summary?.deprecated_reachable_targets || 0) > 0;

  if (gate === "fail") {
    return {
      action: "fix_planner_implementation",
      blocking_categories: blockingCategories,
      summary: [
        "Default: fix planner implementation first.",
        "Alternative: update the contract only for an intentional stable target, and state the reason explicitly.",
        hasDeprecatedReachableTargets
          ? "Deprecated reachable targets warn only and do not block this gate."
          : null,
      ].filter(Boolean).join(" "),
    };
  }

  if (hasDeprecatedReachableTargets) {
    return {
      action: "warn_deprecated_only",
      blocking_categories: [],
      summary: "Gate passes. Deprecated reachable targets are warnings only and do not block this gate.",
    };
  }

  return {
    action: "observe_only",
    blocking_categories: [],
    summary: "Gate passes. No planner implementation or contract change is required.",
  };
}

function normalizePlannerDiagnosticsSummary(summary = {}) {
  return {
    gate: cleanText(summary?.gate) === "pass" ? "pass" : "fail",
    undefined_actions: Number(summary?.undefined_actions || 0),
    undefined_presets: Number(summary?.undefined_presets || 0),
    undefined_routing_reasons: Number(summary?.undefined_routing_reasons || 0),
    selector_contract_mismatches: Number(summary?.selector_contract_mismatches || 0),
    action_governance_mismatches: Number(summary?.action_governance_mismatches || 0),
    deprecated_reachable_targets: Number(summary?.deprecated_reachable_targets || 0),
  };
}

export function buildPlannerDiagnosticsCompareSummary({
  currentSummary = {},
  previousSummary = {},
} = {}) {
  const current = normalizePlannerDiagnosticsSummary(currentSummary);
  const previous = normalizePlannerDiagnosticsSummary(previousSummary);
  const compareSummary = {};

  if (current.gate !== previous.gate) {
    compareSummary.gate = {
      previous: previous.gate,
      current: current.gate,
      status: current.gate === "fail" ? "worse" : "better",
    };
  }

  for (const field of PLANNER_DIAGNOSTICS_COMPARE_FIELDS.filter((name) => name !== "gate")) {
    const delta = current[field] - previous[field];
    if (delta === 0) {
      continue;
    }

    compareSummary[field] = {
      previous: previous[field],
      current: current[field],
      delta,
      status: delta > 0 ? "worse" : "better",
    };
  }

  return compareSummary;
}

export function runPlannerContractConsistencyCheck({ contractOverride } = {}) {
  const contract = loadPlannerContract({ contractOverride });
  const contractCatalog = buildContractCatalog(contract);
  const observedSources = collectObservedSources();
  const observedRoutingReasonSources = collectObservedRoutingReasonSources();
  const findings = dedupeFindings(
    [
      ...observedSources.flatMap((source) => classifyObservedSource(contract, source)),
      ...observedRoutingReasonSources.flatMap((source) => classifyObservedRoutingReasonSource(contract, source)),
      ...collectActionGovernanceFindings(contract),
    ],
  );

  const groupedFindings = {
    undefined_actions: findings.filter((finding) => finding.category === "undefined_actions"),
    undefined_presets: findings.filter((finding) => finding.category === "undefined_presets"),
    undefined_routing_reasons: findings.filter((finding) => finding.category === "undefined_routing_reasons"),
    deprecated_reachable_targets: findings.filter((finding) => finding.category === "deprecated_reachable_targets"),
    selector_contract_mismatches: findings.filter((finding) => finding.category === "selector_contract_mismatches"),
    action_governance_mismatches: findings.filter((finding) => finding.category === "action_governance_mismatches"),
  };
  const gate = buildPlannerContractGate(groupedFindings);

  const ok = Object.values(groupedFindings).every((items) => items.length === 0);
  const diagnosticsSummary = buildPlannerDiagnosticsSummary({
    gate,
    summary: {
      undefined_actions: groupedFindings.undefined_actions.length,
      undefined_presets: groupedFindings.undefined_presets.length,
      undefined_routing_reasons: groupedFindings.undefined_routing_reasons.length,
      deprecated_reachable_targets: groupedFindings.deprecated_reachable_targets.length,
      selector_contract_mismatches: groupedFindings.selector_contract_mismatches.length,
      action_governance_mismatches: groupedFindings.action_governance_mismatches.length,
    },
  });
  const decision = buildPlannerDiagnosticsDecision(diagnosticsSummary);

  return {
    ok,
    gate,
    diagnostics_summary: diagnosticsSummary,
    decision,
    contract: {
      version: cleanText(contract?.version) || null,
      actions: contractCatalog.actions,
      presets: contractCatalog.presets,
      routing_reasons: contractCatalog.routing_reasons,
    },
    summary: {
      observed_sources: observedSources.length,
      observed_routing_reason_sources: observedRoutingReasonSources.length,
      undefined_actions: groupedFindings.undefined_actions.length,
      undefined_presets: groupedFindings.undefined_presets.length,
      undefined_routing_reasons: groupedFindings.undefined_routing_reasons.length,
      deprecated_reachable_targets: groupedFindings.deprecated_reachable_targets.length,
      selector_contract_mismatches: groupedFindings.selector_contract_mismatches.length,
      action_governance_mismatches: groupedFindings.action_governance_mismatches.length,
    },
    observed_sources: observedSources,
    observed_routing_reason_sources: observedRoutingReasonSources,
    findings: groupedFindings,
  };
}

export function renderPlannerContractConsistencyReport(report = {}) {
  const diagnosticsSummary = report?.diagnostics_summary || buildPlannerDiagnosticsSummary(report);
  const decision = report?.decision || buildPlannerDiagnosticsDecision(diagnosticsSummary);
  const lines = [
    "Planner Diagnostics",
    `planner contract gate: ${report?.gate?.ok ? "pass" : "fail"}`,
    `planner contract consistency: ${report?.ok ? "ok" : "drift_detected"}`,
    `contract version: ${cleanText(report?.contract?.version) || "unknown"}`,
    `summary: gate=${diagnosticsSummary.gate} | undefined_actions=${diagnosticsSummary.undefined_actions} | undefined_presets=${diagnosticsSummary.undefined_presets} | undefined_routing_reasons=${diagnosticsSummary.undefined_routing_reasons} | selector_contract_mismatches=${diagnosticsSummary.selector_contract_mismatches} | action_governance_mismatches=${diagnosticsSummary.action_governance_mismatches} | deprecated_reachable_targets=${diagnosticsSummary.deprecated_reachable_targets}`,
    `decision: ${decision.summary}`,
  ];

  if (report?.gate?.ok === false) {
    const failSummary = Array.isArray(report?.gate?.fail_summary)
      ? report.gate.fail_summary.map((item) => `${item.category}=${item.count}`).join(" ; ")
      : "";
    lines.push(`blocking: ${failSummary || "unknown"}`);
  }

  const orderedFindings = FINDING_CATEGORY_ORDER.flatMap((category) => report?.findings?.[category] || []);

  if (orderedFindings.length > 0) {
    lines.push("findings:");
    for (const finding of orderedFindings) {
      if (finding.category === "action_governance_mismatches") {
        lines.push(
          `- ${finding.category}: ${finding.target} via ${finding.source_id} (${finding.reason}; field=${finding.field || "unknown"}; expected=${formatGovernanceValue(finding.expected)}; actual=${formatGovernanceValue(finding.actual)})`,
        );
        continue;
      }

      lines.push(
        `- ${finding.category}: ${finding.target} via ${finding.source_id} (${finding.reason}; contract_kind=${finding.contract_kind || "missing"})`,
      );
    }
  }

  return lines.join("\n");
}
