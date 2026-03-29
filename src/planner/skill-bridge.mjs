import { cleanText } from "../message-intent-utils.mjs";
import { defaultSkillRegistry } from "../skill-registry.mjs";
import { runSkill } from "../skill-runtime.mjs";
import {
  SKILL_CLASS_READ_ONLY,
  SKILL_SELECTOR_MODE_DETERMINISTIC,
  buildSkillGovernanceView,
  isPlannerCatalogEligibleSkillSurface,
  normalizeSkillSurface,
  normalizePlannerSkillSelector,
  SKILL_SURFACE_INTERNAL_ONLY,
  SKILL_SURFACE_PLANNER_VISIBLE,
  SKILL_SURFACE_USER_FACING_CAPABILITY,
} from "../skill-governance.mjs";

function normalizeStringList(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => cleanText(item)).filter(Boolean);
}

function normalizePlannerSkillSources(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => ({
      id: cleanText(item?.id) || null,
      title: cleanText(item?.title) || null,
      url: cleanText(item?.url) || null,
      snippet: cleanText(item?.snippet) || null,
    }))
    .filter((item) => item.id || item.title || item.url || item.snippet);
}

function normalizePlannerSkillSideEffects(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => ({
      mode: cleanText(item?.mode) || null,
      action: cleanText(item?.action) || null,
      runtime: cleanText(item?.runtime) || null,
      authority: cleanText(item?.authority) || null,
    }))
    .filter((item) => item.mode || item.action || item.runtime || item.authority);
}

function buildPlannerSkillSurfacePolicy({ surfaceLayer = "", selectorMode = "", skillClass = "" } = {}) {
  const normalizedSurfaceLayer = normalizeSkillSurface(surfaceLayer);
  const normalizedSelectorMode = cleanText(selectorMode);
  const normalizedSkillClass = cleanText(skillClass);
  const violations = [];

  if (normalizedSurfaceLayer === SKILL_SURFACE_INTERNAL_ONLY && normalizedSelectorMode !== SKILL_SELECTOR_MODE_DETERMINISTIC) {
    violations.push({
      code: "internal_only_skill_must_be_deterministic_only",
      message: "internal_only skills must remain deterministic-only and stay outside the strict planner catalog.",
    });
  }

  if (normalizedSurfaceLayer === SKILL_SURFACE_PLANNER_VISIBLE) {
    if (normalizedSelectorMode === SKILL_SELECTOR_MODE_DETERMINISTIC) {
      violations.push({
        code: "planner_visible_skill_cannot_be_deterministic_only",
        message: "planner_visible skills must be explicitly selectable and cannot stay hidden behind deterministic-only routing.",
      });
    }
    if (normalizedSkillClass !== SKILL_CLASS_READ_ONLY) {
      violations.push({
        code: "planner_visible_skill_must_be_read_only",
        message: "planner_visible skills must remain read-only in the current skill-surface policy.",
      });
    }
  }

  if (normalizedSurfaceLayer === SKILL_SURFACE_USER_FACING_CAPABILITY) {
    violations.push({
      code: "user_facing_skill_surface_not_enabled",
      message: "user-facing skill capabilities are reserved for future work and cannot be registered in the current baseline.",
    });
  }

  return Object.freeze({
    surface_layer: normalizedSurfaceLayer,
    planner_catalog_eligible: isPlannerCatalogEligibleSkillSurface(normalizedSurfaceLayer),
    raw_user_output_allowed: false,
    violations: Object.freeze(violations),
  });
}

export function buildPlannerSkillEnvelope(skillExecution = {}) {
  const skill = cleanText(skillExecution?.skill) || "unknown";

  if (skillExecution?.ok !== true) {
    return {
      ok: false,
      action: `skill:${skill}`,
      error: cleanText(skillExecution?.error) || "runtime_exception",
      data: {
        skill,
        stop_reason: cleanText(skillExecution?.failure_mode) || "fail_closed",
        phase: cleanText(skillExecution?.details?.phase) || null,
        side_effects: normalizePlannerSkillSideEffects(skillExecution?.side_effects),
      },
      trace_id: cleanText(skillExecution?.trace_id) || null,
    };
  }

  const output = skillExecution?.output && typeof skillExecution.output === "object" && !Array.isArray(skillExecution.output)
    ? skillExecution.output
    : {};

  return {
    ok: true,
    action: `skill:${skill}`,
    data: {
      skill,
      ...(cleanText(output.query) ? { query: cleanText(output.query) } : {}),
      ...(cleanText(output.doc_id) ? { doc_id: cleanText(output.doc_id) } : {}),
      ...(cleanText(output.title) ? { title: cleanText(output.title) } : {}),
      summary: cleanText(output.summary) || null,
      hits: Number.isFinite(output.hits) ? Number(output.hits) : 0,
      found: output.found === true,
      sources: normalizePlannerSkillSources(output.sources),
      limitations: normalizeStringList(output.limitations),
      side_effects: normalizePlannerSkillSideEffects(skillExecution?.side_effects),
    },
    trace_id: cleanText(skillExecution?.trace_id) || null,
  };
}

export function createPlannerSkillActionRegistry(entries = []) {
  const registry = new Map();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const action = cleanText(entry?.action);
    const skillName = cleanText(entry?.skill_name);
    if (!action || !skillName) {
      continue;
    }
    const governance = buildSkillGovernanceView({
      skill_class: entry.skill_class,
      runtime_access: entry.runtime_access,
      allowed_side_effects: entry.allowed_side_effects,
    });
    const selector = normalizePlannerSkillSelector(entry);
    const surfacePolicy = buildPlannerSkillSurfacePolicy({
      surfaceLayer: entry.surface_layer,
      selectorMode: selector.selector_mode,
      skillClass: governance.skill_class,
    });
    if (surfacePolicy.violations.length > 0) {
      throw new Error("invalid_planner_skill_surface_policy");
    }
    const selectorKey = cleanText(entry?.selector_key) || action;

    registry.set(action, Object.freeze({
      action,
      skill_name: skillName,
      max_skills_per_run: governance.max_skills_per_run,
      allow_skill_chain: governance.allow_skill_chain,
      skill_class: governance.skill_class,
      runtime_access: governance.runtime_access,
      allowed_side_effects: governance.skill_class
        ? Object.freeze({
          read: Array.isArray(entry?.allowed_side_effects?.read)
            ? Object.freeze(entry.allowed_side_effects.read.map((item) => cleanText(item)).filter(Boolean))
            : Object.freeze([]),
          write: Array.isArray(entry?.allowed_side_effects?.write)
            ? Object.freeze(entry.allowed_side_effects.write.map((item) => cleanText(item)).filter(Boolean))
            : Object.freeze([]),
        })
        : Object.freeze({
          read: Object.freeze([]),
          write: Object.freeze([]),
        }),
      selector_mode: selector.selector_mode,
      selector_key: selectorKey,
      selector_task_types: selector.selector_task_types,
      routing_reason: selector.routing_reason,
      selection_reason: selector.selection_reason,
      surface_layer: surfacePolicy.surface_layer,
      planner_catalog_eligible: surfacePolicy.planner_catalog_eligible,
      raw_user_output_allowed: surfacePolicy.raw_user_output_allowed,
      buildSkillInput: typeof entry.buildSkillInput === "function"
        ? entry.buildSkillInput
        : (() => ({})),
    }));
  }

  return registry;
}

const plannerSkillActionRegistry = createPlannerSkillActionRegistry([
  {
    action: "search_and_summarize",
    skill_name: "search_and_summarize",
    surface_layer: "internal_only",
    skill_class: "read_only",
    runtime_access: ["read_runtime"],
    selector_mode: "deterministic_only",
    selector_key: "skill.search_and_summarize.read",
    selector_task_types: ["knowledge_read_skill", "skill_read"],
    routing_reason: "selector_search_and_summarize_skill",
    selection_reason: "呼叫端明確要求 read-only skill bridge，固定走單一 skill action。",
    allowed_side_effects: {
      read: ["search_knowledge_base"],
      write: [],
    },
    buildSkillInput(payload = {}) {
      const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {};
      const query = cleanText(normalizedPayload.q || normalizedPayload.query || "");
      return {
        account_id: cleanText(normalizedPayload.account_id) || "",
        query,
        limit: normalizedPayload.limit ?? null,
        pathname: normalizedPayload.pathname ?? null,
        reader_overrides: normalizedPayload.reader_overrides ?? null,
      };
    },
  },
  {
    action: "document_summarize",
    skill_name: "document_summarize",
    surface_layer: "internal_only",
    skill_class: "read_only",
    runtime_access: ["read_runtime"],
    selector_mode: "deterministic_only",
    selector_key: "skill.document_summarize.read",
    selector_task_types: ["document_summary_skill"],
    routing_reason: "selector_document_summarize_skill",
    selection_reason: "呼叫端明確要求文件摘要 read-only skill，固定走單一 skill action。",
    allowed_side_effects: {
      read: ["get_company_brain_doc_detail"],
      write: [],
    },
    buildSkillInput(payload = {}) {
      const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {};
      return {
        account_id: cleanText(normalizedPayload.account_id) || "",
        doc_id: cleanText(normalizedPayload.doc_id || normalizedPayload.document_id || normalizedPayload.id) || "",
        pathname: normalizedPayload.pathname ?? null,
        reader_overrides: normalizedPayload.reader_overrides ?? null,
      };
    },
  },
]);

export function listPlannerSkillActions() {
  return Array.from(plannerSkillActionRegistry.values()).map((entry) => ({
    action: entry.action,
    skill_name: entry.skill_name,
    surface_layer: entry.surface_layer,
    max_skills_per_run: entry.max_skills_per_run,
    allow_skill_chain: entry.allow_skill_chain,
    skill_class: entry.skill_class,
    runtime_access: entry.runtime_access,
    selector_mode: entry.selector_mode,
    selector_key: entry.selector_key,
    selector_task_types: entry.selector_task_types,
    routing_reason: entry.routing_reason,
    planner_catalog_eligible: entry.planner_catalog_eligible,
    raw_user_output_allowed: entry.raw_user_output_allowed,
    allowed_side_effects: entry.allowed_side_effects,
  }));
}

export function getPlannerSkillAction(action = "") {
  return plannerSkillActionRegistry.get(cleanText(action));
}

export function isPlannerSkillActionCatalogVisible(action = "") {
  return getPlannerSkillAction(action)?.planner_catalog_eligible === true;
}

export function selectPlannerSkillActionForTaskType({
  taskType = "",
  registry = plannerSkillActionRegistry,
} = {}) {
  const normalizedTaskType = cleanText(String(taskType || "").toLowerCase());
  if (!normalizedTaskType || !(registry instanceof Map)) {
    return {
      ok: false,
      action: null,
      routing_reason: "routing_no_match",
      reason: "",
      error: "not_found",
    };
  }

  const matches = [...registry.values()].filter((entry) => (
    entry.selector_mode === "deterministic_only"
    && Array.isArray(entry.selector_task_types)
    && entry.selector_task_types.includes(normalizedTaskType)
  ));

  if (matches.length !== 1) {
    return {
      ok: false,
      action: null,
      routing_reason: matches.length > 1 ? "selector_skill_conflict" : "routing_no_match",
      reason: "",
      error: matches.length > 1 ? "selector_conflict" : "not_found",
    };
  }

  const selectedEntry = matches[0];
  const selectorKey = cleanText(selectedEntry.selector_key);
  const selectorKeyConflicts = selectorKey
    ? [...registry.values()].filter((entry) => cleanText(entry.selector_key) === selectorKey)
    : [];
  if (selectorKey && selectorKeyConflicts.length > 1) {
    return {
      ok: false,
      action: null,
      routing_reason: "selector_skill_conflict",
      reason: "",
      error: "selector_conflict",
    };
  }

  return {
    ok: true,
    action: selectedEntry.action,
    skill_name: selectedEntry.skill_name,
    routing_reason: selectedEntry.routing_reason || `selector_${selectedEntry.action}_skill`,
    reason: selectedEntry.selection_reason || "命中 deterministic skill selector。",
  };
}

export async function runPlannerSkillBridge({
  action = "",
  payload = {},
  logger = null,
  signal = null,
  registry = defaultSkillRegistry,
} = {}) {
  const skillAction = getPlannerSkillAction(action);
  if (!skillAction) {
    return {
      ok: false,
      action: cleanText(action) || null,
      error: "invalid_action",
      data: {
        bridge: "skill_bridge",
        message: "planner_skill_action_not_found",
        stopped: true,
        stop_reason: "invalid_action",
      },
      trace_id: null,
    };
  }

  const skillExecution = await runSkill({
    registry,
    skillName: skillAction.skill_name,
    input: skillAction.buildSkillInput(payload),
    logger,
    signal,
  });
  const envelope = buildPlannerSkillEnvelope(skillExecution);
  const bridgeData = envelope?.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
    ? envelope.data
    : {};

  if (envelope?.ok !== true) {
    return {
      ok: false,
      action: skillAction.action,
      error: cleanText(envelope?.error) || "runtime_exception",
      data: {
        ...bridgeData,
        skill: cleanText(bridgeData.skill) || skillAction.skill_name,
        bridge: "skill_bridge",
        max_skills_per_run: skillAction.max_skills_per_run,
        allow_skill_chain: skillAction.allow_skill_chain,
      },
      trace_id: envelope?.trace_id || null,
    };
  }

  return {
    ok: true,
    action: skillAction.action,
    data: {
      ...bridgeData,
      skill: cleanText(bridgeData.skill) || skillAction.skill_name,
      bridge: "skill_bridge",
      max_skills_per_run: skillAction.max_skills_per_run,
      allow_skill_chain: skillAction.allow_skill_chain,
    },
    trace_id: envelope?.trace_id || null,
  };
}
