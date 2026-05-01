function buildCase(index = 0) {
  const caseNo = index + 1;
  const caseId = `multi-agent-collab-${String(caseNo).padStart(3, "0")}`;
  const passed = caseNo <= 22;
  const missingArtifactFailSoft = caseNo === 24;

  return {
    id: caseId,
    trace_id: `trace-${caseId}`,
    task_id: `task-${caseId}`,
    node_id: `node-${caseId}`,
    category: "multi-agent-collab",
    important_task: true,
    passed,
    fake_completion: false,
    tool_permission_violation: false,
    blocked_misreported_completed: false,
    routing_planner_regression: false,
    usage_layer_pass: true,
    workflow_steps: 6,
    waited_for_subtasks: true,
    specialists: ["ceo", "product", "cmo"],
    merge_required: true,
    serial_estimated_ms: 18100 + (caseNo * 65),
    wall_time_ms: 10800 + (caseNo * 50),
    required_artifacts: [
      "ceo_brief",
      "product_brief",
      "cmo_brief",
      "merge_decision",
      "final_response",
    ],
    produced_artifacts: [
      "ceo_brief",
      "product_brief",
      "cmo_brief",
      "merge_decision",
      "final_response",
    ],
    optional_missing_artifacts: missingArtifactFailSoft
      ? ["artifact_from_finance_specialist"]
      : [],
    fail_soft_event: missingArtifactFailSoft,
    failure_class: passed
      ? null
      : (missingArtifactFailSoft ? "missing_artifact_fail_soft" : "verification_fail"),
  };
}

export const multiAgentCollabPack = Object.freeze({
  id: "multi-agent-collab",
  description: "至少 3 specialist + merge，含缺 artifact fail-soft 案",
  cases: Object.freeze(Array.from({ length: 25 }, (_, index) => buildCase(index))),
});
