import { executeAgent } from "../src/planner/agent-executor.mjs";

const cases = [
  [{ selected_action: "search_company_brain_docs" }, "company_brain_agent", "company_brain_read"],
  [{ selected_action: "get_runtime_info" }, "runtime_agent", "runtime_check"],
  [{ selected_action: "create_doc" }, "planner_agent", "planner_route"],
  [{ task_type: "skill_read" }, "company_brain_agent", "company_brain_read"],
];

let ok = 0;

for (const [input, agent, action] of cases) {
  const out = executeAgent(input);
  const pass = out.agent === agent && out.action === action;
  if (pass) ok += 1;
  console.log(JSON.stringify(input), "=>", out.agent, out.action, pass ? "PASS" : "FAIL");
}

console.log("AGENT EXECUTOR:", ok + "/" + cases.length);
