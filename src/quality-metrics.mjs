import { cleanText } from "./message-intent-utils.mjs";

function toFiniteNumber(value = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function safeRatio(numerator = 0, denominator = 0, digits = 4) {
  const n = toFiniteNumber(numerator);
  const d = toFiniteNumber(denominator);
  if (n == null || d == null || d <= 0) {
    return null;
  }
  return Number((n / d).toFixed(digits));
}

function normalizeArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => cleanText(value))
    .filter(Boolean);
}

function normalizeCase(entry = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const requiredArtifacts = normalizeArray(entry.required_artifacts);
  const producedArtifacts = new Set(normalizeArray(entry.produced_artifacts));
  const requiredArtifactHitCount = requiredArtifacts.filter((artifact) => producedArtifacts.has(artifact)).length;

  return {
    id: cleanText(entry.id) || null,
    trace_id: cleanText(entry.trace_id) || null,
    task_id: cleanText(entry.task_id) || null,
    node_id: cleanText(entry.node_id) || null,
    category: cleanText(entry.category).toLowerCase(),
    important_task: entry.important_task !== false,
    passed: entry.passed === true,
    fake_completion: entry.fake_completion === true,
    tool_permission_violation: entry.tool_permission_violation === true,
    blocked_misreported_completed: entry.blocked_misreported_completed === true,
    routing_planner_regression: entry.routing_planner_regression === true,
    usage_layer_pass: entry.usage_layer_pass !== false,
    required_artifact_count: requiredArtifacts.length,
    required_artifact_hit_count: requiredArtifactHitCount,
    required_artifacts: requiredArtifacts,
    produced_artifacts: Array.from(producedArtifacts),
    serial_estimated_ms: toFiniteNumber(entry.serial_estimated_ms) || 0,
    wall_time_ms: toFiniteNumber(entry.wall_time_ms) || 0,
    failure_class: cleanText(entry.failure_class) || null,
  };
}

export function computeQualityMetrics(cases = []) {
  const normalizedCases = cases
    .map((entry) => normalizeCase(entry))
    .filter(Boolean);

  const totalTasks = normalizedCases.length;
  const passedTasks = normalizedCases.filter((item) => item.passed).length;
  const importantTasks = normalizedCases.filter((item) => item.important_task);
  const importantTaskTotal = importantTasks.length;
  const fakeCompletionCount = importantTasks.filter((item) => item.fake_completion).length;

  const artifactsRequiredTotal = normalizedCases.reduce((sum, item) => sum + item.required_artifact_count, 0);
  const artifactsPresentRequired = normalizedCases.reduce((sum, item) => sum + item.required_artifact_hit_count, 0);

  const serialEstimatedMs = normalizedCases.reduce((sum, item) => sum + Math.max(0, item.serial_estimated_ms), 0);
  const wallTimeMs = normalizedCases.reduce((sum, item) => sum + Math.max(0, item.wall_time_ms), 0);

  const pdfCases = normalizedCases.filter((item) => item.category.startsWith("pdf-"));
  const pdfTaskTotal = pdfCases.length;
  const pdfPassedTasks = pdfCases.filter((item) => item.passed).length;

  const toolPermissionViolationCount = normalizedCases.filter((item) => item.tool_permission_violation).length;
  const blockedMisreportedCompletedCount = normalizedCases.filter((item) => item.blocked_misreported_completed).length;
  const usageLayerFailureCount = normalizedCases.filter((item) => !item.usage_layer_pass).length;
  const routingPlannerRegressionCount = normalizedCases.filter((item) => item.routing_planner_regression).length;

  const failedCases = normalizedCases
    .filter((item) => {
      const coverageComplete = item.required_artifact_hit_count === item.required_artifact_count;
      return !item.passed
        || item.fake_completion
        || item.tool_permission_violation
        || item.blocked_misreported_completed
        || item.routing_planner_regression
        || !coverageComplete;
    })
    .map((item) => ({
      trace_id: item.trace_id,
      task_id: item.task_id,
      node_id: item.node_id,
      ...(item.failure_class ? { failure_class: item.failure_class } : {}),
    }));

  return {
    sample_size: {
      total_tasks: totalTasks,
      important_task_total: importantTaskTotal,
      pdf_task_total: pdfTaskTotal,
    },
    counts: {
      passed_tasks: passedTasks,
      fake_completion_count: fakeCompletionCount,
      artifacts_required_total: artifactsRequiredTotal,
      artifacts_present_required: artifactsPresentRequired,
      tool_permission_violation_count: toolPermissionViolationCount,
      blocked_misreported_completed_count: blockedMisreportedCompletedCount,
      usage_layer_failure_count: usageLayerFailureCount,
      routing_planner_regression_count: routingPlannerRegressionCount,
      serial_estimated_ms: serialEstimatedMs,
      wall_time_ms: wallTimeMs,
      pdf_passed_tasks: pdfPassedTasks,
      pdf_task_total: pdfTaskTotal,
    },
    metrics: {
      task_success_rate: safeRatio(passedTasks, totalTasks),
      fake_completion_rate: safeRatio(fakeCompletionCount, importantTaskTotal),
      evidence_coverage_rate: safeRatio(artifactsPresentRequired, artifactsRequiredTotal),
      agent_parallel_efficiency: safeRatio(serialEstimatedMs, wallTimeMs),
      pdf_task_success_rate: safeRatio(pdfPassedTasks, pdfTaskTotal),
    },
    flags: {
      usage_layer_pass: usageLayerFailureCount === 0,
      routing_planner_regression: routingPlannerRegressionCount > 0,
    },
    failed_cases: failedCases,
  };
}
