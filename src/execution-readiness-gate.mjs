import { cleanText } from "./message-intent-utils.mjs";

export const EXECUTION_READINESS_RECOMMENDED_ACTIONS = Object.freeze([
  "proceed",
  "ask_user",
  "retry",
  "reroute",
  "rollback",
  "skip",
  "fail",
]);

export const EXECUTION_READINESS_BLOCKING_REASON_CODES = Object.freeze([
  "missing_slot",
  "invalid_artifact",
  "blocked_dependency",
  "owner_mismatch",
  "recovery_in_progress",
  "plan_invalidated",
  "malformed_plan_state",
]);

const READINESS_ACTION_PRIORITY = Object.freeze({
  proceed: 0,
  skip: 1,
  retry: 2,
  reroute: 3,
  ask_user: 4,
  rollback: 5,
  fail: 6,
});

function toObject(value = null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function toArray(value = null) {
  return Array.isArray(value)
    ? value
    : [];
}

function uniqueStrings(items = []) {
  return Array.from(new Set(toArray(items).map((item) => cleanText(item)).filter(Boolean)));
}

function normalizeStepStatus(status = "") {
  const normalizedStatus = cleanText(status || "");
  return normalizedStatus || "missing";
}

function isRecoveryInProgress({
  step = null,
  recoveryAction = "",
} = {}) {
  const stepStatus = normalizeStepStatus(step?.status || "");
  if (!recoveryAction) {
    return false;
  }
  if (recoveryAction === "rollback_to_step") {
    return stepStatus === "failed" || stepStatus === "running" || stepStatus === "blocked";
  }
  if (recoveryAction === "retry_same_step") {
    return stepStatus === "failed" || stepStatus === "blocked";
  }
  return false;
}

function normalizeFilledSlotMap(slotState = []) {
  const now = Date.now();
  const slotMap = new Map();
  for (const slot of toArray(slotState)) {
    const slotObject = toObject(slot);
    if (!slotObject) {
      continue;
    }
    const slotKey = cleanText(slotObject.slot_key || "");
    const slotStatus = cleanText(slotObject.status || "");
    if (!slotKey || !slotStatus) {
      continue;
    }
    const ttl = cleanText(slotObject.ttl || "");
    if (ttl) {
      const expiresAt = Date.parse(ttl);
      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        continue;
      }
    }
    slotMap.set(slotKey, slotStatus);
  }
  return slotMap;
}

function buildExecutionReadinessResult() {
  return {
    is_ready: true,
    blocking_reason_codes: [],
    missing_slots: [],
    invalid_artifacts: [],
    blocked_dependencies: [],
    owner_ready: true,
    recovery_ready: true,
    recommended_action: "proceed",
    rollback_target_step_id: null,
  };
}

function pickRecommendedAction(currentAction = "proceed", candidateAction = "proceed") {
  const normalizedCurrent = cleanText(currentAction || "") || "proceed";
  const normalizedCandidate = cleanText(candidateAction || "") || "proceed";
  const currentPriority = READINESS_ACTION_PRIORITY[normalizedCurrent] ?? 0;
  const candidatePriority = READINESS_ACTION_PRIORITY[normalizedCandidate] ?? 0;
  return candidatePriority >= currentPriority
    ? normalizedCandidate
    : normalizedCurrent;
}

function addBlockingReason(result = null, reasonCode = "", recommendedAction = "proceed") {
  const normalizedReason = cleanText(reasonCode || "");
  if (!result || !normalizedReason) {
    return;
  }
  if (!result.blocking_reason_codes.includes(normalizedReason)) {
    result.blocking_reason_codes.push(normalizedReason);
  }
  result.recommended_action = pickRecommendedAction(result.recommended_action, recommendedAction);
}

function toMalformedResult(result = null) {
  const mutableResult = result || buildExecutionReadinessResult();
  addBlockingReason(mutableResult, "malformed_plan_state", "fail");
  mutableResult.is_ready = false;
  return mutableResult;
}

export function evaluateExecutionReadiness({
  plan = null,
  step = null,
  current_owner_agent = "",
  task_id = "",
  abandoned_task_ids = [],
  unresolved_slots = [],
  slot_state = [],
} = {}) {
  const readiness = buildExecutionReadinessResult();
  const normalizedPlan = toObject(plan);
  if (!normalizedPlan) {
    return toMalformedResult(readiness);
  }
  const planStatus = cleanText(normalizedPlan.plan_status || "");
  const normalizedTaskId = cleanText(task_id || "");
  const abandonedTaskSet = new Set(uniqueStrings(abandoned_task_ids));
  if (planStatus === "invalidated" || (normalizedTaskId && abandonedTaskSet.has(normalizedTaskId))) {
    addBlockingReason(readiness, "plan_invalidated", "fail");
    readiness.is_ready = false;
    return readiness;
  }
  const normalizedStep = toObject(step);
  if (!normalizedStep) {
    return toMalformedResult(readiness);
  }
  const planSteps = toArray(normalizedPlan.steps).map((item) => toObject(item)).filter(Boolean);
  const planStepMap = new Map(planSteps
    .map((item) => [cleanText(item.step_id || ""), item])
    .filter(([stepId]) => Boolean(stepId)));
  const currentStepId = cleanText(normalizedStep.step_id || "");
  if (!currentStepId || !planStepMap.has(currentStepId)) {
    return toMalformedResult(readiness);
  }
  const planArtifacts = toArray(normalizedPlan.artifacts).map((item) => toObject(item)).filter(Boolean);
  const dependencyEdges = toArray(normalizedPlan.dependency_edges).map((item) => toObject(item)).filter(Boolean);
  const artifactMap = new Map(planArtifacts
    .map((item) => [cleanText(item.artifact_id || ""), item])
    .filter(([artifactId]) => Boolean(artifactId)));
  const unresolvedSlotSet = new Set(uniqueStrings(unresolved_slots));
  const filledSlotMap = normalizeFilledSlotMap(slot_state);
  const slotRequirements = uniqueStrings(normalizedStep.slot_requirements);
  const missingSlots = slotRequirements.filter((slotKey) => (
    unresolvedSlotSet.has(slotKey)
    || cleanText(filledSlotMap.get(slotKey) || "") !== "filled"
  ));
  if (missingSlots.length > 0) {
    readiness.missing_slots = missingSlots;
    addBlockingReason(readiness, "missing_slot", "ask_user");
  }

  const incomingHardEdges = dependencyEdges.filter((edge) => (
    cleanText(edge.to_step_id || "") === currentStepId
    && cleanText(edge.dependency_type || "") === "hard"
  ));
  const invalidArtifacts = [];
  for (const edge of incomingHardEdges) {
    const viaArtifactId = cleanText(edge.via_artifact_id || "");
    const artifact = artifactMap.get(viaArtifactId) || null;
    const validityStatus = cleanText(artifact?.validity_status || "") || "missing";
    if (validityStatus === "valid") {
      continue;
    }
    const producedByStepId = cleanText(artifact?.produced_by_step_id || "");
    const affectedDownstreamSteps = dependencyEdges
      .filter((candidate) =>
        cleanText(candidate.via_artifact_id || "") === viaArtifactId
        && cleanText(candidate.dependency_type || "") === "hard")
      .map((candidate) => cleanText(candidate.to_step_id || ""))
      .filter(Boolean);
    invalidArtifacts.push({
      artifact_id: viaArtifactId || null,
      artifact_type: cleanText(artifact?.artifact_type || "") || null,
      validity_status: validityStatus,
      produced_by_step_id: producedByStepId || null,
      dependency_type: "hard",
      blocked_step_id: cleanText(edge.to_step_id || "") || currentStepId,
      affected_downstream_steps: affectedDownstreamSteps.length > 0
        ? Array.from(new Set(affectedDownstreamSteps))
        : null,
      rollback_target_step_id: producedByStepId && planStepMap.has(producedByStepId)
        ? producedByStepId
        : null,
    });
  }
  if (invalidArtifacts.length > 0) {
    readiness.invalid_artifacts = invalidArtifacts;
    const rollbackTarget = invalidArtifacts.find((item) => cleanText(item.rollback_target_step_id || ""));
    if (rollbackTarget?.rollback_target_step_id) {
      readiness.rollback_target_step_id = rollbackTarget.rollback_target_step_id;
      addBlockingReason(readiness, "invalid_artifact", "rollback");
    } else {
      addBlockingReason(readiness, "invalid_artifact", "ask_user");
    }
  }

  const dependsOn = uniqueStrings(normalizedStep.depends_on);
  const blockedDependencies = [];
  for (const dependencyStepId of dependsOn) {
    const dependencyStep = planStepMap.get(dependencyStepId) || null;
    const dependencyStepStatus = normalizeStepStatus(dependencyStep?.status || "");
    if (dependencyStepStatus !== "completed") {
      blockedDependencies.push({
        step_id: dependencyStepId,
        status: dependencyStepStatus,
      });
    }
  }
  if (blockedDependencies.length > 0) {
    readiness.blocked_dependencies = blockedDependencies;
    addBlockingReason(readiness, "blocked_dependency", "fail");
  }

  const expectedOwnerAgent = cleanText(normalizedStep.owner_agent || "");
  const currentOwnerAgent = cleanText(current_owner_agent || "");
  if (expectedOwnerAgent && currentOwnerAgent && expectedOwnerAgent !== currentOwnerAgent) {
    readiness.owner_ready = false;
    addBlockingReason(readiness, "owner_mismatch", "reroute");
  }

  const recoveryState = toObject(normalizedStep.recovery_state);
  const recoveryAction = cleanText(
    recoveryState?.last_recovery_action
    || normalizedStep.recovery_policy
    || "",
  );
  if (isRecoveryInProgress({
    step: normalizedStep,
    recoveryAction,
  })) {
    readiness.recovery_ready = false;
    if (recoveryAction === "rollback_to_step") {
      const rollbackTargetStepId = cleanText(
        recoveryState?.rollback_target_step_id
        || readiness.rollback_target_step_id
        || "",
      );
      readiness.rollback_target_step_id = rollbackTargetStepId || readiness.rollback_target_step_id;
      addBlockingReason(readiness, "recovery_in_progress", "rollback");
    } else {
      addBlockingReason(readiness, "recovery_in_progress", "retry");
    }
  }

  if (!EXECUTION_READINESS_RECOMMENDED_ACTIONS.includes(readiness.recommended_action)) {
    readiness.recommended_action = "fail";
  }
  readiness.is_ready = readiness.blocking_reason_codes.length === 0;
  return readiness;
}
