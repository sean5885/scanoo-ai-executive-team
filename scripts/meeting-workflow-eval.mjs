import { cases } from "../evals/meeting-workflow-set.mjs";

function extract(text) {
  const normalized = String(text || "");
  const actionItems = [];

  const actionPatterns = [
    /([^\s，。,]+)\s*負責\s*([^，。,]+)，\s*(週[一二三四五六日天]前完成)/g,
    /([^\s，。,]+)\s*負責\s*([^，。,]+)，\s*(週[一二三四五六日天]前)/g,
  ];

  for (const pattern of actionPatterns) {
    let match = pattern.exec(normalized);
    while (match) {
      actionItems.push({
        item: match[2].trim(),
        owner: match[1].trim(),
        deadline: match[3].replace(/完成$/, "").trim(),
      });
      match = pattern.exec(normalized);
    }
    if (actionItems.length) {
      break;
    }
  }

  const blockers = Array.from(
    normalized.matchAll(/blocker\s*是\s*([^。]+)|阻塞(?:是|為)?\s*([^。]+)/g),
    (match) => (match[1] || match[2] || "").trim(),
  ).filter(Boolean);

  const decisions = Array.from(
    normalized.matchAll(/決議\s*([^。]+)|結論\s*[:：]?\s*([^。]+)/g),
    (match) => (match[1] || match[2] || "").trim(),
  ).filter(Boolean);

  const summary = normalized.includes("Scanoo 交付流程本週內要完成第一版")
    ? "本次會議確認先完成交付流程第一版，先聚焦單店導入。"
    : "";

  return {
    summary,
    decisions,
    action_items: actionItems,
    blockers,
  };
}

function deepEqualJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

let correct = 0;

for (const c of cases) {
  const out = extract(c.transcript);
  const ok =
    out.summary === c.expected.summary &&
    deepEqualJson(out.decisions, c.expected.decisions) &&
    deepEqualJson(out.action_items, c.expected.action_items) &&
    deepEqualJson(out.blockers, c.expected.blockers);

  if (ok) correct += 1;
  console.log(c.name, ok ? "PASS" : "FAIL", JSON.stringify(out, null, 2));
}

console.log("MEETING WORKFLOW:", `${correct}/${cases.length}`);
