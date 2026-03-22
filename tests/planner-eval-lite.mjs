// planner correctness eval (lane + intent + basic action proxy)

import { cleanText } from "../src/message-intent-utils.mjs";
import { resolvePlannerFlowRoute } from "../src/planner-flow-runtime.mjs";
import { plannerBdFlow } from "../src/planner-bd-flow.mjs";
import { plannerDeliveryFlow } from "../src/planner-delivery-flow.mjs";
import { plannerDocQueryFlow } from "../src/planner-doc-query-flow.mjs";
import { plannerOkrFlow } from "../src/planner-okr-flow.mjs";
import { plannerRuntimeInfoFlow } from "../src/planner-runtime-info-flow.mjs";
import { queryKnowledgeWithContext } from "../src/knowledge/knowledge-service.mjs";

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const flows = [
  {
    ...plannerRuntimeInfoFlow,
    priority: 100,
    matchKeywords: [
      "runtime",
      "db path",
      "pid",
      "cwd",
      "service start",
      "service_start",
      "運行資訊",
      "运行信息",
    ],
  },
  {
    ...plannerOkrFlow,
    priority: 80,
    matchKeywords: [
      "okr",
      "目標",
      "kr",
      "關鍵結果",
      "关键结果",
      "週進度",
      "周进度",
      "本週 todo",
      "本周 todo",
      "本週todo",
      "本周todo",
    ],
  },
  {
    ...plannerBdFlow,
    priority: 80,
    matchKeywords: [
      "bd",
      "商機",
      "商机",
      "客戶",
      "客户",
      "跟進",
      "跟进",
      "demo",
      "提案",
    ],
  },
  {
    ...plannerDeliveryFlow,
    priority: 80,
    matchKeywords: [
      "交付",
      "sop",
      "驗收",
      "验收",
      "導入",
      "导入",
      "onboarding",
    ],
  },
  {
    ...plannerDocQueryFlow,
    priority: 10,
  },
];

function resolvePlannerRoute(input = "") {
  return resolvePlannerFlowRoute({
    flows,
    userIntent: input,
    payload: {},
    logger: noopLogger,
  });
}

function decideLane(input = "") {
  const normalized = cleanText(String(input || "").toLowerCase());
  const hasDocSignal = /文件|文檔|文档|資料|资料|知識庫|知识库|okr|交付|sop|onboarding|scanoo/.test(normalized);
  const hasRuntimeSignal = /runtime|系統狀態|系统状态|運行情況|运行情况|運行資訊|运行信息|db path|pid|cwd|service start/.test(normalized);

  if (hasDocSignal && hasRuntimeSignal) {
    return "mixed";
  }

  if (hasRuntimeSignal) {
    return "runtime";
  }

  const resolved = resolvePlannerRoute(input);

  if (resolved.flow?.id === "runtime_info" || resolved.action === "get_runtime_info") {
    return "runtime";
  }

  if (resolved.action || resolved.preset) {
    return "doc";
  }

  return hasDocSignal ? "doc" : "unknown";
}

function pickEvidenceKeyword(input = "", lane = "unknown") {
  if (lane !== "doc" && lane !== "mixed") {
    return null;
  }

  const normalized = cleanText(String(input || "").toLowerCase());
  const candidates = [
    ["okr", /okr|關鍵結果|关键结果|目標|目标/],
    ["交付", /交付|流程|sop|onboarding|scanoo/],
    ["文件", /文件|文檔|文档/],
    ["資料", /資料|资料/],
    ["知識庫", /知識庫|知识库/],
    ["planner", /planner/],
    ["knowledge", /knowledge/],
    ["系統", /系統|系统/],
  ];

  for (const [keyword, pattern] of candidates) {
    if (pattern.test(normalized)) {
      return keyword;
    }
  }

  return lane === "mixed" ? "文件" : null;
}

function resolveActionProxy(input = "", lane = "unknown") {
  if (lane === "runtime") {
    return "get_runtime_info";
  }

  if (lane === "mixed") {
    return "mixed_lane";
  }

  const resolved = resolvePlannerRoute(input);
  return resolved.preset || resolved.action || "none";
}

// cases: [input, expected_lane, should_have_evidence]
const cases = [
  ["幫我找 Scanoo 交付流程文件", "doc", true],
  ["有沒有 OKR 的資料", "doc", true],
  ["目前系統 runtime 狀態", "runtime", false],
  ["查一下系統運行情況", "runtime", false],
  ["幫我同時看文件和系統狀態", "mixed", true],
];

let correct = 0;

for (const [input, expectedLane, shouldHaveEvidence] of cases) {
  const lane = decideLane(input);
  const actionProxy = resolveActionProxy(input, lane);
  const evidenceKeyword = pickEvidenceKeyword(input, lane);
  const evidenceCount = evidenceKeyword ? queryKnowledgeWithContext(evidenceKeyword).length : 0;
  const evidenceOK = shouldHaveEvidence ? evidenceCount > 0 : true;
  const ok = lane === expectedLane && evidenceOK;

  if (ok) {
    correct += 1;
  }

  console.log(
    input,
    "=> lane:", lane,
    "| action:", actionProxy,
    "| evidence_keyword:", evidenceKeyword || "-",
    "| evidence:", evidenceOK ? `OK(${evidenceCount})` : `MISS(${evidenceCount})`,
    ok ? "✓" : `✗ (expected ${expectedLane})`,
  );
}

console.log("ACCURACY:", `${correct}/${cases.length}`);
