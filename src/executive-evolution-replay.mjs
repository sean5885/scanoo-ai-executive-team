import {
  buildExecutionEvidence,
  buildExecutionJournal,
  buildExecutionReflection,
  resolveVerificationOutcome,
} from "./executive-closed-loop.mjs";
import { summarizeExecutionReflection } from "./executive-evolution-metrics.mjs";
import { cleanText } from "./message-intent-utils.mjs";
import { verifyTaskCompletion } from "./executive-verifier.mjs";

const EXECUTION_REFLECTION_STATUS_ORDER = Object.freeze({
  failed: 0,
  partial_success: 1,
  success_with_deviation: 2,
  success: 3,
});

function buildSignedNumber(value = 0, precision = 4) {
  const normalized = Number(value || 0);
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(precision)}`;
}

function normalizePrecision(value = 0, precision = 4) {
  return Number(Number(value || 0).toFixed(precision));
}

function compareBooleanImprovement(current = false, previous = false) {
  if (current === previous) {
    return "same";
  }
  return current === true ? "improved" : "regressed";
}

function compareRankedImprovement(current = "", previous = "") {
  const currentRank = EXECUTION_REFLECTION_STATUS_ORDER[cleanText(current)] ?? -1;
  const previousRank = EXECUTION_REFLECTION_STATUS_ORDER[cleanText(previous)] ?? -1;
  if (currentRank === previousRank) {
    return "same";
  }
  return currentRank > previousRank ? "improved" : "regressed";
}

function buildDirectionalDelta(currentValue = 0, previousValue = 0, {
  precision = 4,
  betterDirection = "higher",
} = {}) {
  const current = normalizePrecision(currentValue, precision);
  const previous = normalizePrecision(previousValue, precision);
  const delta = normalizePrecision(current - previous, precision);
  if (delta === 0) {
    return {
      previous,
      current,
      delta,
      status: "same",
    };
  }
  if (betterDirection === "lower") {
    return {
      previous,
      current,
      delta,
      status: delta < 0 ? "improved" : "regressed",
    };
  }
  return {
    previous,
    current,
    delta,
    status: delta > 0 ? "improved" : "regressed",
  };
}

function buildChangedDelta(currentValue = 0, previousValue = 0, precision = 0) {
  const current = normalizePrecision(currentValue, precision);
  const previous = normalizePrecision(previousValue, precision);
  const delta = normalizePrecision(current - previous, precision);
  return {
    previous,
    current,
    delta,
    status: delta === 0 ? "same" : "changed",
  };
}

function normalizeIntents(items = []) {
  return Array.from(
    new Set(
      (Array.isArray(items) ? items : [])
        .map((item) => cleanText(item))
        .filter(Boolean),
    ),
  );
}

function summarizeStepReviews(stepReviews = []) {
  const reviews = Array.isArray(stepReviews) ? stepReviews : [];
  const intents = normalizeIntents(reviews.map((item) => item?.intent));
  const successfulSteps = reviews.filter((item) => item?.success === true).length;
  const deviatedSteps = reviews.filter((item) => cleanText(item?.deviation || "") && cleanText(item?.deviation || "") !== "none").length;
  return {
    total_steps: reviews.length,
    successful_steps: successfulSteps,
    failed_steps: Math.max(0, reviews.length - successfulSteps),
    deviated_steps: deviatedSteps,
    intents,
  };
}

function diffIntents(currentIntents = [], previousIntents = []) {
  const previousSet = new Set(normalizeIntents(previousIntents));
  const currentSet = new Set(normalizeIntents(currentIntents));
  return {
    added: [...currentSet].filter((item) => !previousSet.has(item)),
    removed: [...previousSet].filter((item) => !currentSet.has(item)),
  };
}

function buildTaskReplayRun({
  task = null,
  requestText = "",
  reply = null,
  supportingOutputs = [],
  routing = {},
  structuredResult = null,
  extraEvidence = [],
  expectedOutputSchema = null,
  expected_output_schema = null,
  plannerSteps = [],
} = {}) {
  const taskType = cleanText(task?.task_type || "") || "search";
  const toolRequired = (Array.isArray(task?.work_plan) ? task.work_plan : []).some((item) => item?.tool_required === true);
  const normalizedExpectedOutputSchema =
    expectedOutputSchema && typeof expectedOutputSchema === "object" && !Array.isArray(expectedOutputSchema)
      ? expectedOutputSchema
      : expected_output_schema && typeof expected_output_schema === "object" && !Array.isArray(expected_output_schema)
        ? expected_output_schema
        : null;
  const executionJournal = buildExecutionJournal({
    classifiedIntent: taskType,
    selectedAction: cleanText(routing?.action || ""),
    dispatchedActions: routing?.dispatched_actions || [],
    plannerSteps,
    reply,
    supportingOutputs,
    structuredResult,
    extraEvidence,
    fallbackUsed: routing?.fallback_used === true,
    toolRequired,
    syntheticAgentHint: routing?.synthetic_agent_hint || null,
    expectedOutputSchema: normalizedExpectedOutputSchema,
  });
  const evidence = buildExecutionEvidence({
    executionJournal,
  });
  const executionReflection = buildExecutionReflection({
    task,
    plannerSteps,
    executionJournal,
  });
  const verification = verifyTaskCompletion({
    taskType,
    executionJournal,
  });
  const outcome = resolveVerificationOutcome(verification);
  const executionReflectionSummary = summarizeExecutionReflection(executionReflection);
  const stepSummary = summarizeStepReviews(executionReflection?.step_reviews);

  return {
    request_text: cleanText(requestText),
    reply_text: cleanText(reply?.text || ""),
    success: verification.pass === true,
    outcome,
    verification,
    evidence,
    execution_journal: executionJournal,
    execution_reflection: executionReflection,
    execution_reflection_summary: executionReflectionSummary,
    step_summary: stepSummary,
  };
}

export function buildExecutiveReplayDelta({
  firstRun = null,
  secondRun = null,
} = {}) {
  const first = firstRun && typeof firstRun === "object" ? firstRun : {};
  const second = secondRun && typeof secondRun === "object" ? secondRun : {};
  const stepIntentDelta = diffIntents(
    second?.step_summary?.intents || [],
    first?.step_summary?.intents || [],
  );

  const successDelta = {
    previous: first.success === true,
    current: second.success === true,
    status: compareBooleanImprovement(second.success === true, first.success === true),
  };
  const stepDeltas = {
    total_steps: buildChangedDelta(second?.step_summary?.total_steps || 0, first?.step_summary?.total_steps || 0, 0),
    successful_steps: buildDirectionalDelta(second?.step_summary?.successful_steps || 0, first?.step_summary?.successful_steps || 0, {
      precision: 0,
      betterDirection: "higher",
    }),
    failed_steps: buildDirectionalDelta(second?.step_summary?.failed_steps || 0, first?.step_summary?.failed_steps || 0, {
      precision: 0,
      betterDirection: "lower",
    }),
    deviated_steps: buildDirectionalDelta(second?.step_summary?.deviated_steps || 0, first?.step_summary?.deviated_steps || 0, {
      precision: 0,
      betterDirection: "lower",
    }),
    intents: {
      previous: first?.step_summary?.intents || [],
      current: second?.step_summary?.intents || [],
      added: stepIntentDelta.added,
      removed: stepIntentDelta.removed,
      status: stepIntentDelta.added.length === 0 && stepIntentDelta.removed.length === 0
        ? "same"
        : "changed",
    },
  };
  const deviationDelta = {
    rate: buildDirectionalDelta(
      second?.execution_reflection_summary?.deviation_rate || 0,
      first?.execution_reflection_summary?.deviation_rate || 0,
      {
        precision: 4,
        betterDirection: "lower",
      },
    ),
    overall_status: {
      previous: cleanText(first?.execution_reflection_summary?.overall_status || ""),
      current: cleanText(second?.execution_reflection_summary?.overall_status || ""),
      status: compareRankedImprovement(
        second?.execution_reflection_summary?.overall_status || "",
        first?.execution_reflection_summary?.overall_status || "",
      ),
    },
  };

  const statuses = [
    successDelta.status,
    stepDeltas.successful_steps.status,
    stepDeltas.failed_steps.status,
    stepDeltas.deviated_steps.status,
    deviationDelta.rate.status,
    deviationDelta.overall_status.status,
  ];
  const overallStatus = statuses.includes("regressed")
    ? "regressed"
    : statuses.includes("improved")
      ? "improved"
      : "same";

  return {
    status: overallStatus,
    success: successDelta,
    steps: stepDeltas,
    deviation: deviationDelta,
  };
}

export function replayExecutiveTaskEvolution({
  task = null,
  requestText = "",
  firstRun = null,
  secondRun = null,
  first_run = null,
  second_run = null,
  logger = null,
} = {}) {
  const baselineSpec = firstRun && typeof firstRun === "object" ? firstRun : first_run;
  const improvedSpec = secondRun && typeof secondRun === "object" ? secondRun : second_run;
  const baselineRun = buildTaskReplayRun({
    task,
    requestText,
    ...(baselineSpec && typeof baselineSpec === "object" ? baselineSpec : {}),
  });
  const improvedRun = buildTaskReplayRun({
    task,
    requestText,
    ...(improvedSpec && typeof improvedSpec === "object" ? improvedSpec : {}),
  });
  const improvementDelta = buildExecutiveReplayDelta({
    firstRun: baselineRun,
    secondRun: improvedRun,
  });

  const result = {
    request_text: cleanText(requestText),
    task: {
      task_type: cleanText(task?.task_type || "") || "search",
      objective: cleanText(task?.objective || ""),
    },
    first_run: baselineRun,
    second_run: improvedRun,
    improvement_delta: improvementDelta,
  };

  logger?.info?.("executive_evolution_replay", {
    event_type: "executive_evolution_replay",
    task_type: result.task.task_type || null,
    objective: result.task.objective || null,
    improvement_delta: improvementDelta,
  });

  return result;
}

export function formatExecutiveReplayReport(report = {}) {
  const firstRun = report?.first_run || {};
  const secondRun = report?.second_run || {};
  const delta = report?.improvement_delta || {};

  return [
    "Executive Evolution Replay",
    `Task: ${cleanText(report?.task?.objective || report?.request_text || "") || "unknown"}`,
    `First run: success=${firstRun.success === true} | steps=${Number(firstRun?.step_summary?.successful_steps || 0)}/${Number(firstRun?.step_summary?.total_steps || 0)} | deviation_rate=${Number(firstRun?.execution_reflection_summary?.deviation_rate || 0)} | status=${cleanText(firstRun?.execution_reflection_summary?.overall_status || "") || "unknown"}`,
    `Second run: success=${secondRun.success === true} | steps=${Number(secondRun?.step_summary?.successful_steps || 0)}/${Number(secondRun?.step_summary?.total_steps || 0)} | deviation_rate=${Number(secondRun?.execution_reflection_summary?.deviation_rate || 0)} | status=${cleanText(secondRun?.execution_reflection_summary?.overall_status || "") || "unknown"}`,
    `Improvement delta: ${cleanText(delta?.status || "") || "same"}`,
    `- success: ${delta?.success?.previous === true} -> ${delta?.success?.current === true} | ${cleanText(delta?.success?.status || "") || "same"}`,
    `- successful_steps: ${Number(delta?.steps?.successful_steps?.previous || 0)} -> ${Number(delta?.steps?.successful_steps?.current || 0)} | delta ${buildSignedNumber(delta?.steps?.successful_steps?.delta || 0, 0)} | ${cleanText(delta?.steps?.successful_steps?.status || "") || "same"}`,
    `- failed_steps: ${Number(delta?.steps?.failed_steps?.previous || 0)} -> ${Number(delta?.steps?.failed_steps?.current || 0)} | delta ${buildSignedNumber(delta?.steps?.failed_steps?.delta || 0, 0)} | ${cleanText(delta?.steps?.failed_steps?.status || "") || "same"}`,
    `- deviated_steps: ${Number(delta?.steps?.deviated_steps?.previous || 0)} -> ${Number(delta?.steps?.deviated_steps?.current || 0)} | delta ${buildSignedNumber(delta?.steps?.deviated_steps?.delta || 0, 0)} | ${cleanText(delta?.steps?.deviated_steps?.status || "") || "same"}`,
    `- deviation_rate: ${Number(delta?.deviation?.rate?.previous || 0)} -> ${Number(delta?.deviation?.rate?.current || 0)} | delta ${buildSignedNumber(delta?.deviation?.rate?.delta || 0, 4)} | ${cleanText(delta?.deviation?.rate?.status || "") || "same"}`,
    `- step_intents: added=${(delta?.steps?.intents?.added || []).join(",") || "none"} | removed=${(delta?.steps?.intents?.removed || []).join(",") || "none"}`,
  ].join("\n");
}
