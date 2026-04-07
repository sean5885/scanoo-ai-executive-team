import { executiveReflectionStorePath } from "./config.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { readJsonFile } from "./token-store.mjs";

export const EXECUTIVE_EVOLUTION_WINDOW_SIZE = 50;

function normalizeRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Number(numeric.toFixed(4));
}

function normalizeBoolean(value) {
  return value === true;
}

export function summarizeExecutionReflection(executionReflection = null) {
  const stepReviews = Array.isArray(executionReflection?.step_reviews)
    ? executionReflection.step_reviews
    : [];
  const totalSteps = stepReviews.length;
  const deviatedSteps = stepReviews.filter((item) => cleanText(item?.deviation || "") && cleanText(item?.deviation || "") !== "none").length;

  return {
    overall_status: cleanText(executionReflection?.overall_status || ""),
    total_steps: totalSteps,
    deviated_steps: deviatedSteps,
    deviation_rate: totalSteps > 0 ? normalizeRate(deviatedSteps / totalSteps) : 0,
  };
}

export function buildCurrentEvolutionMetrics({
  executionReflection = null,
  improvementTriggered = false,
  retryAttempted = false,
  retrySucceeded = false,
} = {}) {
  const reflectionSummary = summarizeExecutionReflection(executionReflection);
  const attemptedRetry = normalizeBoolean(retryAttempted);
  const succeededRetry = attemptedRetry && normalizeBoolean(retrySucceeded);

  return {
    execution_reflection_summary: reflectionSummary,
    reflection_deviation_rate: reflectionSummary.deviation_rate,
    improvement_trigger_rate: improvementTriggered === true ? 1 : 0,
    retry_success_rate: attemptedRetry ? (succeededRetry ? 1 : 0) : null,
    improvement_triggered: improvementTriggered === true,
    retry_attempted: attemptedRetry,
    retry_succeeded: succeededRetry,
  };
}

function normalizeArchivedReflectionMetric(item = {}) {
  const summary = item?.execution_reflection_summary && typeof item.execution_reflection_summary === "object"
    ? item.execution_reflection_summary
    : {};
  return {
    execution_reflection_summary: {
      overall_status: cleanText(summary.overall_status || ""),
      total_steps: Number.isFinite(Number(summary.total_steps)) ? Number(summary.total_steps) : 0,
      deviated_steps: Number.isFinite(Number(summary.deviated_steps)) ? Number(summary.deviated_steps) : 0,
      deviation_rate: normalizeRate(summary.deviation_rate),
    },
    improvement_triggered: normalizeBoolean(item?.improvement_triggered),
    retry_attempted: normalizeBoolean(item?.retry_attempted),
    retry_succeeded: normalizeBoolean(item?.retry_succeeded),
  };
}

export function calculateEvolutionMetricsFromEntries(entries = [], { windowSize = EXECUTIVE_EVOLUTION_WINDOW_SIZE } = {}) {
  const recentEntries = (Array.isArray(entries) ? entries : [])
    .slice(-Math.max(1, windowSize))
    .map((item) => normalizeArchivedReflectionMetric(item));
  const totalReflections = recentEntries.length;
  const reflectionTotals = recentEntries.reduce((accumulator, item) => ({
    totalSteps: accumulator.totalSteps + item.execution_reflection_summary.total_steps,
    deviatedSteps: accumulator.deviatedSteps + item.execution_reflection_summary.deviated_steps,
    triggeredReflections: accumulator.triggeredReflections + (item.improvement_triggered ? 1 : 0),
    retryAttempts: accumulator.retryAttempts + (item.retry_attempted ? 1 : 0),
    retrySuccesses: accumulator.retrySuccesses + (item.retry_succeeded ? 1 : 0),
  }), {
    totalSteps: 0,
    deviatedSteps: 0,
    triggeredReflections: 0,
    retryAttempts: 0,
    retrySuccesses: 0,
  });

  return {
    window_size: totalReflections,
    reflection_deviation_rate:
      reflectionTotals.totalSteps > 0
        ? normalizeRate(reflectionTotals.deviatedSteps / reflectionTotals.totalSteps)
        : 0,
    reflection_deviation: {
      deviated_steps: reflectionTotals.deviatedSteps,
      total_steps: reflectionTotals.totalSteps,
    },
    improvement_trigger_rate:
      totalReflections > 0
        ? normalizeRate(reflectionTotals.triggeredReflections / totalReflections)
        : 0,
    improvement_trigger: {
      triggered_reflections: reflectionTotals.triggeredReflections,
      total_reflections: totalReflections,
    },
    retry_success_rate:
      reflectionTotals.retryAttempts > 0
        ? normalizeRate(reflectionTotals.retrySuccesses / reflectionTotals.retryAttempts)
        : null,
    retry_success: {
      successful_retries: reflectionTotals.retrySuccesses,
      retry_attempts: reflectionTotals.retryAttempts,
    },
  };
}

export async function calculateEvolutionMetrics({
  windowSize = EXECUTIVE_EVOLUTION_WINDOW_SIZE,
} = {}) {
  const store = await readJsonFile(executiveReflectionStorePath);
  const items = Array.isArray(store?.items) ? store.items : [];
  return calculateEvolutionMetricsFromEntries(items, { windowSize });
}
