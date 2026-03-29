import { cleanText } from "./message-intent-utils.mjs";
import {
  buildSkillContractView,
  validateSkillSchema,
} from "./skill-contract.mjs";

function normalizeEffectEntry(entry = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const mode = cleanText(entry.mode);
  const action = cleanText(entry.action);
  if (!mode || !action) {
    return null;
  }
  return {
    mode,
    action,
    runtime: cleanText(entry.runtime) || null,
    authority: cleanText(entry.authority) || null,
  };
}

function normalizeEffectEntries(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => normalizeEffectEntry(item))
    .filter(Boolean);
}

function buildSkillFailure({
  skill = "",
  error = "runtime_exception",
  failureMode = "fail_closed",
  phase = "",
  details = {},
  sideEffects = [],
  traceId = null,
} = {}) {
  return {
    ok: false,
    skill: cleanText(skill) || null,
    failure_mode: cleanText(failureMode) || "fail_closed",
    error: cleanText(error) || "runtime_exception",
    output: null,
    side_effects: normalizeEffectEntries(sideEffects),
    trace_id: cleanText(traceId) || null,
    details: {
      phase: cleanText(phase) || null,
      ...(details && typeof details === "object" && !Array.isArray(details) ? details : {}),
    },
  };
}

function validateSideEffectsAllowed(sideEffects = [], allowed = {}) {
  const violations = [];
  const readAllowed = Array.isArray(allowed.read) ? allowed.read : [];
  const writeAllowed = Array.isArray(allowed.write) ? allowed.write : [];

  for (const [index, effect] of normalizeEffectEntries(sideEffects).entries()) {
    if (effect.mode === "read" && readAllowed.includes(effect.action)) {
      continue;
    }
    if (effect.mode === "write" && writeAllowed.includes(effect.action)) {
      continue;
    }
    violations.push({
      type: "side_effect",
      code: "side_effect_not_allowed",
      path: `side_effects[${index}]`,
      expected: effect.mode === "write" ? writeAllowed.join("|") || "none" : readAllowed.join("|") || "none",
      actual: `${effect.mode}:${effect.action}`,
      message: `Side effect ${effect.mode}:${effect.action} is not allowed by the skill contract.`,
    });
  }

  return violations;
}

export function createSkillRegistry(definitions = []) {
  const registry = new Map();
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    if (!definition || typeof definition !== "object") {
      continue;
    }
    registry.set(definition.name, definition);
  }
  return registry;
}

export function listSkillContracts({ registry = null } = {}) {
  if (!(registry instanceof Map)) {
    return [];
  }
  return [...registry.values()].map((definition) => buildSkillContractView(definition));
}

export async function runSkill({
  registry = null,
  skillName = "",
  input = {},
  logger = null,
  signal = null,
} = {}) {
  const skill = registry instanceof Map ? registry.get(cleanText(skillName)) : null;
  if (!skill) {
    return buildSkillFailure({
      skill: cleanText(skillName),
      error: "not_found",
      phase: "definition",
      details: {
        message: "skill_not_found",
      },
    });
  }

  const inputViolations = validateSkillSchema(skill.input_schema, input, "$input");
  if (inputViolations.length > 0) {
    return buildSkillFailure({
      skill: skill.name,
      error: "contract_violation",
      failureMode: skill.failure_mode,
      phase: "input_validation",
      details: {
        violations: inputViolations,
      },
    });
  }

  let execution = null;
  try {
    execution = await skill.run({
      input,
      logger,
      signal,
    });
  } catch {
    return buildSkillFailure({
      skill: skill.name,
      error: "runtime_exception",
      failureMode: skill.failure_mode,
      phase: "execution",
    });
  }

  if (execution?.ok === false) {
    return buildSkillFailure({
      skill: skill.name,
      error: cleanText(execution.error) || "runtime_exception",
      failureMode: skill.failure_mode,
      phase: cleanText(execution.details?.phase) || "execution",
      details: execution.details,
      sideEffects: execution.side_effects,
      traceId: execution.trace_id,
    });
  }

  if (execution?.ok !== true) {
    return buildSkillFailure({
      skill: skill.name,
      error: "contract_violation",
      failureMode: skill.failure_mode,
      phase: "execution_result",
      details: {
        message: "invalid_skill_execution_result",
      },
    });
  }

  const sideEffects = normalizeEffectEntries(execution.side_effects);
  const sideEffectViolations = validateSideEffectsAllowed(sideEffects, skill.allowed_side_effects);
  if (sideEffectViolations.length > 0) {
    return buildSkillFailure({
      skill: skill.name,
      error: "contract_violation",
      failureMode: skill.failure_mode,
      phase: "side_effect_validation",
      details: {
        violations: sideEffectViolations,
      },
      sideEffects,
      traceId: execution.trace_id,
    });
  }

  const outputViolations = validateSkillSchema(skill.output_schema, execution.output, "$output");
  if (outputViolations.length > 0) {
    return buildSkillFailure({
      skill: skill.name,
      error: "contract_violation",
      failureMode: skill.failure_mode,
      phase: "output_validation",
      details: {
        violations: outputViolations,
      },
      sideEffects,
      traceId: execution.trace_id,
    });
  }

  return {
    ok: true,
    skill: skill.name,
    failure_mode: skill.failure_mode,
    output: execution.output,
    side_effects: sideEffects,
    trace_id: cleanText(execution.trace_id) || null,
    details: {
      phase: "completed",
    },
  };
}
