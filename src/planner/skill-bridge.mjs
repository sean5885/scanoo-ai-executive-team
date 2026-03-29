import { cleanText } from "../message-intent-utils.mjs";
import { defaultSkillRegistry } from "../skill-registry.mjs";
import { runSkill } from "../skill-runtime.mjs";

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

  return {
    ok: true,
    action: `skill:${skill}`,
    data: {
      skill,
      query: cleanText(skillExecution?.output?.query) || null,
      summary: cleanText(skillExecution?.output?.summary) || null,
      hits: Number.isFinite(skillExecution?.output?.hits) ? Number(skillExecution.output.hits) : 0,
      found: skillExecution?.output?.found === true,
      sources: normalizePlannerSkillSources(skillExecution?.output?.sources),
      limitations: normalizeStringList(skillExecution?.output?.limitations),
      side_effects: normalizePlannerSkillSideEffects(skillExecution?.side_effects),
    },
    trace_id: cleanText(skillExecution?.trace_id) || null,
  };
}

const plannerSkillActionRegistry = new Map([
  ["search_and_summarize", Object.freeze({
    action: "search_and_summarize",
    skill_name: "search_and_summarize",
    max_skills_per_run: 1,
    allow_skill_chain: false,
    allowed_side_effects: Object.freeze({
      read: Object.freeze(["search_knowledge_base"]),
      write: Object.freeze([]),
    }),
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
  })],
]);

export function listPlannerSkillActions() {
  return Array.from(plannerSkillActionRegistry.values()).map((entry) => ({
    action: entry.action,
    skill_name: entry.skill_name,
    max_skills_per_run: entry.max_skills_per_run,
    allow_skill_chain: entry.allow_skill_chain,
    allowed_side_effects: entry.allowed_side_effects,
  }));
}

export function getPlannerSkillAction(action = "") {
  return plannerSkillActionRegistry.get(cleanText(action));
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
