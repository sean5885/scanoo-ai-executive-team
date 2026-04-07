import {
  createManualUsageLayerEval,
  createUsageLayerEvalFromRouting,
} from "./usage-layer-evals.mjs";

function buildMockPlannerEnvelope({
  action = "",
  formattedOutput = {},
} = {}) {
  return Object.freeze({
    ok: true,
    action,
    execution_result: Object.freeze({
      ok: true,
      action,
      formatted_output: Object.freeze({
        ...formattedOutput,
      }),
    }),
  });
}

function buildDetailFormattedOutput({
  title = "",
  docId = "",
  matchReason = "",
  contentSummary = "",
  reason = "",
} = {}) {
  return Object.freeze({
    kind: "detail",
    title,
    doc_id: docId,
    items: [
      Object.freeze({
        title,
        doc_id: docId,
        reason,
      }),
    ],
    match_reason: matchReason,
    content_summary: contentSummary,
    found: true,
  });
}

function buildRuntimeFormattedOutput({
  dbPath = "",
  cwd = "",
  pid = 0,
} = {}) {
  return Object.freeze({
    kind: "get_runtime_info",
    db_path: dbPath,
    cwd,
    node_pid: pid,
  });
}

const followupMultiIntentContinuityEvals = [
  createManualUsageLayerEval({
    id: "continuity-001",
    source_anchor: "followup:active-doc-that-one",
    user_text: "那個呢",
    expected_lane: "knowledge_assistant",
    expected_planner_action: "get_company_brain_doc_detail",
    expected_agent_or_tool: "tool:get_company_brain_doc_detail",
    should_fail_if_generic: true,
    context: {
      planner: {
        active_doc: {
          doc_id: "mock-onboarding-sop",
          title: "Onboarding SOP",
        },
      },
      mock_planner_envelope: buildMockPlannerEnvelope({
        action: "get_company_brain_doc_detail",
        formattedOutput: buildDetailFormattedOutput({
          title: "Onboarding SOP",
          docId: "mock-onboarding-sop",
          matchReason: "Onboarding SOP",
          contentSummary: "這份文件整理 onboarding 流程、角色責任和交接節點。",
          reason: "文件內容直接命中 onboarding 流程。",
        }),
      }),
    },
  }),
  createManualUsageLayerEval({
    id: "continuity-002",
    source_anchor: "followup:active-doc-risk",
    user_text: "那個風險在哪",
    expected_lane: "knowledge_assistant",
    expected_planner_action: "get_company_brain_doc_detail",
    expected_agent_or_tool: "tool:get_company_brain_doc_detail",
    should_fail_if_generic: true,
    context: {
      planner: {
        active_doc: {
          doc_id: "mock-rollout-plan",
          title: "Rollout Plan",
        },
      },
      mock_planner_envelope: buildMockPlannerEnvelope({
        action: "get_company_brain_doc_detail",
        formattedOutput: buildDetailFormattedOutput({
          title: "Rollout Plan",
          docId: "mock-rollout-plan",
          matchReason: "Rollout Plan 風險",
          contentSummary: "文件裡的主要風險是跨團隊依賴還沒鎖定 owner，且驗收時程容易被外部整合延後。",
          reason: "文件內容直接命中 rollout risk。",
        }),
      }),
    },
  }),
  createManualUsageLayerEval({
    id: "continuity-003",
    source_anchor: "followup:active-candidate-second",
    user_text: "那第二份呢",
    expected_lane: "knowledge_assistant",
    expected_planner_action: "get_company_brain_doc_detail",
    expected_agent_or_tool: "tool:get_company_brain_doc_detail",
    should_fail_if_generic: true,
    context: {
      planner: {
        active_candidates: [
          {
            doc_id: "mock-onboarding-sop",
            title: "Onboarding SOP",
          },
          {
            doc_id: "mock-delivery-guide",
            title: "Delivery Guide",
          },
          {
            doc_id: "mock-runtime-notes",
            title: "Runtime Notes",
          },
        ],
      },
      mock_planner_envelope: buildMockPlannerEnvelope({
        action: "get_company_brain_doc_detail",
        formattedOutput: buildDetailFormattedOutput({
          title: "Delivery Guide",
          docId: "mock-delivery-guide",
          matchReason: "Delivery Guide",
          contentSummary: "第二份文件主要說明交付節奏、驗收條件和 owner 分工。",
          reason: "標題直接命中 Delivery Guide。",
        }),
      }),
    },
  }),
  createManualUsageLayerEval({
    id: "continuity-004",
    source_anchor: "followup:active-candidate-second-summary",
    user_text: "第2份的重點呢",
    expected_lane: "knowledge_assistant",
    expected_planner_action: "get_company_brain_doc_detail",
    expected_agent_or_tool: "tool:get_company_brain_doc_detail",
    should_fail_if_generic: true,
    context: {
      planner: {
        active_candidates: [
          {
            doc_id: "mock-onboarding-sop",
            title: "Onboarding SOP",
          },
          {
            doc_id: "mock-delivery-guide",
            title: "Delivery Guide",
          },
        ],
      },
      mock_planner_envelope: buildMockPlannerEnvelope({
        action: "get_company_brain_doc_detail",
        formattedOutput: buildDetailFormattedOutput({
          title: "Delivery Guide",
          docId: "mock-delivery-guide",
          matchReason: "Delivery Guide 重點",
          contentSummary: "重點在交付前置檢查、里程碑驗收，以及每個節點的責任 owner。",
          reason: "文件內容直接命中 delivery guide。",
        }),
      }),
    },
  }),
  createManualUsageLayerEval({
    id: "continuity-005",
    source_anchor: "followup:cloud-doc-review",
    user_text: "好的，現在請告訴我還有什麼內容是需要我二次做確認的",
    expected_lane: "cloud_doc_workflow",
    expected_planner_action: "review",
    expected_agent_or_tool: "workflow:cloud_doc_organization",
    should_fail_if_generic: true,
    context: {
      active_workflow_mode: "cloud_doc_organization",
      mock_planner_envelope: {
        ok: true,
        action: "review",
        execution_result: {
          ok: true,
          data: {
            answer: "結論\n目前還有 2 份文件需要二次確認，我先把待確認項目列出來。\n\n待處理清單\n1. Administrator Manual｜狀態：待人工確認\n2. Workspace Guide｜狀態：待人工確認",
            sources: ["這輪保留在雲文檔 review follow-up。"],
            limitations: ["如果你要，我可以接著說明每一份為什麼還不能直接分配。"],
          },
        },
      },
    },
  }),
  createManualUsageLayerEval({
    id: "continuity-006",
    source_anchor: "followup:cloud-doc-why",
    user_text: "這些待人工確認的文件，到底為什麼不能直接分配？",
    expected_lane: "cloud_doc_workflow",
    expected_planner_action: "why",
    expected_agent_or_tool: "workflow:cloud_doc_organization",
    should_fail_if_generic: true,
    context: {
      active_workflow_mode: "cloud_doc_organization",
      mock_planner_envelope: {
        ok: true,
        action: "why",
        execution_result: {
          ok: true,
          data: {
            answer: "結論\n這批待人工確認文件不能直接分配，因為目前證據只足夠判斷主題接近，還不足以唯一鎖定 owner。\n\n重點\n- Administrator Manual：同時碰到 admin 與 onboarding 邊界\n- Workspace Guide：更像通用 workspace 指南，不只屬於單一角色",
            sources: ["這輪延續雲文檔 why follow-up。"],
            limitations: ["如果你要，我可以再把可直接分配與待人工確認分開整理。"],
          },
        },
      },
    },
  }),
  createUsageLayerEvalFromRouting({
    id: "continuity-007",
    source_anchor: "routing-eval:meeting-010",
    should_fail_if_generic: true,
  }),
  createManualUsageLayerEval({
    id: "multi-intent-008",
    source_anchor: "normalizer:mixed-copy-image-send",
    user_text: "幫我寫新品上線的 FB 貼文、做一張圖片並發送出去",
    expected_lane: "personal_assistant",
    expected_planner_action: "general_assistant_action",
    expected_agent_or_tool: "reply:default",
    tool_required: false,
    expected_reply_mode: "partial_success",
  }),
  createManualUsageLayerEval({
    id: "multi-intent-009",
    source_anchor: "normalizer:mixed-reply-send",
    user_text: "幫我寫一段回覆草稿並直接寄給群組",
    expected_lane: "personal_assistant",
    expected_planner_action: "general_assistant_action",
    expected_agent_or_tool: "reply:default",
    tool_required: false,
    expected_reply_mode: "partial_success",
  }),
  createManualUsageLayerEval({
    id: "multi-intent-010",
    source_anchor: "partial:lookup-send",
    user_text: "幫我整理 OKR 文件重點再寄給團隊",
    expected_lane: "knowledge_assistant",
    expected_planner_action: "search_and_detail_doc",
    expected_agent_or_tool: "tool:search_and_detail_doc",
    expected_reply_mode: "partial_success",
    expected_success_type: "partial_success",
    expected_eval_outcome: "partial_success",
    should_fail_if_generic: true,
    context: {
      mock_planner_envelope: buildMockPlannerEnvelope({
        action: "search_and_detail_doc",
        formattedOutput: {
          kind: "search_and_detail",
          title: "OKR Weekly Review",
          doc_id: "mock-okr-weekly",
          items: [
            {
              title: "OKR Weekly Review",
              doc_id: "mock-okr-weekly",
              reason: "文件內容直接命中 OKR。",
            },
          ],
          match_reason: "OKR",
          content_summary: "這份文件整理了本週 OKR 進度、阻塞點與下週重點。",
          found: true,
        },
      }),
    },
  }),
  createManualUsageLayerEval({
    id: "multi-intent-011",
    source_anchor: "partial:runtime-send",
    user_text: "先查 runtime db path 再發給團隊",
    expected_lane: "knowledge_assistant",
    expected_planner_action: "get_runtime_info",
    expected_agent_or_tool: "tool:get_runtime_info",
    expected_reply_mode: "partial_success",
    expected_success_type: "partial_success",
    expected_eval_outcome: "partial_success",
    should_fail_if_generic: true,
    context: {
      mock_planner_envelope: buildMockPlannerEnvelope({
        action: "get_runtime_info",
        formattedOutput: buildRuntimeFormattedOutput({
          dbPath: "/tmp/lobster/runtime.db",
          cwd: "/Users/seanhan/Documents/Playground",
          pid: 4242,
        }),
      }),
    },
  }),
  createManualUsageLayerEval({
    id: "multi-intent-012",
    source_anchor: "partial:delivery-publish",
    user_text: "幫我查 onboarding 文件重點再發佈到群組",
    expected_lane: "knowledge_assistant",
    expected_planner_action: "search_company_brain_docs",
    expected_agent_or_tool: "tool:search_company_brain_docs",
    expected_reply_mode: "partial_success",
    expected_success_type: "partial_success",
    expected_eval_outcome: "partial_success",
    should_fail_if_generic: true,
    context: {
      mock_planner_envelope: buildMockPlannerEnvelope({
        action: "search_and_detail_doc",
        formattedOutput: {
          kind: "search_and_detail",
          title: "Onboarding SOP",
          doc_id: "mock-onboarding-sop",
          items: [
            {
              title: "Onboarding SOP",
              doc_id: "mock-onboarding-sop",
              reason: "文件內容直接命中 onboarding。",
            },
          ],
          match_reason: "onboarding",
          content_summary: "這份文件整理 onboarding 流程、owner 分工與交接節點。",
          found: true,
        },
      }),
    },
  }),
  createUsageLayerEvalFromRouting({
    id: "fail-closed-013",
    source_anchor: "routing-eval:runtime-010",
    should_fail_if_generic: false,
  }),
  createManualUsageLayerEval({
    id: "clarify-014",
    source_anchor: "followup:deictic-without-context",
    user_text: "這個呢",
    expected_lane: "personal_assistant",
    expected_planner_action: "general_assistant_action",
    expected_agent_or_tool: "reply:default",
    tool_required: false,
    expected_reply_mode: "fail_soft",
    expected_success_type: "fail_soft",
    expected_eval_outcome: "fail_closed",
    should_fail_if_generic: false,
  }),
  createManualUsageLayerEval({
    id: "clarify-015",
    source_anchor: "followup:ordinal-without-context",
    user_text: "第二份呢",
    expected_lane: "personal_assistant",
    expected_planner_action: "general_assistant_action",
    expected_agent_or_tool: "reply:default",
    tool_required: false,
    expected_reply_mode: "fail_soft",
    expected_success_type: "fail_soft",
    expected_eval_outcome: "fail_closed",
    should_fail_if_generic: false,
  }),
  createManualUsageLayerEval({
    id: "followup-016",
    source_anchor: "followup:active-doc-summary-then-limit",
    user_text: "那份的下一步呢",
    expected_lane: "knowledge_assistant",
    expected_planner_action: "get_company_brain_doc_detail",
    expected_agent_or_tool: "tool:get_company_brain_doc_detail",
    should_fail_if_generic: true,
    context: {
      planner: {
        active_doc: {
          doc_id: "mock-rollout-plan",
          title: "Rollout Plan",
        },
      },
      mock_planner_envelope: buildMockPlannerEnvelope({
        action: "get_company_brain_doc_detail",
        formattedOutput: buildDetailFormattedOutput({
          title: "Rollout Plan",
          docId: "mock-rollout-plan",
          matchReason: "Rollout Plan 下一步",
          contentSummary: "下一步是先補齊 owner 與驗收節點，再安排跨團隊依賴確認，不然 rollout 風險會持續存在。",
          reason: "文件內容直接命中 rollout next step。",
        }),
      }),
    },
  }),
];

export { followupMultiIntentContinuityEvals };
