import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { normalizeUserResponse, renderUserResponseText } = await import("../src/user-response-normalizer.mjs");

test.after(() => {
  testDb.close();
});

function buildPlannerEnvelope({
  ok = true,
  action = "search_company_brain_docs",
  executionOk = true,
  data = {},
} = {}) {
  return {
    ok,
    action,
    execution_result: {
      ok: executionOk,
      action,
      data,
    },
  };
}

test("chat reply renders only canonical execution_result.data fields without planner trace leakage", () => {
  const plannerEnvelope = buildPlannerEnvelope({
    data: {
      answer: "我先標出和 scanooo 最相關的兩份文件讓你確認。",
      sources: [
        {
          id: "doc-scanooo",
          snippet: "Back to [README.md](/Users/seanhan/Documents/Playground/README.md)\n\n- 文件內容直接命中「scanooo」。",
          metadata: {
            title: "scanooo onboarding notes",
            url: "https://larksuite.com/docx/doc-scanooo",
            document_id: "doc-scanooo",
          },
        },
      ],
      limitations: ["如果你要，我可以繼續只整理和 scanooo 有關的段落。"],
    },
  });

  const userResponse = normalizeUserResponse({ plannerEnvelope });
  const text = renderUserResponseText(userResponse);

  assert.equal(userResponse.ok, true);
  assert.match(userResponse.answer || "", /scanooo/);
  assert.equal(userResponse.sources.length, 1);
  assert.match(text, /^結論/m);
  assert.match(text, /^重點/m);
  assert.match(text, /^下一步/m);
  assert.match(text, /scanooo onboarding notes/);
  assert.doesNotMatch(text, /trace|chosen_action|fallback_reason|kind|match_reason/);
  assert.doesNotMatch(text, /\/Users\/|Back to \[?README/);
});

test("flat execution payload is no longer normalized into answer fields", () => {
  const userResponse = normalizeUserResponse({
    plannerEnvelope: {
      ok: true,
      action: "search_company_brain_docs",
      execution_result: {
        ok: true,
        kind: "search",
        items: [
          {
            title: "Legacy Flat Result",
            doc_id: "legacy-flat",
            reason: "old flat execution payload",
          },
        ],
      },
    },
  });

  assert.equal(userResponse.ok, true);
  assert.equal(userResponse.answer, "這次我先沒有整理出可直接交付的內容。");
  assert.deepEqual(userResponse.sources, []);
  assert.deepEqual(userResponse.limitations, []);
});

test("payload.message no longer falls back into answer", () => {
  const userResponse = normalizeUserResponse({
    payload: {
      ok: false,
      message: "legacy payload message should not surface",
    },
  });

  assert.equal(userResponse.ok, false);
  assert.equal(userResponse.answer, "這次我先沒有整理出足夠內容，但不會亂補。");
  assert.deepEqual(userResponse.sources, []);
  assert.match(userResponse.limitations.join(" "), /換個說法|上下文|目標資料/);
  assert.doesNotMatch(userResponse.answer, /legacy payload message/);
});

test("partial execution data degrades gracefully into a usable user reply", () => {
  const userResponse = normalizeUserResponse({
    plannerEnvelope: buildPlannerEnvelope({
      ok: false,
      executionOk: false,
      data: {
        sources: [
          {
            title: "Meeting Notes",
            url: "https://example.com/meeting",
            snippet: "已確認的重點包含 owner 與 deadline。",
          },
        ],
        limitations: ["還缺最後一段結論，若你要我可以繼續補。"],
      },
    }),
  });

  assert.equal(userResponse.ok, false);
  assert.equal(userResponse.answer, "我先把目前能確認的部分整理給你，還沒確認的放在下一步。");
  assert.equal(userResponse.sources.length, 1);
  assert.match(userResponse.limitations.join(" "), /最後一段結論/);
});

test("payload only accepts canonical execution_result.data and still maps sources through the shared source mapper", () => {
  const userResponse = normalizeUserResponse({
    payload: {
      ok: true,
      execution_result: {
        ok: true,
        data: {
          answer: "這是整理後的回答。",
          sources: [
            {
              id: "source_runtime_1",
              snippet: "Back to [README.md](/Users/seanhan/Documents/Playground/README.md)\n\n- runtime boundary keeps evidence explicit.",
              metadata: {
                title: "Runtime Boundary",
                url: "https://example.com/runtime-boundary",
                source_type: "docx",
                document_id: "runtime_doc_1",
              },
            },
          ],
          limitations: ["如果你要，我可以再展開原文依據。"],
        },
      },
    },
  });

  assert.equal(userResponse.ok, true);
  assert.equal(userResponse.sources.length, 1);
  assert.match(userResponse.sources[0], /Runtime Boundary：runtime boundary keeps evidence explicit\./i);
  assert.match(userResponse.sources[0], /https:\/\/example\.com\/runtime-boundary/);
  assert.doesNotMatch(userResponse.sources[0], /\/Users\/|Back to \[?README|\[object Object\]/);
});

test("chat reply keeps planner skill output behind canonical execution_result.data fields", () => {
  const userResponse = normalizeUserResponse({
    plannerEnvelope: buildPlannerEnvelope({
      action: "search_and_summarize",
      data: {
        bridge: "skill_bridge",
        skill: "search_and_summarize",
        answer: "runtime boundary keeps evidence explicit and deterministic.",
        sources: [
          {
            id: "runtime_source_1",
            title: "Runtime Boundary",
            url: "https://example.com/runtime-boundary",
            snippet: "Back to [README.md](/Users/seanhan/Documents/Playground/README.md)\n\n- runtime boundary keeps evidence explicit and deterministic.",
          },
        ],
        limitations: ["如果你要，我可以再整理成 checklist。"],
        side_effects: [
          {
            mode: "read",
            action: "search_knowledge_base",
            runtime: "read-runtime",
            authority: "index",
          },
        ],
      },
    }),
  });
  const text = renderUserResponseText(userResponse);

  assert.equal(userResponse.ok, true);
  assert.match(userResponse.answer || "", /runtime boundary keeps evidence explicit and deterministic/i);
  assert.equal(userResponse.sources.length, 1);
  assert.match(userResponse.sources[0], /Runtime Boundary：runtime boundary keeps evidence explicit and deterministic\./i);
  assert.match(userResponse.limitations.join(" "), /checklist/);
  assert.doesNotMatch(text, /skill_bridge|search_and_summarize|side_effects|read-runtime|authority/);
  assert.doesNotMatch(text, /\/Users\/|Back to \[?README/);
});

test("chat reply does not merge planner-derived side channels into sources or limitations", () => {
  const userResponse = normalizeUserResponse({
    plannerEnvelope: buildPlannerEnvelope({
      action: "search_company_brain_docs",
      data: {
        answer: "這裡只保留 canonical data 內的來源。",
        sources: [
          {
            title: "Source A",
            url: "https://example.com/a",
            snippet: "source a evidence",
          },
          {
            title: "Source B",
            url: "https://example.com/b",
            snippet: "source b evidence",
          },
        ],
        limitations: ["只顯示 execution_result.data.limitations。"],
        pending_items: [
          {
            label: "待跟進：確認 owner",
            actions: [{ label: "標記完成" }],
          },
        ],
        action_layer: {
          next_actions: ["這個不應該自動併進 limitations"],
        },
      },
    }),
  });

  assert.equal(userResponse.sources.length, 1);
  assert.match(userResponse.sources[0], /Source A、Source B/);
  assert.deepEqual(userResponse.limitations, ["只顯示 execution_result.data.limitations。"]);
  assert.doesNotMatch(userResponse.sources.join(" "), /待跟進|標記完成/);
  assert.doesNotMatch(userResponse.limitations.join(" "), /不應該自動併進/);
});

test("near-duplicate sources still normalize only from execution_result.data.sources", () => {
  const userResponse = normalizeUserResponse({
    plannerEnvelope: buildPlannerEnvelope({
      data: {
        answer: "這是去重後的來源列表。",
        sources: [
          {
            title: "scanooo onboarding notes",
            url: "https://larksuite.com/docx/doc-scanooo-1",
            snippet: "文件內容直接命中「scanooo onboarding」。",
          },
          {
            title: "scanooo onboarding FAQ",
            snippet: "這份文件內容也直接命中「scanooo onboarding」。",
          },
          {
            title: "misc archive",
            snippet: "目前這份文件和「scanooo onboarding」最相關。",
          },
        ],
        limitations: [],
      },
    }),
  });

  assert.equal(userResponse.sources.length, 2);
  assert.match(userResponse.sources[0], /scanooo onboarding notes、scanooo onboarding FAQ/);
  assert.match(userResponse.sources[1], /misc archive/);
});

test("multi-intent fallback returns partial success when copy is doable but image and delivery are not", () => {
  const userResponse = normalizeUserResponse({
    requestText: "幫我寫新品上線的 FB 貼文、做一張圖片並發送出去",
    plannerEnvelope: buildPlannerEnvelope({
      ok: false,
      executionOk: false,
      data: {},
    }),
  });
  const text = renderUserResponseText(userResponse);

  assert.equal(userResponse.ok, true);
  assert.match(userResponse.answer || "", /FB|Facebook|貼文草稿/);
  assert.match(userResponse.answer || "", /新品上線/);
  assert.match(userResponse.sources.join("\n"), /已先完成：.*貼文草稿/);
  assert.match(userResponse.limitations.join("\n"), /圖片/);
  assert.match(userResponse.limitations.join("\n"), /發送或發布/);
  assert.doesNotMatch(text, /internal|routing|lane|trace|chosen_action|fallback_reason/i);
});

test("multi-intent fallback works for another mixed capability request", () => {
  const userResponse = normalizeUserResponse({
    requestText: "幫我寫招募 email、做一張 banner 再寄給客戶",
    plannerEnvelope: buildPlannerEnvelope({
      ok: false,
      executionOk: false,
      data: {},
    }),
  });

  assert.equal(userResponse.ok, true);
  assert.match(userResponse.answer || "", /Email 草稿/);
  assert.match(userResponse.answer || "", /招募/);
  assert.match(userResponse.limitations.join("\n"), /圖片|banner/i);
  assert.match(userResponse.limitations.join("\n"), /不能直接替你送出|手動貼上/);
});

test("fallback stays fail-soft when no subtask is actually completable", () => {
  const userResponse = normalizeUserResponse({
    requestText: "幫我做一張圖片並直接發送給客戶",
    plannerEnvelope: buildPlannerEnvelope({
      ok: false,
      executionOk: false,
      data: {},
    }),
  });

  assert.equal(userResponse.ok, false);
  assert.equal(userResponse.answer, "這次我先沒有整理出足夠內容，但不會亂補。");
  assert.deepEqual(userResponse.sources, []);
  assert.match(userResponse.limitations.join(" "), /換個說法|上下文|目標資料/);
});
