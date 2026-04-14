export const SKILL_CONTRACT = Object.freeze({
  intent: "Generate an image result through a bounded backend when available.",
  success_criteria: "Return a backend-generated image URL and normalized prompt.",
  failure_criteria: "Fail closed when prompt input is missing or when the image backend is unavailable.",
});

import { cleanText } from "../message-intent-utils.mjs";
import { createSkillDefinition } from "../skill-contract.mjs";

export async function image_generate({ input } = {}) {
  const prompt = cleanText(
    typeof input === "string"
      ? input
      : input?.prompt ?? input?.input ?? input?.query ?? "",
  );

  if (!prompt) {
    return {
      ok: false,
      error: "contract_violation",
      details: {
        phase: "input_validation",
        violations: [
          {
            type: "required",
            code: "missing_required",
            path: "$input.prompt",
            expected: "non_empty_string",
            actual: "empty",
            message: "Missing required field $input.prompt.",
          },
        ],
      },
    };
  }

  return {
    ok: false,
    error: "business_error",
    details: {
      phase: "execution",
      failure_class: "capability_gap",
      reason: "image_backend_unavailable",
      message: "image_generation_backend_unavailable",
      prompt,
      intent_unfulfilled: true,
      criteria_failed: [
        "image_backend_ready",
        "image_asset_generated",
      ],
    },
    side_effects: [],
  };
}

export const imageGenerateSkill = createSkillDefinition({
  name: "image_generate",
  input_schema: {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
    },
  },
  output_schema: {
    type: "object",
    required: ["prompt", "url"],
    properties: {
      prompt: { type: "string" },
      url: { type: "string" },
    },
  },
  allowed_side_effects: {
    read: [],
    write: [],
  },
  skill_class: "read_only",
  runtime_access: ["read_runtime"],
  failure_mode: "fail_closed",
  async run({ input }) {
    return image_generate({ input });
  },
});
