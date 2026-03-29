import { cleanText } from "./message-intent-utils.mjs";

function normalizeSchemaTypeList(schema = null) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map((item) => cleanText(item)).filter(Boolean);
  }
  const single = cleanText(schema.type);
  return single ? [single] : [];
}

function matchesSchemaType(expectedType = "", value) {
  if (expectedType === "null") {
    return value === null;
  }
  if (expectedType === "array") {
    return Array.isArray(value);
  }
  if (expectedType === "boolean") {
    return typeof value === "boolean";
  }
  if (expectedType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (expectedType === "string") {
    return typeof value === "string";
  }
  if (expectedType === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return true;
}

export function validateSkillSchema(schema = null, value, path = "$") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [];
  }

  const violations = [];
  const expectedTypes = normalizeSchemaTypeList(schema);
  if (expectedTypes.length > 0) {
    const matched = expectedTypes.some((expectedType) => matchesSchemaType(expectedType, value));
    if (!matched) {
      violations.push({
        type: "type",
        code: "type_mismatch",
        path,
        expected: expectedTypes.join("|"),
        actual: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        message: `Expected ${path} to be ${expectedTypes.join("|")}.`,
      });
      return violations;
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (const [index, item] of value.entries()) {
      violations.push(...validateSkillSchema(schema.items, item, `${path}[${index}]`));
    }
    return violations;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return violations;
  }

  if (Array.isArray(schema.required)) {
    for (const requiredKey of schema.required) {
      if (!(requiredKey in value)) {
        violations.push({
          type: "required",
          code: "missing_required",
          path: `${path}.${requiredKey}`,
          expected: "present",
          actual: "missing",
          message: `Missing required field ${path}.${requiredKey}.`,
        });
      }
    }
  }

  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    return violations;
  }

  for (const [propertyKey, propertySchema] of Object.entries(schema.properties)) {
    if (!(propertyKey in value)) {
      continue;
    }
    violations.push(...validateSkillSchema(propertySchema, value[propertyKey], `${path}.${propertyKey}`));
  }

  return violations;
}

function normalizeSideEffectList(items = []) {
  if (!Array.isArray(items)) {
    return [];
  }
  return Array.from(new Set(items.map((item) => cleanText(item)).filter(Boolean))).sort();
}

export function normalizeAllowedSideEffects(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({
      read: Object.freeze([]),
      write: Object.freeze([]),
    });
  }
  return Object.freeze({
    read: Object.freeze(normalizeSideEffectList(value.read)),
    write: Object.freeze(normalizeSideEffectList(value.write)),
  });
}

export function createSkillDefinition(definition = {}) {
  const name = cleanText(definition.name);
  if (!name) {
    throw new Error("invalid_skill_definition");
  }

  const run = definition.run;
  if (typeof run !== "function") {
    throw new Error("invalid_skill_definition");
  }

  return Object.freeze({
    name,
    input_schema:
      definition.input_schema && typeof definition.input_schema === "object" && !Array.isArray(definition.input_schema)
        ? definition.input_schema
        : { type: "object" },
    output_schema:
      definition.output_schema && typeof definition.output_schema === "object" && !Array.isArray(definition.output_schema)
        ? definition.output_schema
        : { type: "object" },
    allowed_side_effects: normalizeAllowedSideEffects(definition.allowed_side_effects),
    failure_mode: cleanText(definition.failure_mode) || "fail_closed",
    run,
  });
}

export function buildSkillContractView(definition = {}) {
  return {
    name: cleanText(definition.name) || null,
    input_schema: definition.input_schema && typeof definition.input_schema === "object" ? definition.input_schema : null,
    output_schema: definition.output_schema && typeof definition.output_schema === "object" ? definition.output_schema : null,
    allowed_side_effects: normalizeAllowedSideEffects(definition.allowed_side_effects),
    failure_mode: cleanText(definition.failure_mode) || "fail_closed",
  };
}
