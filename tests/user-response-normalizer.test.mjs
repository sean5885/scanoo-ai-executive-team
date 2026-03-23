import test from "node:test";
import assert from "node:assert/strict";

import { normalizeUserResponse, renderUserResponseText } from "../src/user-response-normalizer.mjs";

test("chat reply for the exact scanooo rereview query renders natural language without planner trace leakage", () => {
  const exactQuery = "你把我的雲端文件再看一遍，把不屬於 scanooo 的內容摘出去讓我確認";
  const plannerEnvelope = {
    ok: true,
    action: "search_company_brain_docs",
    execution_result: {
      ok: true,
      kind: "search_and_detail_candidates",
      items: [
        { title: "scanooo onboarding notes", doc_id: "doc-scanooo" },
        { title: "misc archive", doc_id: "doc-misc" },
      ],
    },
    trace: {
      chosen_lane: "knowledge-assistant",
      chosen_action: "search_company_brain_docs",
      fallback_reason: "semantic_mismatch",
    },
  };

  const userResponse = normalizeUserResponse({ plannerEnvelope });
  const text = renderUserResponseText(userResponse);

  assert.equal(exactQuery, "你把我的雲端文件再看一遍，把不屬於 scanooo 的內容摘出去讓我確認");
  assert.equal(userResponse.ok, true);
  assert.match(userResponse.answer || "", /找到/);
  assert.match(text, /^答案/m);
  assert.match(text, /^來源/m);
  assert.match(text, /^待確認\/限制/m);
  assert.doesNotMatch(text, /"ok"\s*:|"error"\s*:|"details"\s*:|"trace"\s*:|"chosen_lane"\s*:|"chosen_action"\s*:|"fallback_reason"\s*:/);
  assert.doesNotMatch(text, /semantic_mismatch/);
});

test("chat reply converts semantic mismatch into natural language without exposing raw planner fields", () => {
  const userResponse = normalizeUserResponse({
    plannerEnvelope: {
      ok: false,
      error: "semantic_mismatch",
      trace: {
        chosen_lane: "knowledge-assistant",
        chosen_action: "search_company_brain_docs",
        fallback_reason: "semantic_mismatch",
      },
      execution_result: {
        ok: false,
        error: "semantic_mismatch",
        data: {
          reason: "semantic_mismatch",
        },
      },
    },
  });
  const text = renderUserResponseText(userResponse);

  assert.equal(userResponse.ok, false);
  assert.match(text, /文件|知識庫|安全/);
  assert.doesNotMatch(text, /semantic_mismatch|chosen_lane|chosen_action|fallback_reason|trace|details/);
});
