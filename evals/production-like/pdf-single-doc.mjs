function buildCase(index = 0) {
  const caseNo = index + 1;
  const caseId = `pdf-single-doc-${String(caseNo).padStart(3, "0")}`;
  const passed = caseNo <= 23;
  return {
    id: caseId,
    trace_id: `trace-${caseId}`,
    task_id: `task-${caseId}`,
    node_id: `node-${caseId}`,
    category: "pdf-single-doc",
    important_task: true,
    passed,
    fake_completion: false,
    tool_permission_violation: false,
    blocked_misreported_completed: false,
    routing_planner_regression: false,
    usage_layer_pass: true,
    workflow_steps: 3,
    waited_for_subtasks: false,
    specialists: ["generalist"],
    merge_required: false,
    serial_estimated_ms: 7600 + (caseNo * 40),
    wall_time_ms: 6100 + (caseNo * 30),
    required_artifacts: [
      "source_pdf_snippets",
      "answer_brief",
    ],
    produced_artifacts: [
      "source_pdf_snippets",
      "answer_brief",
    ],
  };
}

export const pdfSingleDocPack = Object.freeze({
  id: "pdf-single-doc",
  description: "PDF 單文件問答（production-like）",
  cases: Object.freeze(Array.from({ length: 25 }, (_, index) => buildCase(index))),
});
