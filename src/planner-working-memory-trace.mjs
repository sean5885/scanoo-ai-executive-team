import { cleanText } from "./message-intent-utils.mjs";

const ABANDONED_TASK_PREVIEW_LIMIT = 3;

function normalizeRetryCount(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0
    ? normalized
    : 0;
}

function normalizeRetryPolicy(policy = null) {
  const normalizedPolicy = policy && typeof policy === "object" && !Array.isArray(policy)
    ? policy
    : {};
  const maxRetries = Number(normalizedPolicy.max_retries);
  return {
    max_retries: Number.isFinite(maxRetries) && maxRetries > 0
      ? Math.max(1, Math.floor(maxRetries))
      : 2,
    strategy: cleanText(normalizedPolicy.strategy || "") || "same_agent_then_reroute",
  };
}

function normalizeSlotState(slotState = []) {
  if (!Array.isArray(slotState)) {
    return {
      missing: [],
      filled: [],
      invalid: [],
      map: {},
    };
  }
  const map = {};
  for (const slot of slotState) {
    const slotKey = cleanText(slot?.slot_key || "");
    const status = cleanText(slot?.status || "");
    if (!slotKey || !status) {
      continue;
    }
    map[slotKey] = status;
  }
  const entries = Object.entries(map).sort(([left], [right]) => left.localeCompare(right));
  const missing = entries.filter(([, status]) => status === "missing").map(([slotKey]) => slotKey);
  const filled = entries.filter(([, status]) => status === "filled").map(([slotKey]) => slotKey);
  const invalid = entries.filter(([, status]) => status === "invalid").map(([slotKey]) => slotKey);
  return {
    missing,
    filled,
    invalid,
    map,
  };
}

function normalizeAbandonedTaskIds(taskIds = []) {
  if (!Array.isArray(taskIds)) {
    return [];
  }
  return taskIds
    .map((taskId) => cleanText(taskId))
    .filter(Boolean);
}

function summarizeAbandonedTaskIds(taskIds = []) {
  const normalizedTaskIds = normalizeAbandonedTaskIds(taskIds);
  const preview = normalizedTaskIds.slice(-ABANDONED_TASK_PREVIEW_LIMIT);
  return {
    all: normalizedTaskIds,
    preview,
    hidden_count: Math.max(0, normalizedTaskIds.length - preview.length),
  };
}

function normalizeExecutionPlan(plan = null) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return {
      plan_id: null,
      plan_status: null,
      current_step: null,
      steps: [],
      map: {},
      artifacts: [],
      dependency_edges: [],
      primary_artifact: {
        artifact_id: null,
        artifact_type: null,
        validity_status: null,
        produced_by_step_id: null,
        affected_downstream_steps: null,
        dependency_type: null,
        artifact_superseded: false,
        dependency_blocked_step: null,
      },
    };
  }
  const planId = cleanText(plan.plan_id || "");
  const planStatus = cleanText(plan.plan_status || "");
  const currentStep = cleanText(plan.current_step_id || "");
  const normalizedSteps = Array.isArray(plan.steps)
    ? plan.steps
        .map((step) => {
          const stepId = cleanText(step?.step_id || "");
          const stepStatus = cleanText(step?.status || "");
          if (!stepId || !stepStatus) {
            return null;
          }
          return {
            step_id: stepId,
            status: stepStatus,
            failure_class: cleanText(step?.failure_class || "") || null,
            recovery_policy: cleanText(step?.recovery_policy || "") || null,
            recovery_state: step?.recovery_state && typeof step.recovery_state === "object" && !Array.isArray(step.recovery_state)
              ? {
                  last_failure_class: cleanText(step.recovery_state.last_failure_class || "") || null,
                  recovery_attempt_count: Number.isFinite(Number(step.recovery_state.recovery_attempt_count))
                    ? Number(step.recovery_state.recovery_attempt_count)
                    : 0,
                  last_recovery_action: cleanText(step.recovery_state.last_recovery_action || "") || null,
                  rollback_target_step_id: cleanText(step.recovery_state.rollback_target_step_id || "") || null,
                }
              : {
                  last_failure_class: null,
                  recovery_attempt_count: 0,
                  last_recovery_action: null,
                  rollback_target_step_id: null,
                },
          };
        })
        .filter(Boolean)
    : [];
  const normalizedArtifacts = Array.isArray(plan.artifacts)
    ? plan.artifacts
        .map((artifact) => {
          const artifactId = cleanText(artifact?.artifact_id || "");
          if (!artifactId) {
            return null;
          }
          return {
            artifact_id: artifactId,
            artifact_type: cleanText(artifact?.artifact_type || "") || null,
            produced_by_step_id: cleanText(artifact?.produced_by_step_id || "") || null,
            validity_status: cleanText(artifact?.validity_status || "") || null,
            supersedes_artifact_id: cleanText(artifact?.supersedes_artifact_id || "") || null,
          };
        })
        .filter(Boolean)
    : [];
  const normalizedDependencyEdges = Array.isArray(plan.dependency_edges)
    ? plan.dependency_edges
        .map((edge) => {
          const fromStepId = cleanText(edge?.from_step_id || "");
          const toStepId = cleanText(edge?.to_step_id || "");
          const viaArtifactId = cleanText(edge?.via_artifact_id || "");
          const dependencyType = cleanText(edge?.dependency_type || "");
          if (!fromStepId || !toStepId || !viaArtifactId || !dependencyType) {
            return null;
          }
          return {
            from_step_id: fromStepId,
            to_step_id: toStepId,
            via_artifact_id: viaArtifactId,
            dependency_type: dependencyType,
          };
        })
        .filter(Boolean)
    : [];
  const map = {};
  for (const step of normalizedSteps) {
    map[step.step_id] = step.status;
  }
  const artifactMap = {};
  for (const artifact of normalizedArtifacts) {
    artifactMap[artifact.artifact_id] = artifact.validity_status || "none";
  }
  const artifactPriority = normalizedArtifacts.find((artifact) => artifact.validity_status === "invalid")
    || normalizedArtifacts.find((artifact) => artifact.validity_status === "missing")
    || normalizedArtifacts.find((artifact) => artifact.validity_status === "superseded")
    || normalizedArtifacts.find((artifact) => artifact.produced_by_step_id === currentStep)
    || normalizedArtifacts[0]
    || null;
  const hardDownstream = artifactPriority
    ? normalizedDependencyEdges
      .filter((edge) => edge.via_artifact_id === artifactPriority.artifact_id && edge.dependency_type === "hard")
      .map((edge) => edge.to_step_id)
    : [];
  const softDownstream = artifactPriority
    ? normalizedDependencyEdges
      .filter((edge) => edge.via_artifact_id === artifactPriority.artifact_id && edge.dependency_type === "soft")
      .map((edge) => edge.to_step_id)
    : [];
  const dependencyType = hardDownstream.length > 0
    ? "hard"
    : softDownstream.length > 0
      ? "soft"
      : null;
  const affectedDownstreamSteps = dependencyType === "hard"
    ? hardDownstream
    : softDownstream;
  const dependencyBlockedStep = dependencyType === "hard"
    ? affectedDownstreamSteps.find((stepId) => {
        const stepStatus = cleanText(map[stepId] || "");
        return stepStatus === "blocked" || stepStatus === "failed" || stepStatus === "running";
      }) || affectedDownstreamSteps[0] || null
    : null;
  return {
    plan_id: planId || null,
    plan_status: planStatus || null,
    current_step: currentStep || null,
    steps: normalizedSteps,
    map,
    artifacts: normalizedArtifacts,
    dependency_edges: normalizedDependencyEdges,
    artifact_map: artifactMap,
    primary_artifact: {
      artifact_id: artifactPriority?.artifact_id || null,
      artifact_type: artifactPriority?.artifact_type || null,
      validity_status: artifactPriority?.validity_status || null,
      produced_by_step_id: artifactPriority?.produced_by_step_id || null,
      affected_downstream_steps: affectedDownstreamSteps.length > 0
        ? Array.from(new Set(affectedDownstreamSteps))
        : null,
      dependency_type: dependencyType,
      artifact_superseded: artifactPriority?.validity_status === "superseded"
        || Boolean(cleanText(artifactPriority?.supersedes_artifact_id || "")),
      dependency_blocked_step: dependencyBlockedStep,
    },
  };
}

function toSnapshot(memorySnapshot = null) {
  const snapshot = memorySnapshot && typeof memorySnapshot === "object" && !Array.isArray(memorySnapshot)
    ? memorySnapshot
    : {};
  const retryPolicy = normalizeRetryPolicy(snapshot.retry_policy);
  const slotState = normalizeSlotState(snapshot.slot_state);
  const abandonedTaskIds = summarizeAbandonedTaskIds(snapshot.abandoned_task_ids);
  const executionPlan = normalizeExecutionPlan(snapshot.execution_plan);
  const currentPlanStep = executionPlan.current_step
    ? executionPlan.steps.find((step) => step.step_id === executionPlan.current_step) || null
    : null;
  return {
    task_id: cleanText(snapshot.task_id || "") || null,
    task_type: cleanText(snapshot.task_type || snapshot.inferred_task_type || "") || null,
    task_phase: cleanText(snapshot.task_phase || "") || "init",
    task_status: cleanText(snapshot.task_status || "") || "running",
    current_owner_agent: cleanText(snapshot.current_owner_agent || snapshot.last_selected_agent || "") || null,
    previous_owner_agent: cleanText(snapshot.previous_owner_agent || "") || null,
    handoff_reason: cleanText(snapshot.handoff_reason || "") || null,
    retry_count: normalizeRetryCount(snapshot.retry_count),
    retry_policy: retryPolicy,
    next_best_action: cleanText(snapshot.next_best_action || "") || null,
    slot_state: {
      missing: slotState.missing,
      filled: slotState.filled,
      invalid: slotState.invalid,
    },
    abandoned_task_ids: abandonedTaskIds.preview,
    abandoned_task_total: abandonedTaskIds.all.length,
    abandoned_task_hidden_count: abandonedTaskIds.hidden_count,
    execution_plan: {
      plan_id: executionPlan.plan_id,
      plan_status: executionPlan.plan_status,
      current_step: executionPlan.current_step,
      current_step_failure_class: currentPlanStep?.failure_class || null,
      current_step_recovery_policy: currentPlanStep?.recovery_policy || null,
      current_step_recovery_action: currentPlanStep?.recovery_state?.last_recovery_action || null,
      current_step_recovery_attempt_count: Number.isFinite(Number(currentPlanStep?.recovery_state?.recovery_attempt_count))
        ? Number(currentPlanStep.recovery_state.recovery_attempt_count)
        : 0,
      current_step_rollback_target_step_id: currentPlanStep?.recovery_state?.rollback_target_step_id || null,
      artifact_id: executionPlan.primary_artifact.artifact_id || null,
      artifact_type: executionPlan.primary_artifact.artifact_type || null,
      validity_status: executionPlan.primary_artifact.validity_status || null,
      produced_by_step_id: executionPlan.primary_artifact.produced_by_step_id || null,
      affected_downstream_steps: executionPlan.primary_artifact.affected_downstream_steps || null,
      dependency_type: executionPlan.primary_artifact.dependency_type || null,
      artifact_superseded: executionPlan.primary_artifact.artifact_superseded === true,
      dependency_blocked_step: executionPlan.primary_artifact.dependency_blocked_step || null,
      artifact_count: Array.isArray(executionPlan.artifacts) ? executionPlan.artifacts.length : 0,
      dependency_edge_count: Array.isArray(executionPlan.dependency_edges) ? executionPlan.dependency_edges.length : 0,
      steps: executionPlan.steps,
    },
    _slot_map: slotState.map,
    _plan_step_map: executionPlan.map,
    _artifact_map: executionPlan.artifact_map || {},
  };
}

function formatValue(value = null) {
  if (value === null || value === undefined || value === "") {
    return "none";
  }
  if (Array.isArray(value)) {
    return value.length > 0
      ? `[${value.join(", ")}]`
      : "[]";
  }
  return String(value);
}

function parseTransition(transition = "") {
  const normalized = cleanText(transition);
  if (!normalized || !normalized.includes("->")) {
    return null;
  }
  const [fromRaw, toRaw] = normalized.split("->");
  const from = cleanText(fromRaw || "");
  const to = cleanText(toRaw || "");
  if (!from && !to) {
    return null;
  }
  return {
    from: from || "none",
    to: to || "none",
  };
}

function buildDiffLines({
  previousSnapshot = null,
  nextSnapshot = null,
  observability = null,
} = {}) {
  const previous = toSnapshot(previousSnapshot);
  const next = toSnapshot(nextSnapshot);
  const normalizedObservability = observability && typeof observability === "object" && !Array.isArray(observability)
    ? observability
    : {};
  const diffLines = [];
  const seen = new Set();
  const addDiffLine = (line = "") => {
    const normalized = cleanText(line);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    diffLines.push(normalized);
  };
  const addFieldDiff = (field, leftValue, rightValue) => {
    if (formatValue(leftValue) === formatValue(rightValue)) {
      return;
    }
    addDiffLine(`${field}: ${formatValue(leftValue)} -> ${formatValue(rightValue)}`);
  };
  const hasDiffPrefix = (prefix = "") => {
    const normalizedPrefix = cleanText(prefix);
    if (!normalizedPrefix) {
      return false;
    }
    return diffLines.some((line) => line.startsWith(normalizedPrefix));
  };

  addFieldDiff("task_id", previous.task_id, next.task_id);
  addFieldDiff("task_type", previous.task_type, next.task_type);
  addFieldDiff("task_phase", previous.task_phase, next.task_phase);
  addFieldDiff("task_status", previous.task_status, next.task_status);
  addFieldDiff("current_owner_agent", previous.current_owner_agent, next.current_owner_agent);
  addFieldDiff("previous_owner_agent", previous.previous_owner_agent, next.previous_owner_agent);
  addFieldDiff("handoff_reason", previous.handoff_reason, next.handoff_reason);
  addFieldDiff("retry_count", previous.retry_count, next.retry_count);
  addFieldDiff("retry_policy.max_retries", previous.retry_policy.max_retries, next.retry_policy.max_retries);
  addFieldDiff("retry_policy.strategy", previous.retry_policy.strategy, next.retry_policy.strategy);
  addFieldDiff("next_best_action", previous.next_best_action, next.next_best_action);
  addFieldDiff("abandoned_task_ids", previous.abandoned_task_ids, next.abandoned_task_ids);
  addFieldDiff("plan_id", previous.execution_plan.plan_id, next.execution_plan.plan_id);
  addFieldDiff("plan_status", previous.execution_plan.plan_status, next.execution_plan.plan_status);
  addFieldDiff("current_step", previous.execution_plan.current_step, next.execution_plan.current_step);
  addFieldDiff("current_step_failure_class", previous.execution_plan.current_step_failure_class, next.execution_plan.current_step_failure_class);
  addFieldDiff("current_step_recovery_policy", previous.execution_plan.current_step_recovery_policy, next.execution_plan.current_step_recovery_policy);
  addFieldDiff("current_step_recovery_action", previous.execution_plan.current_step_recovery_action, next.execution_plan.current_step_recovery_action);
  addFieldDiff("current_step_recovery_attempt_count", previous.execution_plan.current_step_recovery_attempt_count, next.execution_plan.current_step_recovery_attempt_count);
  addFieldDiff("current_step_rollback_target_step_id", previous.execution_plan.current_step_rollback_target_step_id, next.execution_plan.current_step_rollback_target_step_id);
  addFieldDiff("artifact_id", previous.execution_plan.artifact_id, next.execution_plan.artifact_id);
  addFieldDiff("artifact_type", previous.execution_plan.artifact_type, next.execution_plan.artifact_type);
  addFieldDiff("validity_status", previous.execution_plan.validity_status, next.execution_plan.validity_status);
  addFieldDiff("produced_by_step_id", previous.execution_plan.produced_by_step_id, next.execution_plan.produced_by_step_id);
  addFieldDiff("affected_downstream_steps", previous.execution_plan.affected_downstream_steps, next.execution_plan.affected_downstream_steps);
  addFieldDiff("dependency_type", previous.execution_plan.dependency_type, next.execution_plan.dependency_type);
  addFieldDiff("artifact_superseded", previous.execution_plan.artifact_superseded, next.execution_plan.artifact_superseded);
  addFieldDiff("dependency_blocked_step", previous.execution_plan.dependency_blocked_step, next.execution_plan.dependency_blocked_step);

  const slotKeys = Array.from(new Set([
    ...Object.keys(previous._slot_map || {}),
    ...Object.keys(next._slot_map || {}),
  ])).sort((left, right) => left.localeCompare(right));
  for (const slotKey of slotKeys) {
    addFieldDiff(`slot.${slotKey}`, previous._slot_map[slotKey] || "none", next._slot_map[slotKey] || "none");
  }
  const planStepKeys = Array.from(new Set([
    ...Object.keys(previous._plan_step_map || {}),
    ...Object.keys(next._plan_step_map || {}),
  ])).sort((left, right) => left.localeCompare(right));
  for (const stepId of planStepKeys) {
    addFieldDiff(`plan.step.${stepId}`, previous._plan_step_map[stepId] || "none", next._plan_step_map[stepId] || "none");
  }
  const artifactKeys = Array.from(new Set([
    ...Object.keys(previous._artifact_map || {}),
    ...Object.keys(next._artifact_map || {}),
  ])).sort((left, right) => left.localeCompare(right));
  for (const artifactId of artifactKeys) {
    addFieldDiff(`plan.artifact.${artifactId}`, previous._artifact_map[artifactId] || "none", next._artifact_map[artifactId] || "none");
  }

  const phaseTransition = parseTransition(normalizedObservability.task_phase_transition);
  if (phaseTransition) {
    addDiffLine(`task_phase: ${phaseTransition.from} -> ${phaseTransition.to}`);
  }
  const statusTransition = parseTransition(normalizedObservability.task_status_transition);
  if (statusTransition) {
    addDiffLine(`task_status: ${statusTransition.from} -> ${statusTransition.to}`);
  }

  const handoff = normalizedObservability.agent_handoff;
  if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
    addDiffLine(`current_owner_agent: ${formatValue(handoff.from)} -> ${formatValue(handoff.to)}`);
    const reason = cleanText(handoff.reason || "");
    if (reason && !hasDiffPrefix("handoff_reason:")) {
      addDiffLine(`handoff_reason: ${reason}`);
    }
  }

  const retryAttempt = normalizedObservability.retry_attempt;
  if (retryAttempt && typeof retryAttempt === "object" && !Array.isArray(retryAttempt)) {
    if (!hasDiffPrefix("retry_count:")
      && Number.isFinite(Number(retryAttempt.from))
      && Number.isFinite(Number(retryAttempt.to))) {
      addDiffLine(`retry_count: ${Number(retryAttempt.from)} -> ${Number(retryAttempt.to)}`);
    } else if (!hasDiffPrefix("retry_count:") && Number.isFinite(Number(retryAttempt.retry_count))) {
      addDiffLine(`retry_count: ${next.retry_count} -> ${Number(retryAttempt.retry_count)}`);
    }
  }

  const slotUpdate = normalizedObservability.slot_update;
  if (slotUpdate
    && typeof slotUpdate === "object"
    && !Array.isArray(slotUpdate)
    && Array.isArray(slotUpdate.pending_slots)
    && slotUpdate.pending_slots.length > 0
    && !hasDiffPrefix("slot_state.missing:")) {
    addDiffLine(`slot_state.missing: ${formatValue(slotUpdate.pending_slots)}`);
  }
  const taskAbandoned = normalizedObservability.task_abandoned;
  if (taskAbandoned && typeof taskAbandoned === "object" && !Array.isArray(taskAbandoned)) {
    const abandonedTaskId = cleanText(taskAbandoned.task_id || "");
    if (abandonedTaskId && !hasDiffPrefix("abandoned_task_ids:")) {
      addDiffLine(`abandoned_task_ids: +${abandonedTaskId}`);
    }
  }
  const stepTransition = normalizedObservability.step_transition;
  if (stepTransition && typeof stepTransition === "object" && !Array.isArray(stepTransition)) {
    const steps = Array.isArray(stepTransition.steps) ? stepTransition.steps : [];
    for (const step of steps) {
      const stepId = cleanText(step?.step_id || "");
      if (!stepId) {
        continue;
      }
      addDiffLine(`plan.step.${stepId}: ${formatValue(step?.from || null)} -> ${formatValue(step?.to || null)}`);
    }
    if (stepTransition.from_current_step_id || stepTransition.to_current_step_id) {
      addDiffLine(`current_step: ${formatValue(stepTransition.from_current_step_id || null)} -> ${formatValue(stepTransition.to_current_step_id || null)}`);
    }
  }
  const planInvalidated = normalizedObservability.plan_invalidated;
  if (planInvalidated && typeof planInvalidated === "object" && !Array.isArray(planInvalidated)) {
    const planId = cleanText(planInvalidated.plan_id || "");
    if (planId && !hasDiffPrefix("plan_invalidated:")) {
      addDiffLine(`plan_invalidated: ${planId} (${cleanText(planInvalidated.reason || "unknown") || "unknown"})`);
    }
  }
  const failureClass = cleanText(normalizedObservability.failure_class || "");
  if (failureClass && !hasDiffPrefix("failure_class:")) {
    addDiffLine(`failure_class: ${failureClass}`);
  }
  const recoveryPolicy = cleanText(normalizedObservability.recovery_policy || "");
  if (recoveryPolicy && !hasDiffPrefix("recovery_policy:")) {
    addDiffLine(`recovery_policy: ${recoveryPolicy}`);
  }
  const recoveryAction = cleanText(normalizedObservability.recovery_action || "");
  if (recoveryAction && !hasDiffPrefix("recovery_action:")) {
    addDiffLine(`recovery_action: ${recoveryAction}`);
  }
  if (Number.isFinite(Number(normalizedObservability.recovery_attempt_count))
    && !hasDiffPrefix("recovery_attempt_count:")) {
    addDiffLine(`recovery_attempt_count: ${Number(normalizedObservability.recovery_attempt_count)}`);
  }
  const rollbackTargetStepId = cleanText(normalizedObservability.rollback_target_step_id || "");
  if (rollbackTargetStepId && !hasDiffPrefix("rollback_target_step_id:")) {
    addDiffLine(`rollback_target_step_id: ${rollbackTargetStepId}`);
  }
  if (Array.isArray(normalizedObservability.skipped_step_ids)
    && normalizedObservability.skipped_step_ids.length > 0
    && !hasDiffPrefix("skipped_step_ids:")) {
    addDiffLine(`skipped_step_ids: ${formatValue(normalizedObservability.skipped_step_ids)}`);
  }
  const artifactId = cleanText(normalizedObservability.artifact_id || "");
  if (artifactId && !hasDiffPrefix("artifact_id:")) {
    addDiffLine(`artifact_id: ${artifactId}`);
  }
  const artifactType = cleanText(normalizedObservability.artifact_type || "");
  if (artifactType && !hasDiffPrefix("artifact_type:")) {
    addDiffLine(`artifact_type: ${artifactType}`);
  }
  const validityStatus = cleanText(normalizedObservability.validity_status || "");
  if (validityStatus && !hasDiffPrefix("validity_status:")) {
    addDiffLine(`validity_status: ${validityStatus}`);
  }
  const producedByStepId = cleanText(normalizedObservability.produced_by_step_id || "");
  if (producedByStepId && !hasDiffPrefix("produced_by_step_id:")) {
    addDiffLine(`produced_by_step_id: ${producedByStepId}`);
  }
  if (Array.isArray(normalizedObservability.affected_downstream_steps)
    && normalizedObservability.affected_downstream_steps.length > 0
    && !hasDiffPrefix("affected_downstream_steps:")) {
    addDiffLine(`affected_downstream_steps: ${formatValue(normalizedObservability.affected_downstream_steps)}`);
  }
  const dependencyType = cleanText(normalizedObservability.dependency_type || "");
  if (dependencyType && !hasDiffPrefix("dependency_type:")) {
    addDiffLine(`dependency_type: ${dependencyType}`);
  }
  if (normalizedObservability.artifact_superseded === true && !hasDiffPrefix("artifact_superseded:")) {
    addDiffLine("artifact_superseded: true");
  }
  const dependencyBlockedStep = cleanText(normalizedObservability.dependency_blocked_step || "");
  if (dependencyBlockedStep && !hasDiffPrefix("dependency_blocked_step:")) {
    addDiffLine(`dependency_blocked_step: ${dependencyBlockedStep}`);
  }
  if (normalizedObservability.resumed_from_waiting_user === true) {
    addDiffLine("resume: waiting_user");
  }
  if (normalizedObservability.resumed_from_retry === true) {
    addDiffLine("resume: retry");
  }

  return diffLines;
}

function buildTaskTraceText({
  memoryStage = "",
  snapshot = null,
  diffLines = [],
} = {}) {
  const next = toSnapshot(snapshot);
  const slots = next.slot_state;
  const abandonedSummary = next.abandoned_task_hidden_count > 0
    ? `${formatValue(next.abandoned_task_ids)} (+${next.abandoned_task_hidden_count} more)`
    : formatValue(next.abandoned_task_ids);
  const lines = [
    `[task-trace] ${cleanText(memoryStage || "") || "unknown_stage"}`,
    `now: task_id=${formatValue(next.task_id)} | task_type=${formatValue(next.task_type)} | phase=${formatValue(next.task_phase)} | status=${formatValue(next.task_status)}`,
    `owner: current=${formatValue(next.current_owner_agent)} | previous=${formatValue(next.previous_owner_agent)} | handoff=${formatValue(next.handoff_reason)}`,
    `retry: count=${next.retry_count} | policy=${next.retry_policy.strategy} (max=${next.retry_policy.max_retries})`,
    `next_best_action: ${formatValue(next.next_best_action)}`,
    `plan: id=${formatValue(next.execution_plan.plan_id)} | status=${formatValue(next.execution_plan.plan_status)} | current_step=${formatValue(next.execution_plan.current_step)}`,
    `recovery: class=${formatValue(next.execution_plan.current_step_failure_class)} | policy=${formatValue(next.execution_plan.current_step_recovery_policy)} | action=${formatValue(next.execution_plan.current_step_recovery_action)} | attempts=${formatValue(next.execution_plan.current_step_recovery_attempt_count)} | rollback_target=${formatValue(next.execution_plan.current_step_rollback_target_step_id)}`,
    `artifact: id=${formatValue(next.execution_plan.artifact_id)} | type=${formatValue(next.execution_plan.artifact_type)} | validity=${formatValue(next.execution_plan.validity_status)} | produced_by=${formatValue(next.execution_plan.produced_by_step_id)} | downstream=${formatValue(next.execution_plan.affected_downstream_steps)} | dependency=${formatValue(next.execution_plan.dependency_type)} | blocked_step=${formatValue(next.execution_plan.dependency_blocked_step)} | superseded=${formatValue(next.execution_plan.artifact_superseded)}`,
    `slot_state: missing=${formatValue(slots.missing)} | filled=${formatValue(slots.filled)} | invalid=${formatValue(slots.invalid)}`,
    `abandoned_task_ids: ${abandonedSummary}`,
  ];
  if (Array.isArray(diffLines) && diffLines.length > 0) {
    lines.push("diff:");
    for (const line of diffLines) {
      lines.push(`- ${line}`);
    }
  } else {
    lines.push("diff: no_change");
  }
  return lines.join("\n");
}

export function buildPlannerTaskTraceDiagnostics({
  memoryStage = "",
  memorySnapshot = null,
  previousMemorySnapshot = null,
  observability = null,
} = {}) {
  const snapshot = toSnapshot(memorySnapshot);
  const diff = buildDiffLines({
    previousSnapshot: previousMemorySnapshot,
    nextSnapshot: memorySnapshot,
    observability,
  });
  const summary = `task=${formatValue(snapshot.task_id)} phase=${snapshot.task_phase} status=${snapshot.task_status} owner=${formatValue(snapshot.current_owner_agent)} plan=${formatValue(snapshot.execution_plan.plan_status)}:${formatValue(snapshot.execution_plan.current_step)} recovery=${formatValue(snapshot.execution_plan.current_step_recovery_action)} artifact=${formatValue(snapshot.execution_plan.artifact_id)}:${formatValue(snapshot.execution_plan.validity_status)} next=${formatValue(snapshot.next_best_action)}`;
  return {
    summary,
    snapshot: {
      task_id: snapshot.task_id,
      task_type: snapshot.task_type,
      task_phase: snapshot.task_phase,
      task_status: snapshot.task_status,
      current_owner_agent: snapshot.current_owner_agent,
      previous_owner_agent: snapshot.previous_owner_agent,
      handoff_reason: snapshot.handoff_reason,
      retry_count: snapshot.retry_count,
      retry_policy: snapshot.retry_policy,
      next_best_action: snapshot.next_best_action,
      execution_plan: snapshot.execution_plan,
      slot_state: snapshot.slot_state,
      abandoned_task_ids: snapshot.abandoned_task_ids,
      abandoned_task_total: snapshot.abandoned_task_total,
    },
    diff,
    text: buildTaskTraceText({
      memoryStage,
      snapshot: memorySnapshot,
      diffLines: diff,
    }),
    event_alignment: {
      memory_snapshot: Boolean(memorySnapshot && typeof memorySnapshot === "object" && !Array.isArray(memorySnapshot)),
      task_phase_transition: Boolean(cleanText(observability?.task_phase_transition || "")),
      agent_handoff: Boolean(observability?.agent_handoff && typeof observability.agent_handoff === "object"),
      retry_attempt: Boolean(observability?.retry_attempt && typeof observability.retry_attempt === "object"),
      step_transition: Boolean(observability?.step_transition && typeof observability.step_transition === "object"),
      plan_invalidated: Boolean(observability?.plan_invalidated && typeof observability.plan_invalidated === "object"),
      failure_class: Boolean(cleanText(observability?.failure_class || "")),
      recovery_policy: Boolean(cleanText(observability?.recovery_policy || "")),
      recovery_action: Boolean(cleanText(observability?.recovery_action || "")),
      rollback_target_step_id: Boolean(cleanText(observability?.rollback_target_step_id || "")),
      skipped_step_ids: Array.isArray(observability?.skipped_step_ids) && observability.skipped_step_ids.length > 0,
      artifact_id: Boolean(cleanText(observability?.artifact_id || "")),
      artifact_type: Boolean(cleanText(observability?.artifact_type || "")),
      validity_status: Boolean(cleanText(observability?.validity_status || "")),
      produced_by_step_id: Boolean(cleanText(observability?.produced_by_step_id || "")),
      affected_downstream_steps: Array.isArray(observability?.affected_downstream_steps)
        && observability.affected_downstream_steps.length > 0,
      dependency_type: Boolean(cleanText(observability?.dependency_type || "")),
      artifact_superseded: observability?.artifact_superseded === true,
      dependency_blocked_step: Boolean(cleanText(observability?.dependency_blocked_step || "")),
      resumed_from_waiting_user: observability?.resumed_from_waiting_user === true,
      resumed_from_retry: observability?.resumed_from_retry === true,
    },
  };
}
