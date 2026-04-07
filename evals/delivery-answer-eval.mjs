function createDeliveryAnswerEval(entry = {}) {
  return Object.freeze({
    id: entry.id,
    user_text: entry.user_text,
    expected_lane: "knowledge_assistant",
    expected_planner_action: entry.expected_planner_action,
    expected_agent_or_tool: `tool:${entry.expected_planner_action}`,
    tool_required: true,
    fixture: Object.freeze({
      doc_id: entry.fixture.doc_id,
      title: entry.fixture.title,
      url: entry.fixture.url,
      search_snippet: entry.fixture.search_snippet,
      content_summary: entry.fixture.content_summary,
      content: entry.fixture.content,
    }),
    quality: Object.freeze({
      answer_must_include_all: Object.freeze([...(entry.quality?.answer_must_include_all || [])]),
      answer_must_include_any: Object.freeze([...(entry.quality?.answer_must_include_any || [])]),
      reject_answer_patterns: Object.freeze([...(entry.quality?.reject_answer_patterns || [])]),
    }),
  });
}

const REJECT_GENERIC_SEARCH_ANSWER = "我已先按目前已索引的文件";

const DELIVERY_FLOW_FIXTURE = Object.freeze({
  doc_id: "doc_delivery_flow",
  title: "交付驗收流程",
  url: "https://example.com/delivery-flow",
  search_snippet: "Kickoff、環境準備、資料驗證、試跑、正式驗收。",
  content_summary: "先做 kickoff 對齊範圍，再完成環境與資料準備，接著試跑與問題修正，最後由 owner 驗收交付。",
  content: "內容重點：先做 kickoff 對齊範圍，再完成環境與資料準備，接著試跑與問題修正，最後由 owner 驗收交付。",
});

const ONBOARDING_FLOW_FIXTURE = Object.freeze({
  doc_id: "doc_onboarding_flow",
  title: "Onboarding 流程",
  url: "https://example.com/onboarding-flow",
  search_snippet: "新人報到、工具開通、第一週訓練、owner 追蹤與驗收。",
  content_summary: "先完成新人報到與資訊收集，再開通工具權限、安排第一週訓練，最後由 owner 追蹤使用狀況並驗收。",
  content: "內容重點：先完成新人報到與資訊收集，再開通工具權限、安排第一週訓練，最後由 owner 追蹤使用狀況並驗收。",
});

const IMPLEMENTATION_SOP_FIXTURE = Object.freeze({
  doc_id: "doc_implementation_sop",
  title: "導入 SOP",
  url: "https://example.com/implementation-sop",
  search_snippet: "文件位置在 Delivery / Onboarding 資料夾；需求確認、環境開通、資料準備、試跑驗收。",
  content_summary: "文件位置在 Delivery / Onboarding 資料夾；先確認導入目標與 owner，再完成環境開通、資料準備、試跑，最後正式驗收。",
  content: "內容重點：文件位置在 Delivery / Onboarding 資料夾；先確認導入目標與 owner，再完成環境開通、資料準備、試跑，最後正式驗收。",
});

const ONBOARDING_CHECKLIST_FIXTURE = Object.freeze({
  doc_id: "doc_onboarding_checklist",
  title: "Onboarding Checklist",
  url: "https://example.com/onboarding-checklist",
  search_snippet: "報到前準備、帳號開通、教育訓練、首週驗收。",
  content_summary: "Checklist 可先看四項：報到前資料確認、帳號與權限開通、產品教育訓練、第一週使用追蹤與 owner 驗收。",
  content: "內容重點：報到前資料確認、帳號與權限開通、產品教育訓練、第一週使用追蹤、owner 驗收。",
});

const ACCEPTANCE_CHECKLIST_FIXTURE = Object.freeze({
  doc_id: "doc_acceptance_checklist",
  title: "交付驗收 Checklist",
  url: "https://example.com/acceptance-checklist",
  search_snippet: "需求範圍確認、測試結果、owner 確認、上線前驗收。",
  content_summary: "交付前可先確認四項：需求範圍、測試結果、owner 簽核，以及上線前驗收紀錄。",
  content: "內容重點：需求範圍確認、測試結果整理、owner 確認、上線前驗收。",
});

export const deliveryAnswerEvals = [
  createDeliveryAnswerEval({
    id: "delivery-answer-001",
    user_text: "請整理交付驗收流程",
    expected_planner_action: "search_and_detail_doc",
    fixture: DELIVERY_FLOW_FIXTURE,
    quality: {
      answer_must_include_all: ["交付驗收流程"],
      answer_must_include_any: ["kickoff", "驗收交付", "資料準備"],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-002",
    user_text: "交付驗收流程講給我聽",
    expected_planner_action: "search_and_detail_doc",
    fixture: DELIVERY_FLOW_FIXTURE,
    quality: {
      answer_must_include_all: ["交付驗收流程"],
      answer_must_include_any: ["kickoff", "試跑", "驗收交付"],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-003",
    user_text: "交付流程是怎麼跑的",
    expected_planner_action: "search_company_brain_docs",
    fixture: DELIVERY_FLOW_FIXTURE,
    quality: {
      answer_must_include_all: ["交付驗收流程"],
      answer_must_include_any: ["kickoff", "試跑", "資料驗證"],
      reject_answer_patterns: [REJECT_GENERIC_SEARCH_ANSWER],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-004",
    user_text: "onboarding 流程講給我聽",
    expected_planner_action: "search_and_detail_doc",
    fixture: ONBOARDING_FLOW_FIXTURE,
    quality: {
      answer_must_include_all: ["onboarding 流程"],
      answer_must_include_any: ["新人報到", "工具權限", "驗收"],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-005",
    user_text: "把 onboarding 流程講給我聽",
    expected_planner_action: "search_and_detail_doc",
    fixture: ONBOARDING_FLOW_FIXTURE,
    quality: {
      answer_must_include_all: ["onboarding 流程"],
      answer_must_include_any: ["新人報到", "第一週訓練", "驗收"],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-006",
    user_text: "導入 SOP 在哪",
    expected_planner_action: "search_company_brain_docs",
    fixture: IMPLEMENTATION_SOP_FIXTURE,
    quality: {
      answer_must_include_all: ["導入 sop"],
      answer_must_include_any: ["連結", "delivery / onboarding", "資料夾"],
      reject_answer_patterns: [REJECT_GENERIC_SEARCH_ANSWER],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-007",
    user_text: "交付 SOP 在哪",
    expected_planner_action: "search_company_brain_docs",
    fixture: IMPLEMENTATION_SOP_FIXTURE,
    quality: {
      answer_must_include_all: ["導入 sop"],
      answer_must_include_any: ["連結", "delivery / onboarding", "資料夾"],
      reject_answer_patterns: [REJECT_GENERIC_SEARCH_ANSWER],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-008",
    user_text: "onboarding checklist 是什麼",
    expected_planner_action: "search_company_brain_docs",
    fixture: ONBOARDING_CHECKLIST_FIXTURE,
    quality: {
      answer_must_include_all: ["onboarding checklist"],
      answer_must_include_any: ["帳號開通", "教育訓練", "首週驗收"],
      reject_answer_patterns: [REJECT_GENERIC_SEARCH_ANSWER],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-009",
    user_text: "新客 onboarding checklist 在哪",
    expected_planner_action: "search_company_brain_docs",
    fixture: ONBOARDING_CHECKLIST_FIXTURE,
    quality: {
      answer_must_include_all: ["onboarding checklist"],
      answer_must_include_any: ["連結", "帳號開通", "首週驗收"],
      reject_answer_patterns: [REJECT_GENERIC_SEARCH_ANSWER],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-010",
    user_text: "怎麼開始導入",
    expected_planner_action: "search_company_brain_docs",
    fixture: IMPLEMENTATION_SOP_FIXTURE,
    quality: {
      answer_must_include_all: ["導入 sop"],
      answer_must_include_any: ["先確認導入目標", "環境開通", "資料準備"],
      reject_answer_patterns: [REJECT_GENERIC_SEARCH_ANSWER],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-011",
    user_text: "我要怎麼開始 onboarding",
    expected_planner_action: "search_company_brain_docs",
    fixture: ONBOARDING_FLOW_FIXTURE,
    quality: {
      answer_must_include_all: ["onboarding 流程"],
      answer_must_include_any: ["新人報到", "工具權限", "第一週訓練"],
      reject_answer_patterns: [REJECT_GENERIC_SEARCH_ANSWER],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-012",
    user_text: "導入 SOP 怎麼走",
    expected_planner_action: "search_company_brain_docs",
    fixture: IMPLEMENTATION_SOP_FIXTURE,
    quality: {
      answer_must_include_all: ["導入 sop"],
      answer_must_include_any: ["先確認導入目標", "環境開通", "試跑"],
      reject_answer_patterns: [REJECT_GENERIC_SEARCH_ANSWER],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-013",
    user_text: "交付驗收 checklist 在哪",
    expected_planner_action: "search_company_brain_docs",
    fixture: ACCEPTANCE_CHECKLIST_FIXTURE,
    quality: {
      answer_must_include_all: ["交付驗收 checklist"],
      answer_must_include_any: ["連結", "owner", "測試結果"],
      reject_answer_patterns: [REJECT_GENERIC_SEARCH_ANSWER],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-014",
    user_text: "導入驗收要看什麼",
    expected_planner_action: "search_and_detail_doc",
    fixture: ACCEPTANCE_CHECKLIST_FIXTURE,
    quality: {
      answer_must_include_all: ["交付驗收 checklist"],
      answer_must_include_any: ["需求範圍", "測試結果", "owner"],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-015",
    user_text: "交付前要確認哪些項目",
    expected_planner_action: "search_company_brain_docs",
    fixture: ACCEPTANCE_CHECKLIST_FIXTURE,
    quality: {
      answer_must_include_all: ["交付驗收 checklist"],
      answer_must_include_any: ["需求範圍", "測試結果", "owner"],
      reject_answer_patterns: [REJECT_GENERIC_SEARCH_ANSWER],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-016",
    user_text: "請整理 onboarding 驗收重點",
    expected_planner_action: "search_and_detail_doc",
    fixture: ONBOARDING_CHECKLIST_FIXTURE,
    quality: {
      answer_must_include_all: ["onboarding checklist"],
      answer_must_include_any: ["帳號與權限開通", "教育訓練", "驗收"],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-017",
    user_text: "onboarding 驗收怎麼做",
    expected_planner_action: "search_and_detail_doc",
    fixture: ONBOARDING_CHECKLIST_FIXTURE,
    quality: {
      answer_must_include_all: ["onboarding checklist"],
      answer_must_include_any: ["帳號與權限開通", "第一週使用追蹤", "驗收"],
    },
  }),
  createDeliveryAnswerEval({
    id: "delivery-answer-018",
    user_text: "導入前第一步做什麼",
    expected_planner_action: "search_company_brain_docs",
    fixture: IMPLEMENTATION_SOP_FIXTURE,
    quality: {
      answer_must_include_all: ["導入 sop"],
      answer_must_include_any: ["先確認導入目標", "owner", "環境開通"],
      reject_answer_patterns: [REJECT_GENERIC_SEARCH_ANSWER],
    },
  }),
];
