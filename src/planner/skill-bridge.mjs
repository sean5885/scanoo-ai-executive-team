import { cleanText } from "../message-intent-utils.mjs";

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
