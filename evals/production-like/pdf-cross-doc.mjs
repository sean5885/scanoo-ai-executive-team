function buildCase(index = 0) {
  const caseNo = index + 1;
  const caseId = `pdf-cross-doc-${String(caseNo).padStart(3, "0")}`;
  const passed = caseNo <= 22;
  return {
    id: caseId,
    trace_id: `trace-${caseId}`,
    task_id: `task-${caseId}`,
    node_id: `node-${caseId}`,
    category: "pdf-cross-doc",
    important_task: true,
    passed,
    fake_completion: false,
    tool_permission_violation: false,
    blocked_misreported_completed: false,
    routing_planner_regression: false,
    usage_layer_pass: true,
    workflow_steps: 4,
    waited_for_subtasks: true,
    specialists: ["generalist", "doc_compare"],
    merge_required: true,
    serial_estimated_ms: 11200 + (caseNo * 45),
    wall_time_ms: 7600 + (caseNo * 35),
    required_artifacts: [
      "source_pdf_a",
      "source_pdf_b",
      "docx_reference",
      "cross_doc_diff",
      "merged_answer",
    ],
    produced_artifacts: [
      "source_pdf_a",
      "source_pdf_b",
      "docx_reference",
      "cross_doc_diff",
      "merged_answer",
    ],
  };
}

export const pdfCrossDocPack = Object.freeze({
  id: "pdf-cross-doc",
  description: "跨 PDF + docx 對照（production-like）",
  cases: Object.freeze(Array.from({ length: 25 }, (_, index) => buildCase(index))),
});
