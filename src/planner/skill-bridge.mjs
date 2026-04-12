import { runToolLoop } from './tool-loop.mjs';
import { cleanText } from "../message-intent-utils.mjs";
import { emitSkillReflection } from "../reflection/skill-reflection.mjs";
import { defaultSkillRegistry } from "../skill-registry.mjs";
import { runSkill } from "../skill-runtime.mjs";
import {
  SKILL_CLASS_READ_ONLY,
  SKILL_SELECTOR_MODE_DETERMINISTIC,
  SKILL_RUNTIME_ACCESS_READ,
  buildSkillGovernanceView,
  isPlannerCatalogEligibleSkillSurface,
  normalizeSkillSurface,
  normalizePlannerSkillSelector,
  SKILL_SURFACE_INTERNAL_ONLY,
  SKILL_SURFACE_PLANNER_VISIBLE,
  SKILL_SURFACE_USER_FACING_CAPABILITY,
} from "../skill-governance.mjs";

const SKILL_PROMOTION_STAGE_INTERNAL_ONLY = "internal_only";
const SKILL_PROMOTION_STAGE_READINESS_CHECK = "readiness_check";
const SKILL_PROMOTION_STAGE_PLANNER_VISIBLE = "planner_visible";
const VALID_SKILL_PROMOTION_STAGES = Object.freeze([
  SKILL_PROMOTION_STAGE_INTERNAL_ONLY,
  SKILL_PROMOTION_STAGE_READINESS_CHECK,
  SKILL_PROMOTION_STAGE_PLANNER_VISIBLE,
]);

const WRITE_ACTIONS = Object.freeze([
  "send_message",
  "update_doc",
  "create_task",
  "write_memory",
  "update_record",
]);

const READ_ONLY_SKILLS = Object.freeze([
  "search_and_summarize",
  "document_summarize",
  "search_company_brain_docs",
  "official_read_document",
]);

function isWriteAction(action = "") {
  return WRITE_ACTIONS.includes(cleanText(action));
}

function isReadOnlySkill(skillName = "") {
  return READ_ONLY_SKILLS.includes(cleanText(skillName));
}

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

function normalizePlannerSkillPromotionStage(value = "") {
  const normalized = cleanText(value);
  return VALID_SKILL_PROMOTION_STAGES.includes(normalized)
    ? normalized
    : SKILL_PROMOTION_STAGE_INTERNAL_ONLY;
}

function normalizePlannerSkillUpgradePath(entry = {}) {
  const currentStage = normalizePlannerSkillPromotionStage(entry?.promotion_stage || entry?.surface_layer);
  const previousStageRaw = cleanText(entry?.previous_promotion_stage);
  const previousStage = VALID_SKILL_PROMOTION_STAGES.includes(previousStageRaw)
    ? previousStageRaw
    : null;

  return Object.freeze({
    current_stage: currentStage,
    previous_stage: previousStage,
  });
}

function normalizePlannerSkillReadinessGate(entry = {}) {
  const rawGate = entry?.readiness_gate && typeof entry.readiness_gate === "object" && !Array.isArray(entry.readiness_gate)
    ? entry.readiness_gate
    : {};

  return Object.freeze({
    regression_suite_passed: rawGate.regression_suite_passed === true,
    answer_pipeline_enforced: rawGate.answer_pipeline_enforced === true,
    observability_evidence_verified: rawGate.observability_evidence_verified === true,
    raw_skill_output_blocked: rawGate.raw_skill_output_blocked === true,
    output_shape_stable: rawGate.output_shape_stable === true,
    side_effect_boundary_locked: rawGate.side_effect_boundary_locked === true,
  });
}

function normalizePlannerSkillAdmissionBoundary(entry = {}) {
  const rawBoundary = entry?.planner_admission_boundary
    && typeof entry.planner_admission_boundary === "object"
    && !Array.isArray(entry.planner_admission_boundary)
    ? entry.planner_admission_boundary
    : {};

  return Object.freeze({
    require_signals: Object.freeze(normalizeStringList(rawBoundary.require_signals)),
    forbid_signals: Object.freeze(normalizeStringList(rawBoundary.forbid_signals)),
    fail_closed_on_ambiguity: rawBoundary.fail_closed_on_ambiguity !== false,
  });
}

function intersectStringLists(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return [];
  }
  const rightSet = new Set(right.map((item) => cleanText(item)).filter(Boolean));
  return left
    .map((item) => cleanText(item))
    .filter((item) => item && rightSet.has(item));
}

function buildPlannerSkillSurfacePolicy({
  surfaceLayer = "",
  selectorMode = "",
  skillClass = "",
  runtimeAccess = [],
  allowedSideEffects = {},
  upgradePath = {},
  readinessGate = {},
} = {}) {
  const normalizedSurfaceLayer = normalizeSkillSurface(surfaceLayer);
  const normalizedSelectorMode = cleanText(selectorMode);
  const normalizedSkillClass = cleanText(skillClass);
  const normalizedRuntimeAccess = Array.isArray(runtimeAccess)
    ? runtimeAccess.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const declaredWriteSideEffects = Array.isArray(allowedSideEffects?.write)
    ? allowedSideEffects.write.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const violations = [];
  const isReadinessCheckStage = upgradePath.current_stage === SKILL_PROMOTION_STAGE_READINESS_CHECK;

  if (
    normalizedSurfaceLayer === SKILL_SURFACE_INTERNAL_ONLY
    && normalizedSelectorMode !== SKILL_SELECTOR_MODE_DETERMINISTIC
  ) {
    violations.push({
      code: "internal_only_skill_must_be_deterministic_only",
      message: "internal_only skills must remain deterministic-only and stay outside the strict planner catalog.",
    });
  }

  if (
    normalizedSurfaceLayer === SKILL_SURFACE_INTERNAL_ONLY
    && upgradePath.current_stage === SKILL_PROMOTION_STAGE_PLANNER_VISIBLE
  ) {
    violations.push({
      code: "skill_surface_stage_mismatch",
      message: "planner_visible promotion stage cannot be combined with an internal_only surface.",
    });
  }

  if (isReadinessCheckStage) {
    if (normalizedSurfaceLayer !== SKILL_SURFACE_INTERNAL_ONLY) {
      violations.push({
        code: "readiness_check_surface_mismatch",
        message: "readiness_check candidates must remain internal_only until a later planner_visible promotion.",
      });
    }
    if (upgradePath.previous_stage !== SKILL_PROMOTION_STAGE_INTERNAL_ONLY) {
      violations.push({
        code: "readiness_check_previous_stage_required",
        message: "readiness_check candidates must record previous_promotion_stage=internal_only.",
      });
    }
    if (normalizedSelectorMode !== SKILL_SELECTOR_MODE_DETERMINISTIC) {
      violations.push({
        code: "readiness_check_skill_must_be_deterministic_only",
        message: "readiness_check candidates must keep deterministic selector wiring with no conflicts.",
      });
    }
    if (normalizedSkillClass !== SKILL_CLASS_READ_ONLY) {
      violations.push({
        code: "readiness_check_skill_must_be_read_only",
        message: "readiness_check candidates must remain read-only.",
      });
    }
    if (
      normalizedRuntimeAccess.length !== 1
      || normalizedRuntimeAccess[0] !== SKILL_RUNTIME_ACCESS_READ
    ) {
      violations.push({
        code: "readiness_check_skill_must_be_read_runtime_only",
        message: "readiness_check candidates must stay on read_runtime only.",
      });
    }
    if (declaredWriteSideEffects.length > 0) {
      violations.push({
        code: "readiness_check_skill_write_side_effect_not_allowed",
        message: "readiness_check candidates must not declare write side effects.",
      });
    }
    if (readinessGate.regression_suite_passed !== true) {
      violations.push({
        code: "readiness_check_requires_regression_pass",
        message: "readiness_check requires a checked regression pass before metadata can advance.",
      });
    }
    if (readinessGate.answer_pipeline_enforced !== true) {
      violations.push({
        code: "readiness_check_answer_pipeline_bypass",
        message: "readiness_check candidates must keep the existing answer pipeline in front of user replies.",
      });
    }
    if (readinessGate.observability_evidence_verified !== true) {
      violations.push({
        code: "readiness_check_observability_evidence_missing",
        message: "readiness_check candidates must prove selector, tool, and answer-boundary observability evidence before metadata can advance.",
      });
    }
    if (readinessGate.raw_skill_output_blocked !== true) {
      violations.push({
        code: "readiness_check_raw_output_exposed",
        message: "readiness_check candidates must keep raw skill output hidden behind the answer layer.",
      });
    }
    if (readinessGate.output_shape_stable !== true) {
      violations.push({
        code: "readiness_check_output_shape_unstable",
        message: "readiness_check candidates must prove a stable checked output shape.",
      });
    }
    if (readinessGate.side_effect_boundary_locked !== true) {
      violations.push({
        code: "readiness_check_side_effect_boundary_unstable",
        message: "readiness_check candidates must keep side effects within the declared read-only boundary.",
      });
    }
  }

  if (normalizedSurfaceLayer === SKILL_SURFACE_PLANNER_VISIBLE) {
    if (upgradePath.current_stage !== SKILL_PROMOTION_STAGE_PLANNER_VISIBLE) {
      violations.push({
        code: "planner_visible_stage_mismatch",
        message: "planner_visible skills must declare promotion_stage=planner_visible.",
      });
    }
    if (upgradePath.previous_stage !== SKILL_PROMOTION_STAGE_READINESS_CHECK) {
      violations.push({
        code: "planner_visible_direct_jump_not_allowed",
        message: "planner-visible promotion must pass through readiness_check and cannot jump directly from internal_only.",
      });
    }
    if (normalizedSelectorMode !== SKILL_SELECTOR_MODE_DETERMINISTIC) {
      violations.push({
        code: "planner_visible_skill_must_be_deterministic_only",
        message: "planner_visible skills must keep deterministic selector wiring with no conflicts.",
      });
    }
    if (normalizedSkillClass !== SKILL_CLASS_READ_ONLY) {
      violations.push({
        code: "planner_visible_skill_must_be_read_only",
        message: "planner_visible skills must remain read-only in the current skill-surface policy.",
      });
    }
    if (
      normalizedRuntimeAccess.length !== 1
      || normalizedRuntimeAccess[0] !== SKILL_RUNTIME_ACCESS_READ
    ) {
      violations.push({
        code: "planner_visible_skill_must_be_read_runtime_only",
        message: "planner_visible skills must stay on read_runtime only.",
      });
    }
    if (declaredWriteSideEffects.length > 0) {
      violations.push({
        code: "planner_visible_skill_write_side_effect_not_allowed",
        message: "planner_visible skills must not declare write side effects.",
      });
    }
    if (readinessGate.regression_suite_passed !== true) {
      violations.push({
        code: "planner_visible_skill_requires_regression_pass",
        message: "planner_visible promotion requires a checked readiness_check with full regression pass.",
      });
    }
    if (readinessGate.answer_pipeline_enforced !== true) {
      violations.push({
        code: "planner_visible_skill_answer_pipeline_bypass",
        message: "planner_visible skills must keep the existing answer pipeline in front of user replies.",
      });
    }
    if (readinessGate.observability_evidence_verified !== true) {
      violations.push({
        code: "planner_visible_skill_observability_evidence_missing",
        message: "planner_visible promotion requires checked observability evidence for selector, tool, and answer-boundary logs.",
      });
    }
    if (readinessGate.raw_skill_output_blocked !== true) {
      violations.push({
        code: "planner_visible_skill_raw_output_exposed",
        message: "raw skill output must remain hidden behind the answer layer.",
      });
    }
    if (readinessGate.output_shape_stable !== true) {
      violations.push({
        code: "planner_visible_skill_output_shape_unstable",
        message: "planner_visible promotion requires a stable checked output shape.",
      });
    }
    if (readinessGate.side_effect_boundary_locked !== true) {
      violations.push({
        code: "planner_visible_skill_side_effect_boundary_unstable",
        message: "planner_visible promotion requires side effects to stay within the declared read-only boundary.",
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
    planner_catalog_eligible: isPlannerCatalogEligibleSkillSurface(normalizedSurfaceLayer) && violations.length === 0,
    raw_user_output_allowed: false,
    promotion_stage: upgradePath.current_stage,
    previous_promotion_stage: upgradePath.previous_stage,
    readiness_gate: readinessGate,
    violations: Object.freeze(violations),
  });
}

function validatePlannerSkillRegistrySurfacePolicy(registry = new Map()) {
  if (!(registry instanceof Map)) {
    return [];
  }

  const entries = [...registry.values()];
  const candidateEntries = entries.filter((entry) => (
    entry.surface_layer === SKILL_SURFACE_PLANNER_VISIBLE
    || entry.promotion_stage === SKILL_PROMOTION_STAGE_READINESS_CHECK
    || entry.promotion_stage === SKILL_PROMOTION_STAGE_PLANNER_VISIBLE
  ));
  const violations = [];

  for (const entry of candidateEntries) {
    const selectorKey = cleanText(entry.selector_key);
    const selectorKeyConflicts = selectorKey
      ? entries.filter((other) => other.action !== entry.action && cleanText(other.selector_key) === selectorKey)
      : [];
    if (selectorKeyConflicts.length > 0) {
      violations.push({
        code: "planner_visible_selector_key_conflict",
        action: entry.action,
      });
    }

    const overlappingTaskTypes = entries
      .filter((other) => (
        other.action !== entry.action
        && cleanText(other.selector_mode) === SKILL_SELECTOR_MODE_DETERMINISTIC
      ))
      .flatMap((other) => intersectStringLists(entry.selector_task_types, other.selector_task_types));
    if (overlappingTaskTypes.length > 0) {
      violations.push({
        code: "planner_visible_selector_task_type_conflict",
        action: entry.action,
        task_types: Array.from(new Set(overlappingTaskTypes)),
      });
    }
  }

  return violations;
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
  const imageUrl = cleanText(output.url) || null;
  const imagePrompt = cleanText(output.prompt) || null;
  const hits = Number.isFinite(output.hits)
    ? Number(output.hits)
    : imageUrl
      ? 1
      : 0;
  const found = typeof output.found === "boolean"
    ? output.found
    : Boolean(imageUrl);

  return {
    ok: true,
    action: `skill:${skill}`,
    data: {
      skill,
      ...(cleanText(output.query) ? { query: cleanText(output.query) } : {}),
      ...(cleanText(output.doc_id) ? { doc_id: cleanText(output.doc_id) } : {}),
      ...(cleanText(output.title) ? { title: cleanText(output.title) } : {}),
      ...(imagePrompt ? { prompt: imagePrompt } : {}),
      ...(imageUrl ? { url: imageUrl } : {}),
      summary: cleanText(output.summary) || null,
      hits,
      found,
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
    const upgradePath = normalizePlannerSkillUpgradePath(entry);
    const readinessGate = normalizePlannerSkillReadinessGate(entry);
    const plannerAdmissionBoundary = normalizePlannerSkillAdmissionBoundary(entry);
    const surfacePolicy = buildPlannerSkillSurfacePolicy({
      surfaceLayer: entry.surface_layer,
      selectorMode: selector.selector_mode,
      skillClass: governance.skill_class,
      runtimeAccess: governance.runtime_access,
      allowedSideEffects: entry.allowed_side_effects,
      upgradePath,
      readinessGate,
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
      promotion_stage: surfacePolicy.promotion_stage,
      previous_promotion_stage: surfacePolicy.previous_promotion_stage,
      readiness_gate: surfacePolicy.readiness_gate,
      planner_admission_boundary: plannerAdmissionBoundary,
      buildSkillInput: typeof entry.buildSkillInput === "function"
        ? entry.buildSkillInput
        : (() => ({})),
    }));
  }

  const registryViolations = validatePlannerSkillRegistrySurfacePolicy(registry);
  if (registryViolations.length > 0) {
    throw new Error("invalid_planner_skill_surface_policy");
  }

  return registry;
}

const plannerSkillActionRegistry = createPlannerSkillActionRegistry([
  {
    action: "search_and_summarize",
    skill_name: "search_and_summarize",
    surface_layer: "planner_visible",
    promotion_stage: "planner_visible",
    previous_promotion_stage: "readiness_check",
    skill_class: "read_only",
    runtime_access: ["read_runtime"],
    selector_mode: "deterministic_only",
    selector_key: "skill.search_and_summarize.read",
    selector_task_types: ["knowledge_read_skill", "skill_read"],
    routing_reason: "selector_search_and_summarize_skill",
    selection_reason: "呼叫端明確要求 read-only skill bridge，固定走單一 skill action。",
    readiness_gate: {
      regression_suite_passed: true,
      answer_pipeline_enforced: true,
      observability_evidence_verified: true,
      raw_skill_output_blocked: true,
      output_shape_stable: true,
      side_effect_boundary_locked: true,
    },
    planner_admission_boundary: {
      require_signals: ["wants_document_search", "wants_search_summary"],
      forbid_signals: ["wants_document_detail", "wants_document_list", "explicit_same_task", "wants_scoped_doc_exclusion_search"],
      fail_closed_on_ambiguity: true,
    },
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
    action: "image_generate",
    skill_name: "image_generate",
    surface_layer: "internal_only",
    promotion_stage: "internal_only",
    skill_class: "read_only",
    runtime_access: ["read_runtime"],
    selector_mode: "deterministic_only",
    selector_key: "skill.image_generate.internal",
    selector_task_types: [],
    routing_reason: "selector_image_generate_skill",
    selection_reason: "內部 image skill bridge 會回傳受控 placeholder image 結果。",
    allowed_side_effects: {
      read: [],
      write: [],
    },
    buildSkillInput(payload = {}) {
      const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {};
      return {
        prompt: cleanText(
          normalizedPayload.prompt
          || normalizedPayload.input
          || normalizedPayload.query
          || "",
        ),
      };
    },
  },
  {
    action: "document_summarize",
    skill_name: "document_summarize",
    surface_layer: "planner_visible",
    promotion_stage: "planner_visible",
    previous_promotion_stage: "readiness_check",
    skill_class: "read_only",
    runtime_access: ["read_runtime"],
    selector_mode: "deterministic_only",
    selector_key: "skill.document_summarize.read",
    selector_task_types: ["document_summary_skill"],
    routing_reason: "selector_document_summarize_skill",
    selection_reason: "呼叫端明確要求文件摘要 read-only skill，固定走單一 skill action。",
    readiness_gate: {
      regression_suite_passed: true,
      answer_pipeline_enforced: true,
      observability_evidence_verified: true,
      raw_skill_output_blocked: true,
      output_shape_stable: true,
      side_effect_boundary_locked: true,
    },
    planner_admission_boundary: {
      require_signals: ["wants_document_summary", "wants_document_detail"],
      forbid_signals: ["wants_document_search", "wants_document_list", "wants_scoped_doc_exclusion_search", "explicit_same_task"],
      fail_closed_on_ambiguity: true,
    },
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

function listPlannerSkillEntriesForTaskType({
  taskType = "",
  registry = plannerSkillActionRegistry,
} = {}) {
  const normalizedTaskType = cleanText(String(taskType || "").toLowerCase());
  if (!normalizedTaskType || !(registry instanceof Map)) {
    return [];
  }
  return [...registry.values()].filter((entry) => (
    entry.selector_mode === "deterministic_only"
    && Array.isArray(entry.selector_task_types)
    && entry.selector_task_types.includes(normalizedTaskType)
  ));
}

export function buildPlannerSkillSelectionTelemetry({
  taskType = "",
  selection = null,
  registry = plannerSkillActionRegistry,
} = {}) {
  const normalizedTaskType = cleanText(String(taskType || "").toLowerCase());
  const matches = listPlannerSkillEntriesForTaskType({
    taskType: normalizedTaskType,
    registry,
  });
  const selectedEntry = selection?.ok === true
    ? registry.get(cleanText(selection?.action))
    : null;
  const fallbackEntry = selectedEntry || (matches.length === 1 ? matches[0] : null);
  const attempted = matches.length > 0;
  let selectorStatus = null;

  if (attempted) {
    selectorStatus = selection?.ok === true
      ? "selected"
      : cleanText(selection?.error) === "selector_conflict"
        ? "fail_closed_conflict"
        : "fail_closed_not_found";
  }

  return {
    skill_selector_attempted: attempted,
    skill_selector_task_type: attempted ? normalizedTaskType : null,
    skill_selector_match_count: attempted ? matches.length : 0,
    skill_selector_status: selectorStatus,
    skill_selector_fail_closed: attempted && selection?.ok !== true,
    skill_selector_key: cleanText(fallbackEntry?.selector_key) || null,
    skill_action: cleanText(fallbackEntry?.action) || null,
    skill_name: cleanText(fallbackEntry?.skill_name) || null,
    skill_surface_layer: cleanText(fallbackEntry?.surface_layer) || null,
    skill_promotion_stage: cleanText(fallbackEntry?.promotion_stage) || null,
    skill_catalog_eligible: fallbackEntry?.planner_catalog_eligible === true,
    skill_routing_reason: cleanText(selection?.routing_reason || fallbackEntry?.routing_reason) || null,
  };
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

  const matches = listPlannerSkillEntriesForTaskType({
    taskType: normalizedTaskType,
    registry,
  });

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
  const { plan, context } = payload || {};
  // === tool loop 注入（V1）===
  try {
    if (plan && plan.action && context) {
      const selectedSkill = cleanText(
        context?.selected_skill
        || context?.skill_name
        || plan?.skill_name
        || plan?.selected_skill
        || ""
      );
      const plannedAction = cleanText(
        plan?.action
        || plan?.tool_action
        || context?.action
        || context?.tool_action
        || ""
      );

      if (isReadOnlySkill(selectedSkill) && isWriteAction(plannedAction)) {
        return {
          ok: false,
          error: "read_only_skill_cannot_execute_write_action",
          blocked: true,
          skill: selectedSkill,
          action: plannedAction,
        };
      }

      return await runToolLoop({ plan, context, max_steps: 3 });
    }
  } catch (e) {}
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
  if (skillExecution?.ok === false) {
    emitSkillReflection({
      skill: cleanText(skillExecution?.skill) || skillAction.skill_name,
      action: skillAction.action,
      error: skillExecution?.error,
      failure_mode: skillExecution?.failure_mode,
      phase: skillExecution?.details?.phase,
      intent_unfulfilled: skillExecution?.details?.intent_unfulfilled === true,
      criteria_failed: skillExecution?.details?.criteria_failed,
      side_effects: skillExecution?.side_effects,
      trace_id: skillExecution?.trace_id,
    });
  }
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
