import { classifyTask } from "./task-classifier.mjs";
import { TASK_SKILL_MAP } from "./task-skill-map.mjs";
import { aggregateResults } from "./task-aggregator.mjs";
import { sortTasks } from "./task-dependency.mjs";
import { cleanText } from "../message-intent-utils.mjs";
import { getSkillRegistryEntry } from "../skill-registry.mjs";

function pickFirstText(value, keys = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  for (const key of keys) {
    const candidate = cleanText(value?.[key]);
    if (candidate) {
      return candidate;
    }
  }
  return "";
}

function extractImageAsset(result = null) {
  if (typeof result === "string") {
    return cleanText(result);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return "";
  }
  const direct = pickFirstText(result, ["url", "image", "path", "file", "asset"]);
  if (direct) {
    return direct;
  }
  const nestedOutput = result.output && typeof result.output === "object" && !Array.isArray(result.output)
    ? pickFirstText(result.output, ["url", "image", "path", "file", "asset"])
    : "";
  if (nestedOutput) {
    return nestedOutput;
  }
  const nestedData = result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? pickFirstText(result.data, ["url", "image", "path", "file", "asset"])
    : "";
  return nestedData;
}

function isPlaceholderImageAsset(asset = "") {
  const normalized = cleanText(asset).toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("dummyimage.com")
    || normalized.includes("via.placeholder.com")
    || normalized.includes("placehold.co")
    || normalized.includes("placeholder")
  );
}

function resolveTaskError(result = {}, fallback = "runtime_exception") {
  return cleanText(
    result?.error
    || result?.details?.reason
    || result?.details?.message
    || result?.message
    || "",
  ) || fallback;
}

function buildTaskFailure(task = "", result = {}, fallbackError = "runtime_exception") {
  const status = cleanText(result?.status || "").toLowerCase();
  const blockedReason = cleanText(result?.details?.reason || result?.details?.stop_reason || "").toLowerCase();
  const blocked = result?.blocked === true || status === "blocked" || blockedReason === "image_backend_unavailable";
  const failureClass = cleanText(result?.failure_class || result?.details?.failure_class || "");
  return {
    task,
    ok: false,
    status: blocked ? "blocked" : "failed",
    blocked,
    failure_class: failureClass || null,
    error: resolveTaskError(result, fallbackError),
  };
}

function normalizeTaskResult(task = "", result = null, { skill = "" } = {}) {
  if (result == null || result === false) {
    return buildTaskFailure(task, {
      error: "runtime_exception",
    });
  }

  if (task === "image" && isPlaceholderImageAsset(extractImageAsset(result))) {
    return {
      task,
      ok: false,
      status: "blocked",
      blocked: true,
      failure_class: "capability_gap",
      error: "placeholder_output_blocked",
    };
  }

  if (result?.ok === false || result?.success === false) {
    return buildTaskFailure(task, result);
  }

  const status = cleanText(result?.status || "").toLowerCase();
  if (status === "failed" || status === "error" || status === "blocked") {
    return buildTaskFailure(task, result);
  }

  return {
    task,
    ok: true,
    skill: cleanText(skill) || null,
    result,
  };
}

export async function runTaskLayer(input, runSkill) {
  const tasks = sortTasks(classifyTask(input));
  const results = [];

  for (const task of tasks) {
    const skill = TASK_SKILL_MAP[task];
    if (!skill) {
      results.push({
        task,
        ok: false,
        error: "no_skill_mapped",
      });
      continue;
    }
    if (!getSkillRegistryEntry(skill)) {
      results.push({
        task,
        ok: false,
        error: "skill_not_registered",
        failure_class: "contract_violation",
      });
      continue;
    }

    try {
      const result = await runSkill(skill, { input, task });
      results.push(normalizeTaskResult(task, result, { skill }));
    } catch (error) {
      results.push({
        task,
        ok: false,
        status: "failed",
        blocked: false,
        failure_class: null,
        error: error?.message || String(error),
      });
      // Fail soft: keep advancing remaining tasks even if one task fails.
      continue;
    }
  }

  return aggregateResults({ tasks, results });
}
