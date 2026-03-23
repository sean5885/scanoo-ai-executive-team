import { resetPlannerRuntimeContext } from "../src/executive-planner.mjs";
import { runRealUserTask } from "../scripts/real-user-loop.mjs";

const cases = [
  ["幫我總結會議", "meeting", "meeting"],
  ["搜尋 OKR 文件", "doc", "doc"],
  ["目前系統穩不穩，是否有風險", "", "runtime"],
];

let ok = 0;

for (const [message, taskType, expectedKind] of cases) {
  resetPlannerRuntimeContext();

  const out = await runRealUserTask({
    message,
    taskType,
  });

  const result = out?.final_result || {};
  const pass =
    out?.final_result === out?.agent_execution?.result &&
    result.kind === expectedKind &&
    result.status === "ok" &&
    typeof result.summary === "string" &&
    Array.isArray(result.actionable_items) &&
    typeof result.confidence === "number";

  if (pass) {
    ok += 1;
  } else {
    process.exitCode = 1;
  }

  console.log(message, pass ? "PASS" : "FAIL", result.kind, result.summary);
}

console.log("REAL USER PRODUCTIZED:", `${ok}/${cases.length}`);
