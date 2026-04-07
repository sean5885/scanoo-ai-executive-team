import { createManualUsageLayerEval } from "./usage-layer-evals.mjs";

export const workflowTimeoutGovernanceEvals = [
  createManualUsageLayerEval({
    id: "workflow-timeout-001",
    source_anchor: "timeout-governance:successful-but-slow",
    user_text: "把雲端文檔重新複審，這輪慢一點沒關係，但要給我結果",
    expected_lane: "cloud_doc_workflow",
    expected_planner_action: "rereview",
    expected_agent_or_tool: "workflow:cloud_doc_organization",
    expected_reply_mode: "workflow_update",
    expected_success_type: "workflow_progress",
    expected_eval_outcome: "good_answer",
    context: {
      timeout_governance: {
        family: "successful_but_slow",
        simulated_duration_ms: 4200,
        slow_warning_ms: 3500,
      },
    },
  }),
  createManualUsageLayerEval({
    id: "workflow-timeout-002",
    source_anchor: "timeout-governance:timeout-acceptable",
    user_text: "把非 scanoo 的文檔摘出去，先用保底結果也可以",
    expected_lane: "cloud_doc_workflow",
    expected_planner_action: "rereview",
    expected_agent_or_tool: "workflow:cloud_doc_organization",
    expected_reply_mode: "workflow_update",
    expected_success_type: "workflow_progress",
    expected_eval_outcome: "good_answer",
    context: {
      timeout_governance: {
        family: "timeout_acceptable",
        simulated_duration_ms: 15050,
        timeout_ms: 15000,
        slow_warning_ms: 3500,
      },
    },
  }),
  createManualUsageLayerEval({
    id: "workflow-timeout-003",
    source_anchor: "timeout-governance:timeout-fail-closed",
    user_text: "把這條文檔 workflow 跑到底，但如果超時就不要亂交付",
    expected_lane: "cloud_doc_workflow",
    expected_planner_action: "rereview",
    expected_agent_or_tool: "workflow:cloud_doc_organization",
    expected_reply_mode: "fail_soft",
    expected_success_type: "fail_soft",
    expected_eval_outcome: "fail_closed",
    context: {
      timeout_governance: {
        family: "timeout_fail_closed",
        simulated_duration_ms: 15020,
        timeout_ms: 15000,
      },
    },
  }),
  createManualUsageLayerEval({
    id: "workflow-timeout-004",
    source_anchor: "timeout-governance:workflow-too-slow",
    user_text: "這條 workflow 先別假裝完成，太慢就直接說卡在哪",
    expected_lane: "cloud_doc_workflow",
    expected_planner_action: "review",
    expected_agent_or_tool: "workflow:cloud_doc_organization",
    expected_reply_mode: "fail_soft",
    expected_success_type: "fail_soft",
    expected_eval_outcome: "fail_closed",
    context: {
      timeout_governance: {
        family: "workflow_too_slow",
        simulated_duration_ms: 8000,
        slow_warning_ms: 3500,
      },
    },
  }),
  createManualUsageLayerEval({
    id: "workflow-timeout-005",
    source_anchor: "timeout-governance:needs-fixture-mock",
    user_text: "幫我驗證沒有本地帳號上下文時的 timeout 邊界",
    expected_lane: "cloud_doc_workflow",
    expected_planner_action: "review",
    expected_agent_or_tool: "workflow:cloud_doc_organization",
    expected_reply_mode: "fail_soft",
    expected_success_type: "fail_soft",
    expected_eval_outcome: "fail_closed",
    context: {
      timeout_governance: {
        family: "needs_fixture_mock",
        simulated_duration_ms: 0,
      },
    },
  }),
];
