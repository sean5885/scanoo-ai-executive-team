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
      kind: "search",
      match_reason: "scanooo",
      items: [
        {
          title: "scanooo onboarding notes",
          doc_id: "doc-scanooo",
          url: "https://larksuite.com/docx/doc-scanooo",
          reason: "文件內容直接命中「scanooo」。",
        },
        {
          title: "misc archive",
          doc_id: "doc-misc",
          reason: "目前這份文件和「scanooo」最相關。",
        },
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
  assert.match(userResponse.answer || "", /scanooo|標出/);
  assert.match(text, /^結論/m);
  assert.match(text, /^重點/m);
  assert.match(text, /^下一步/m);
  assert.match(text, /scanooo onboarding notes/);
  assert.match(text, /https:\/\/larksuite\.com\/docx\/doc-scanooo/);
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

test("chat reply converts missing_user_access_token into explicit natural-language auth guidance", () => {
  const userResponse = normalizeUserResponse({
    plannerEnvelope: {
      ok: false,
      error: "missing_user_access_token",
      trace: {
        chosen_action: "search_company_brain_docs",
        fallback_reason: "missing_user_access_token",
      },
      execution_result: {
        ok: false,
        error: "missing_user_access_token",
        data: {
          reason: "missing_user_access_token",
        },
      },
    },
  });
  const text = renderUserResponseText(userResponse);

  assert.equal(userResponse.ok, false);
  assert.match(text, /auth-required|授權/);
  assert.match(text, /明確的使用者 token|重新送出/);
  assert.doesNotMatch(text, /missing_user_access_token|trace|chosen_action|fallback_reason/);
});

test("chat reply explains why no document was found instead of returning a generic no-result line", () => {
  const userResponse = normalizeUserResponse({
    plannerEnvelope: {
      ok: true,
      action: "search_and_detail_doc",
      execution_result: {
        ok: true,
        kind: "search_and_detail_not_found",
        match_reason: "scanooo",
        content_summary: "目前沒有找到標題、文件代號、摘要或已學習標籤明確命中「scanooo」的已索引文件。",
      },
    },
  });
  const text = renderUserResponseText(userResponse);

  assert.equal(userResponse.ok, true);
  assert.match(text, /沒有找到標題、文件代號、摘要或已學習標籤/);
  assert.match(text, /^重點\n- 目前沒有足夠已驗證來源可補更多重點。/m);
  assert.match(text, /^下一步/m);
});

test("chat reply states source gap instead of inventing detail summary when doc detail evidence is thin", () => {
  const userResponse = normalizeUserResponse({
    plannerEnvelope: {
      ok: true,
      action: "get_company_brain_doc_detail",
      execution_result: {
        ok: true,
        kind: "detail",
        title: "Scanoo SOP",
        doc_id: "doc_scanoo_sop",
        items: [
          {
            title: "Scanoo SOP",
            doc_id: "doc_scanoo_sop",
            reason: "文件標題直接命中「scanoo」。",
          },
        ],
        content_summary: "",
      },
    },
  });
  const text = renderUserResponseText(userResponse);

  assert.equal(userResponse.ok, true);
  assert.match(userResponse.answer || "", /來源不足|不補更多內容細節/);
  assert.match(text, /^重點/m);
  assert.match(text, /Scanoo SOP：文件標題直接命中/);
  assert.doesNotMatch(text, /流程|owner|deadline|驗收/);
});

test("chat reply merges similar evidence points instead of listing near-duplicate source rows", () => {
  const userResponse = normalizeUserResponse({
    plannerEnvelope: {
      ok: true,
      action: "search_company_brain_docs",
      params: {
        q: "scanooo onboarding",
      },
      execution_result: {
        ok: true,
        kind: "search",
        match_reason: "scanooo onboarding",
        items: [
          {
            title: "scanooo onboarding notes",
            doc_id: "doc-scanooo-1",
            url: "https://larksuite.com/docx/doc-scanooo-1",
            reason: "文件內容直接命中「scanooo onboarding」。",
          },
          {
            title: "scanooo onboarding FAQ",
            doc_id: "doc-scanooo-2",
            reason: "這份文件內容也直接命中「scanooo onboarding」。",
          },
          {
            title: "misc archive",
            doc_id: "doc-misc",
            reason: "目前這份文件和「scanooo onboarding」最相關。",
          },
        ],
      },
    },
  });

  assert.equal(userResponse.sources.length, 2);
  assert.match(userResponse.sources[0], /scanooo onboarding notes、scanooo onboarding FAQ/);
  assert.match(userResponse.sources[0], /直接命中「scanooo onboarding」/);
  assert.match(userResponse.sources[1], /misc archive/);
});

test("chat reply suggests concrete debug next step when current evidence is insufficient", () => {
  const userResponse = normalizeUserResponse({
    plannerEnvelope: {
      ok: true,
      action: "search_and_detail_doc",
      params: {
        q: "payment timeout 怎麼 debug",
      },
      execution_result: {
        ok: true,
        kind: "search_and_detail_not_found",
        match_reason: "payment timeout 怎麼 debug",
        content_summary: "目前沒有找到可以直接對應 payment timeout 的已索引文件。",
      },
    },
  });

  assert.equal(userResponse.ok, true);
  assert.match(userResponse.limitations.join(" "), /錯誤訊息|trace 關鍵字|觸發步驟/);
  assert.ok(userResponse.limitations.length <= 3);
});

test("chat reply suggests comparison-oriented next step for decision-style queries", () => {
  const userResponse = normalizeUserResponse({
    plannerEnvelope: {
      ok: true,
      action: "search_company_brain_docs",
      params: {
        q: "A 方案跟 B 方案要選哪個比較好",
      },
      execution_result: {
        ok: true,
        kind: "search",
        match_reason: "A 方案跟 B 方案要選哪個比較好",
        items: [
          {
            title: "方案 A 評估",
            doc_id: "doc-a",
            reason: "這份文件直接命中「A 方案」。",
          },
          {
            title: "方案 B 評估",
            doc_id: "doc-b",
            reason: "這份文件直接命中「B 方案」。",
          },
        ],
      },
    },
  });

  assert.equal(userResponse.ok, true);
  assert.match(userResponse.limitations.join(" "), /比較差異|風險|適用範圍|比較的方案/);
  assert.ok(userResponse.sources.length <= 3);
  assert.ok(userResponse.limitations.length <= 3);
});
