export const SKILL_CONTRACT = Object.freeze({
  intent: "Generate a deterministic placeholder image result through the checked-in image skill contract.",
  success_criteria: "Return a stable placeholder image URL and normalized prompt.",
  failure_criteria: "Return contract_violation when prompt input is missing or empty.",
});

import { cleanText } from "../message-intent-utils.mjs";
import { createSkillDefinition } from "../skill-contract.mjs";

function buildPlaceholderUrl(prompt = "") {
  const normalizedPrompt = cleanText(prompt) || "image";
  const encodedPrompt = encodeURIComponent(normalizedPrompt.slice(0, 64));
  return `https://dummyimage.com/512x512/000/fff.png&text=${encodedPrompt}`;
}

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
    ok: true,
    output: {
      prompt,
      url: buildPlaceholderUrl(prompt),
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
