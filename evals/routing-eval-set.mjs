function createCase(category, id, text, expected, options = {}) {
  return Object.freeze({
    id: `${category}-${id}`,
    category,
    text,
    expected: Object.freeze({
      lane: expected.lane,
      planner_action: expected.planner_action,
      agent_or_tool: expected.agent_or_tool,
    }),
    ...(options.name ? { name: options.name } : {}),
    ...(options.scope ? { scope: Object.freeze({ ...options.scope }) } : {}),
    ...(options.context ? { context: Object.freeze(options.context) } : {}),
    ...(options.message ? { message: Object.freeze({ ...options.message }) } : {}),
  });
}

const docCases = [
  createCase("doc", "001", "幫我整理 OKR 文件重點", {
    lane: "knowledge_assistant",
    planner_action: "search_and_detail_doc",
    agent_or_tool: "tool:search_and_detail_doc",
  }),
  createCase("doc", "002", "幫我查詢 OKR 文件", {
    lane: "knowledge_assistant",
    planner_action: "search_company_brain_docs",
    agent_or_tool: "tool:search_company_brain_docs",
  }),
  createCase("doc", "003", "請搜尋 onboarding 文件流程並解釋", {
    lane: "knowledge_assistant",
    planner_action: "search_and_detail_doc",
    agent_or_tool: "tool:search_and_detail_doc",
  }),
  createCase("doc", "004", "幫我搜尋 onboarding SOP 文件", {
    lane: "knowledge_assistant",
    planner_action: "search_company_brain_docs",
    agent_or_tool: "tool:search_company_brain_docs",
  }),
  createCase("doc", "005", "幫我整理 BD 客戶跟進文件", {
    lane: "knowledge_assistant",
    planner_action: "search_and_detail_doc",
    agent_or_tool: "tool:search_and_detail_doc",
  }),
  createCase("doc", "006", "幫我搜尋提案文件", {
    lane: "knowledge_assistant",
    planner_action: "search_company_brain_docs",
    agent_or_tool: "tool:search_company_brain_docs",
  }),
  createCase("doc", "007", "幫我看這份文件的評論並改稿", {
    lane: "doc_editor",
    planner_action: "comment_rewrite_preview",
    agent_or_tool: "tool:lark_doc_rewrite_from_comments",
  }),
  createCase("doc", "008", "請讀這份文件內容 doccnread001", {
    lane: "doc_editor",
    planner_action: "document_read",
    agent_or_tool: "tool:lark_doc_read",
  }),
  createCase("doc", "009", "幫我修改這份文檔", {
    lane: "doc_editor",
    planner_action: "comment_rewrite_preview",
    agent_or_tool: "tool:lark_doc_rewrite_from_comments",
  }),
  createCase("doc", "010", "請整理文件摘要", {
    lane: "knowledge_assistant",
    planner_action: "search_and_detail_doc",
    agent_or_tool: "tool:search_and_detail_doc",
  }),
  createCase("doc", "011", "search company brain 列出文件", {
    lane: "knowledge_assistant",
    planner_action: "list_company_brain_docs",
    agent_or_tool: "tool:list_company_brain_docs",
  }),
  createCase("doc", "012", "search company brain 建立文件", {
    lane: "knowledge_assistant",
    planner_action: "create_doc",
    agent_or_tool: "tool:create_doc",
  }),
  createCase("doc", "013", "search learn this doc", {
    lane: "knowledge_assistant",
    planner_action: "ingest_learning_doc",
    agent_or_tool: "tool:ingest_learning_doc",
  }),
  createCase("doc", "014", "search update learning state", {
    lane: "knowledge_assistant",
    planner_action: "update_learning_state",
    agent_or_tool: "tool:update_learning_state",
  }),
  createCase("doc", "015", "知識 create doc then list docs", {
    lane: "knowledge_assistant",
    planner_action: "create_and_list_doc",
    agent_or_tool: "preset:create_and_list_doc",
  }),
  createCase("doc", "016", "company brain create then search doc", {
    lane: "knowledge_assistant",
    planner_action: "create_search_detail_list_doc",
    agent_or_tool: "preset:create_search_detail_list_doc",
  }),
  createCase("doc", "017", "根據文件打開這份文件內容", {
    lane: "knowledge_assistant",
    planner_action: "get_company_brain_doc_detail",
    agent_or_tool: "tool:get_company_brain_doc_detail",
  }, {
    context: {
      planner: {
        active_doc: {
          doc_id: "doc-active-1",
          title: "Active Doc",
        },
      },
    },
  }),
  createCase("doc", "018", "根據文件打開第2份", {
    lane: "knowledge_assistant",
    planner_action: "get_company_brain_doc_detail",
    agent_or_tool: "tool:get_company_brain_doc_detail",
  }, {
    context: {
      planner: {
        active_candidates: [
          { doc_id: "doc-candidate-1", title: "Candidate 1" },
          { doc_id: "doc-candidate-2", title: "Candidate 2" },
        ],
      },
    },
  }),
  createCase("doc", "019", "把我的雲文檔做分類 指派給對應的角色", {
    lane: "cloud_doc_workflow",
    planner_action: "preview",
    agent_or_tool: "workflow:cloud_doc_organization",
  }),
  createCase("doc", "020", "好的，現在請告訴我還有什麼內容是需要我二次做確認的", {
    lane: "cloud_doc_workflow",
    planner_action: "review",
    agent_or_tool: "workflow:cloud_doc_organization",
  }, {
    context: {
      active_workflow_mode: "cloud_doc_organization",
    },
  }),
  createCase("doc", "021", "這些待人工確認的文件，到底為什麼不能直接分配？", {
    lane: "cloud_doc_workflow",
    planner_action: "why",
    agent_or_tool: "workflow:cloud_doc_organization",
  }, {
    context: {
      active_workflow_mode: "cloud_doc_organization",
    },
  }),
  createCase("doc", "022", "去學習吧 各個角色分別看完之後要告訴我哪些文檔跟你無關 我們再重新分配", {
    lane: "cloud_doc_workflow",
    planner_action: "rereview",
    agent_or_tool: "workflow:cloud_doc_organization",
  }, {
    context: {
      active_workflow_mode: "cloud_doc_organization",
    },
  }),
  createCase("doc", "023", "退出分類模式", {
    lane: "cloud_doc_workflow",
    planner_action: "exit",
    agent_or_tool: "workflow:cloud_doc_organization",
  }, {
    context: {
      active_workflow_mode: "cloud_doc_organization",
    },
  }),
  createCase("doc", "024", "根據文件這份文件寫了什麼", {
    lane: "knowledge_assistant",
    planner_action: "get_company_brain_doc_detail",
    agent_or_tool: "tool:get_company_brain_doc_detail",
  }, {
    context: {
      planner: {
        active_theme: "okr",
        active_doc: {
          doc_id: "doc-okr-1",
          title: "OKR Weekly",
        },
      },
    },
  }),
  createCase("doc", "025", "根據文件讀這份文件", {
    lane: "knowledge_assistant",
    planner_action: "get_company_brain_doc_detail",
    agent_or_tool: "tool:get_company_brain_doc_detail",
  }, {
    context: {
      planner: {
        active_theme: "delivery",
        active_doc: {
          doc_id: "doc-delivery-1",
          title: "Delivery SOP",
        },
      },
    },
  }),
];

const meetingCases = [
  createCase("meeting", "001", "我要開會了", {
    lane: "meeting_workflow",
    planner_action: "start_capture",
    agent_or_tool: "workflow:meeting_agent",
  }),
  createCase("meeting", "002", "開始旁聽這場會議", {
    lane: "meeting_workflow",
    planner_action: "start_capture_calendar",
    agent_or_tool: "workflow:meeting_agent",
  }),
  createCase("meeting", "003", "會議", {
    lane: "meeting_workflow",
    planner_action: "start_capture",
    agent_or_tool: "workflow:meeting_agent",
  }),
  createCase("meeting", "004", "/meeting start", {
    lane: "meeting_workflow",
    planner_action: "start_capture",
    agent_or_tool: "workflow:meeting_agent",
  }),
  createCase("meeting", "005", "/meeting current", {
    lane: "meeting_workflow",
    planner_action: "start_capture_calendar",
    agent_or_tool: "workflow:meeting_agent",
  }),
  createCase("meeting", "006", "會議結束了", {
    lane: "meeting_workflow",
    planner_action: "stop_capture",
    agent_or_tool: "workflow:meeting_agent",
  }),
  createCase("meeting", "007", "/meeting stop", {
    lane: "meeting_workflow",
    planner_action: "stop_capture",
    agent_or_tool: "workflow:meeting_agent",
  }),
  createCase("meeting", "008", "/meeting confirm confirm-123", {
    lane: "meeting_workflow",
    planner_action: "confirm",
    agent_or_tool: "workflow:meeting_agent",
  }),
  createCase("meeting", "009", "/meeting 客戶會議 參與人員：Sean、Amy TODO：Sean 整理 PRD", {
    lane: "meeting_workflow",
    planner_action: "process",
    agent_or_tool: "workflow:meeting_agent",
  }),
  createCase("meeting", "010", "請問在持續記錄中嗎", {
    lane: "meeting_workflow",
    planner_action: "capture_status",
    agent_or_tool: "workflow:meeting_agent",
  }, {
    context: {
      meeting_capture_active: true,
    },
  }),
  createCase("meeting", "011", "還在錄嗎", {
    lane: "meeting_workflow",
    planner_action: "capture_status",
    agent_or_tool: "workflow:meeting_agent",
  }, {
    context: {
      meeting_capture_active: true,
    },
  }),
  createCase("meeting", "012", "線下會議請記錄一下", {
    lane: "meeting_workflow",
    planner_action: "start_capture",
    agent_or_tool: "workflow:meeting_agent",
  }),
  createCase("meeting", "013", "我們一起參會，請同步記錄", {
    lane: "meeting_workflow",
    planner_action: "start_capture",
    agent_or_tool: "workflow:meeting_agent",
  }),
  createCase("meeting", "014", "停止會議記錄", {
    lane: "meeting_workflow",
    planner_action: "stop_capture",
    agent_or_tool: "workflow:meeting_agent",
  }),
  createCase("meeting", "015", "/meeting end", {
    lane: "meeting_workflow",
    planner_action: "stop_capture",
    agent_or_tool: "workflow:meeting_agent",
  }),
];

const runtimeCases = [
  createCase("runtime", "001", "查詢 runtime 運行資訊", {
    lane: "knowledge_assistant",
    planner_action: "get_runtime_info",
    agent_or_tool: "tool:get_runtime_info",
  }),
  createCase("runtime", "002", "查一下 runtime db path", {
    lane: "knowledge_assistant",
    planner_action: "get_runtime_info",
    agent_or_tool: "tool:get_runtime_info",
  }),
  createCase("runtime", "003", "search runtime cwd", {
    lane: "knowledge_assistant",
    planner_action: "get_runtime_info",
    agent_or_tool: "tool:get_runtime_info",
  }),
  createCase("runtime", "004", "查詢 service start runtime", {
    lane: "knowledge_assistant",
    planner_action: "get_runtime_info",
    agent_or_tool: "tool:get_runtime_info",
  }),
  createCase("runtime", "005", "幫我看今天日程", {
    lane: "personal_assistant",
    planner_action: "calendar_summary",
    agent_or_tool: "tool:lark_calendar_primary",
  }),
  createCase("runtime", "006", "幫我看目前任務", {
    lane: "personal_assistant",
    planner_action: "tasks_summary",
    agent_or_tool: "tool:lark_tasks_list",
  }),
  createCase("runtime", "007", "幫我總結最近對話", {
    lane: "personal_assistant",
    planner_action: "summarize_recent_dialogue",
    agent_or_tool: "tool:lark_messages_list",
  }),
  createCase("runtime", "008", "幫我總結最近對話", {
    lane: "group_shared_assistant",
    planner_action: "summarize_recent_dialogue",
    agent_or_tool: "tool:lark_messages_list",
  }, {
    scope: {
      chat_type: "group",
    },
  }),
  createCase("runtime", "009", "幫我回覆這段群聊", {
    lane: "group_shared_assistant",
    planner_action: "draft_group_reply",
    agent_or_tool: "tool:lark_message_reply_card",
  }, {
    scope: {
      chat_type: "group",
    },
  }),
  createCase("runtime", "010", "晚點提醒我一下", {
    lane: "personal_assistant",
    planner_action: "default_reply",
    agent_or_tool: "reply:default",
  }),
];

const mixedCases = [
  createCase("mixed", "001", "/cmo 幫我整理定位", {
    lane: "registered_agent",
    planner_action: "dispatch_registered_agent",
    agent_or_tool: "agent:cmo",
  }),
  createCase("mixed", "002", "/knowledge conflicts 找出 Scanoo 文件衝突", {
    lane: "registered_agent",
    planner_action: "dispatch_registered_agent",
    agent_or_tool: "agent:knowledge-conflicts",
  }),
  createCase("mixed", "003", "/knowledge audit 盤點 OKR 文件缺口", {
    lane: "registered_agent",
    planner_action: "dispatch_registered_agent",
    agent_or_tool: "agent:knowledge-audit",
  }),
  createCase("mixed", "004", "/knowledge distill 幫我濃縮這批文件", {
    lane: "registered_agent",
    planner_action: "dispatch_registered_agent",
    agent_or_tool: "agent:knowledge-distill",
  }),
  createCase("mixed", "005", "/tech 幫我看架構風險", {
    lane: "registered_agent",
    planner_action: "dispatch_registered_agent",
    agent_or_tool: "agent:tech",
  }),
  createCase("mixed", "006", "先請各個 agent 一起看這批文檔，最後再統一收斂建議", {
    lane: "executive",
    planner_action: "start",
    agent_or_tool: "agent:generalist",
  }),
  createCase("mixed", "007", "把這輪改交給 /cmo", {
    lane: "executive",
    planner_action: "start",
    agent_or_tool: "agent:cmo",
  }),
  createCase("mixed", "008", "這個需要高層決策，請一起協作", {
    lane: "executive",
    planner_action: "start",
    agent_or_tool: "agent:ceo",
  }),
  createCase("mixed", "009", "請 consult agent 做方案比較", {
    lane: "executive",
    planner_action: "start",
    agent_or_tool: "agent:consult",
  }),
  createCase("mixed", "010", "請 product agent 從產品角度拆解這個任務", {
    lane: "executive",
    planner_action: "start",
    agent_or_tool: "agent:product",
  }),
];

const routingEvalSet = Object.freeze([
  ...docCases,
  ...meetingCases,
  ...runtimeCases,
  ...mixedCases,
]);

export { routingEvalSet };
