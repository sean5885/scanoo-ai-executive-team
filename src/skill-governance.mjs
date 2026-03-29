import { cleanText } from "./message-intent-utils.mjs";

export const SKILL_CLASS_READ_ONLY = "read_only";
export const SKILL_CLASS_WRITE = "write";
export const SKILL_CLASS_HYBRID = "hybrid";
export const SKILL_SELECTOR_MODE_DETERMINISTIC = "deterministic_only";
export const SKILL_SELECTOR_MODE_MANUAL = "manual_only";
export const SKILL_RUNTIME_ACCESS_READ = "read_runtime";
export const SKILL_RUNTIME_ACCESS_WRITE = "mutation_runtime";
export const DEFAULT_MAX_SKILLS_PER_RUN = 1;
export const DEFAULT_ALLOW_SKILL_CHAIN = false;

const VALID_SKILL_CLASSES = Object.freeze([
  SKILL_CLASS_READ_ONLY,
  SKILL_CLASS_WRITE,
  SKILL_CLASS_HYBRID,
]);

const VALID_SELECTOR_MODES = Object.freeze([
  SKILL_SELECTOR_MODE_DETERMINISTIC,
  SKILL_SELECTOR_MODE_MANUAL,
]);

const VALID_RUNTIME_ACCESS = Object.freeze([
  SKILL_RUNTIME_ACCESS_READ,
  SKILL_RUNTIME_ACCESS_WRITE,
]);

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeStringList(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return Array.from(new Set(items.map((item) => cleanText(item)).filter(Boolean))).sort();
}

function freezeSerializableValue(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeSerializableValue(item)));
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = freezeSerializableValue(entry);
    }
    return Object.freeze(result);
  }
  return value;
}

export function inferSkillClassFromSideEffects(allowedSideEffects = {}) {
  const readCount = Array.isArray(allowedSideEffects?.read) ? allowedSideEffects.read.length : 0;
  const writeCount = Array.isArray(allowedSideEffects?.write) ? allowedSideEffects.write.length : 0;

  if (readCount > 0 && writeCount > 0) {
    return SKILL_CLASS_HYBRID;
  }
  if (writeCount > 0) {
    return SKILL_CLASS_WRITE;
  }
  return SKILL_CLASS_READ_ONLY;
}

export function normalizeRuntimeAccess(items = []) {
  return Object.freeze(normalizeStringList(items).filter((item) => VALID_RUNTIME_ACCESS.includes(item)));
}

export function buildDefaultRuntimeAccessForSkillClass(skillClass = SKILL_CLASS_READ_ONLY) {
  if (skillClass === SKILL_CLASS_HYBRID) {
    return Object.freeze([SKILL_RUNTIME_ACCESS_READ, SKILL_RUNTIME_ACCESS_WRITE]);
  }
  if (skillClass === SKILL_CLASS_WRITE) {
    return Object.freeze([SKILL_RUNTIME_ACCESS_WRITE]);
  }
  return Object.freeze([SKILL_RUNTIME_ACCESS_READ]);
}

export function normalizeSkillGovernance(definition = {}) {
  const inferredClass = inferSkillClassFromSideEffects(definition.allowed_side_effects);
  const skillClass = VALID_SKILL_CLASSES.includes(cleanText(definition.skill_class))
    ? cleanText(definition.skill_class)
    : inferredClass;
  const declaredRuntimeAccess = normalizeRuntimeAccess(definition.runtime_access);
  const runtimeAccess = declaredRuntimeAccess.length > 0
    ? declaredRuntimeAccess
    : buildDefaultRuntimeAccessForSkillClass(skillClass);

  return Object.freeze({
    skill_class: skillClass,
    runtime_access: runtimeAccess,
    max_skills_per_run: DEFAULT_MAX_SKILLS_PER_RUN,
    allow_skill_chain: DEFAULT_ALLOW_SKILL_CHAIN,
    input_must_be_serializable: true,
    output_must_be_serializable: true,
    disallow_side_channel_repo_db_access: true,
  });
}

export function validateSkillGovernance(definition = {}) {
  const violations = [];
  const declaredSkillClass = cleanText(definition.skill_class);
  const runtimeAccess = normalizeRuntimeAccess(definition.runtime_access);
  const inferredClass = inferSkillClassFromSideEffects(definition.allowed_side_effects);

  if (!VALID_SKILL_CLASSES.includes(declaredSkillClass)) {
    violations.push({
      code: "invalid_skill_class",
      field: "skill_class",
      message: "skill_class must be one of read_only, write, hybrid.",
    });
  }

  if (!Array.isArray(definition.runtime_access) || runtimeAccess.length === 0) {
    violations.push({
      code: "missing_runtime_access",
      field: "runtime_access",
      message: "runtime_access must declare read_runtime and/or mutation_runtime.",
    });
  }

  if (runtimeAccess.includes(SKILL_RUNTIME_ACCESS_READ) && !runtimeAccess.includes(SKILL_RUNTIME_ACCESS_WRITE)) {
    if (declaredSkillClass === SKILL_CLASS_WRITE) {
      violations.push({
        code: "skill_class_runtime_access_mismatch",
        field: "runtime_access",
        message: "write skills cannot be read_runtime-only.",
      });
    }
  }

  if (!runtimeAccess.includes(SKILL_RUNTIME_ACCESS_READ) && runtimeAccess.includes(SKILL_RUNTIME_ACCESS_WRITE)) {
    if (declaredSkillClass === SKILL_CLASS_READ_ONLY) {
      violations.push({
        code: "skill_class_runtime_access_mismatch",
        field: "runtime_access",
        message: "read_only skills cannot be mutation_runtime-only.",
      });
    }
  }

  if (
    declaredSkillClass === SKILL_CLASS_HYBRID
    && (!runtimeAccess.includes(SKILL_RUNTIME_ACCESS_READ) || !runtimeAccess.includes(SKILL_RUNTIME_ACCESS_WRITE))
  ) {
    violations.push({
      code: "skill_class_runtime_access_mismatch",
      field: "runtime_access",
      message: "hybrid skills must declare both read_runtime and mutation_runtime.",
    });
  }

  if (VALID_SKILL_CLASSES.includes(declaredSkillClass) && declaredSkillClass !== inferredClass) {
    violations.push({
      code: "skill_class_side_effect_mismatch",
      field: "skill_class",
      message: `skill_class ${declaredSkillClass} does not match allowed_side_effects-derived class ${inferredClass}.`,
    });
  }

  return violations;
}

export function validateSerializableValue(value, path = "$") {
  const violations = [];

  if (value === null) {
    return violations;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return violations;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return violations;
    }
    violations.push({
      code: "non_serializable_number",
      path,
      message: `${path} must be a finite number.`,
    });
    return violations;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      violations.push(...validateSerializableValue(entry, `${path}[${index}]`));
    });
    return violations;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      violations.push(...validateSerializableValue(entry, `${path}.${key}`));
    }
    return violations;
  }

  violations.push({
    code: "non_serializable_value",
    path,
    message: `${path} must be JSON-serializable plain data.`,
  });
  return violations;
}

export function cloneSerializableValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneSerializableValue(entry));
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = cloneSerializableValue(entry);
    }
    return result;
  }
  return value;
}

export function buildSkillGovernanceView(definition = {}) {
  return freezeSerializableValue(normalizeSkillGovernance(definition));
}

export function normalizePlannerSkillSelector(entry = {}) {
  const selectorMode = VALID_SELECTOR_MODES.includes(cleanText(entry.selector_mode))
    ? cleanText(entry.selector_mode)
    : SKILL_SELECTOR_MODE_DETERMINISTIC;

  return Object.freeze({
    selector_mode: selectorMode,
    selector_task_types: Object.freeze(normalizeStringList(entry.selector_task_types)),
    routing_reason: cleanText(entry.routing_reason) || null,
    selection_reason: cleanText(entry.selection_reason) || null,
  });
}
