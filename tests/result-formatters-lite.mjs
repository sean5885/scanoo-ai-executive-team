import {
  formatMeetingResult,
  formatDocResult,
  formatRuntimeResult,
  formatMixedResult,
} from "../src/planner/result-formatters.mjs";

const cases = [
  [formatMeetingResult({ status: "ok", summary: "meeting done" }), "meeting"],
  [formatDocResult({ status: "ok", answer: "doc done" }), "doc"],
  [formatRuntimeResult({ status: "ok", runtime_status: "healthy" }), "runtime"],
  [formatMixedResult({ status: "ok", message: "mixed done" }), "mixed"],
];

let ok = 0;
for (const [out, kind] of cases) {
  const pass =
    out.kind === kind &&
    out.status === "ok" &&
    typeof out.summary === "string" &&
    Array.isArray(out.actionable_items) &&
    typeof out.confidence === "number";
  if (pass) ok++;
  console.log(kind, pass ? "PASS" : "FAIL", out.summary);
}
console.log("RESULT FORMATTERS:", ok + "/" + cases.length);
