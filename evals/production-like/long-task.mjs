function buildCase(index = 0) {
  const caseNo = index + 1;
  const caseId = `long-task-${String(caseNo).padStart(3, "0")}`;
  const passed = caseNo <= 22;
  const fakeCompletion = caseNo === 25;
  return {
    id: caseId,
    trace_id: `trace-${caseId}`,
    task_id: `task-${caseId}`,
    node_id: `node-${caseId}`,
    category: "long-task",
    important_task: true,
    passed,
    fake_completion: fakeCompletion,
    tool_permission_violation: false,
    blocked_misreported_completed: false,
    routing_planner_regression: false,
    usage_layer_pass: true,
    workflow_steps: 5,
    waited_for_subtasks: true,
    specialists: ["planner_agent", "consult"],
    merge_required: true,
    serial_estimated_ms: 14900 + (caseNo * 60),
    wall_time_ms: 9200 + (caseNo * 45),
    required_artifacts: [
      "plan_outline",
      "subtask_results",
      "verification_record",
      "final_answer",
    ],
    produced_artifacts: [
      "plan_outline",
      "subtask_results",
      "verification_record",
      "final_answer",
    ],
    failure_class: passed ? null : (fakeCompletion ? "fake_completion" : "runtime_exception"),
  };
}

export const longTaskPack = Object.freeze({
  id: "long-task",
  description: ">3 steps 任務，需等待子任務（production-like）",
  cases: Object.freeze(Array.from({ length: 25 }, (_, index) => buildCase(index))),
});
