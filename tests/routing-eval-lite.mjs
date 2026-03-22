import { cleanText } from "../src/message-intent-utils.mjs";
import { resolvePlannerFlowRoute } from "../src/planner-flow-runtime.mjs";
import { plannerBdFlow } from "../src/planner-bd-flow.mjs";
import { plannerDeliveryFlow } from "../src/planner-delivery-flow.mjs";
import { plannerDocQueryFlow } from "../src/planner-doc-query-flow.mjs";
import { plannerOkrFlow } from "../src/planner-okr-flow.mjs";
import { plannerRuntimeInfoFlow } from "../src/planner-runtime-info-flow.mjs";

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

  const resolved = resolvePlannerFlowRoute({
    flows,
    userIntent: input,
    payload: {},
    logger: noopLogger,
  });

  if (resolved.flow?.id === "runtime_info" || resolved.action === "get_runtime_info") {
    return "runtime";
  }

  if (resolved.action || resolved.preset) {
    return "doc";
  }

  return hasDocSignal ? "doc" : "unknown";
}

const cases = [
  ["幫我找 Scanoo 交付流程文件", "doc"],
  ["有沒有 OKR 的資料", "doc"],
  ["目前系統 runtime 狀態", "runtime"],
  ["查一下系統運行情況", "runtime"],
  ["幫我同時看文件和系統狀態", "mixed"],
  ["文件跟 runtime 一起分析", "mixed"],
];

let correct = 0;

for (const [input, expected] of cases) {
  const actual = decideLane(input);
  const ok = actual === expected;
  if (ok) {
    correct += 1;
  }
  console.log(input, "=>", actual, ok ? "OK" : `(expected ${expected})`);
}

console.log("ACCURACY:", `${correct}/${cases.length}`);
