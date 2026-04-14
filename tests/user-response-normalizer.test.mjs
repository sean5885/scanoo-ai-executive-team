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
  formatted_output = null,
  error = null,
  trace = null,
} = {}) {
  return {
    ok,
    action,
    ...(error ? { error } : {}),
    execution_result: {
      ok: executionOk,
      action,
      data,
      ...(formatted_output ? { formatted_output } : {}),
    },
    ...(trace ? { trace } : {}),
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
  assert.deepEqual(userResponse.sources, [
    "目前已確認：這輪有初步結論，但還沒有足夠可驗證內容能完整交付。",
  ]);
  assert.match(userResponse.limitations.join(" "), /換個說法|補一點上下文|重試|查詢詞/);
  assert.equal(userResponse.failure_class_v2, "partial_data");
  assert.equal(userResponse.summary, userResponse.answer);
  assert.equal(userResponse.what_we_got.length, 1);
  assert.match(userResponse.next_step || "", /換個說法|補一點上下文|重試|查詢詞/);
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

test("chat reply accepts canonical get_runtime_info kind without leaking machine naming", () => {
  const userResponse = normalizeUserResponse({
    plannerEnvelope: {
      ok: true,
      action: "get_runtime_info",
      execution_result: {
        ok: true,
        kind: "get_runtime_info",
        db_path: "/tmp/runtime-normalizer.sqlite",
        node_pid: 4321,
        cwd: "/tmp/runtime-normalizer",
        service_start_time: "2026-03-27T15:00:00.000Z",
      },
    },
  });
  const text = renderUserResponseText(userResponse);

  assert.equal(userResponse.ok, true);
  assert.match(userResponse.answer || "", /runtime|PID|工作目錄|資料庫路徑/);
  assert.doesNotMatch(JSON.stringify(userResponse), /get_runtime_info|runtime_info/);
  assert.doesNotMatch(text, /get_runtime_info|runtime_info/);
});

test("payload accepts canonical top-level answer fields and maps sources through the shared answer source mapper", () => {
  const userResponse = normalizeUserResponse({
    payload: {
      ok: true,
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
    },
  });

  assert.equal(userResponse.ok, true);
  assert.equal(userResponse.sources.length, 1);
  assert.match(userResponse.sources[0], /Runtime Boundary：runtime boundary keeps evidence explicit\./i);
  assert.match(userResponse.sources[0], /https:\/\/example\.com\/runtime-boundary/);
  assert.doesNotMatch(userResponse.sources[0], /\/Users\/|Back to \[?README|\[object Object\]/);
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
  assert.equal(userResponse.failure_class, "partial_success");
  assert.match(userResponse.answer || "", /FB|Facebook|貼文草稿/);
  assert.match(userResponse.answer || "", /新品上線/);
  assert.match(userResponse.sources.join("\n"), /已先完成：.*貼文草稿/);
  assert.match(userResponse.limitations.join("\n"), /圖片/);
  assert.match(userResponse.limitations.join("\n"), /發送或發布/);
  assert.doesNotMatch(text, /internal|routing|lane|trace|chosen_action|fallback_reason/i);
});

test("planner failure on a controlled-execution request is classified as tool_omission without leaking raw errors", () => {
  const userResponse = normalizeUserResponse({
    requestText: "幫我整理 OKR 文件重點",
    plannerEnvelope: buildPlannerEnvelope({
      ok: false,
      action: "",
      executionOk: false,
      error: "planner_failed",
      data: {
        answer: "這輪不是你問題不清楚，而是我這邊沒有順利排出安全可執行的步驟，所以先不亂做。",
        sources: [],
        limitations: ["你可以直接重試同一句；如果要更穩，例如把「幫我整理 OKR 文件重點」拆成先查文件，再整理重點。"],
      },
      trace: {
        chosen_action: null,
        fallback_reason: "planner_failed",
      },
    }),
  });

  assert.equal(userResponse.ok, false);
  assert.equal(userResponse.failure_class, "tool_omission");
  assert.doesNotMatch(userResponse.answer || "", /planner_failed/i);
});

test("routing no match stays classified without exposing internal routing code in reply text", () => {
  const userResponse = normalizeUserResponse({
    requestText: "晚點提醒我一下",
    plannerEnvelope: buildPlannerEnvelope({
      ok: false,
      executionOk: false,
      error: "business_error",
      data: {
        answer: "這題我先沒走到合適的處理方式，所以先用一般助理的方式接住你。",
        sources: [],
        limitations: ["你可以直接說想整理什麼、查哪份文件，或要我看什麼狀態，我會改用更合適的方式處理。"],
      },
      trace: {
        chosen_action: null,
        fallback_reason: "ROUTING_NO_MATCH",
      },
    }),
  });

  assert.equal(userResponse.failure_class, "routing_no_match");
  assert.doesNotMatch(renderUserResponseText(userResponse), /ROUTING_NO_MATCH|routing/i);
});

test("auth-required failures are classified as permission_denied", () => {
  const userResponse = normalizeUserResponse({
    requestText: "幫我查詢 OKR 文件",
    plannerEnvelope: buildPlannerEnvelope({
      ok: false,
      executionOk: false,
      error: "missing_user_access_token",
      data: {
        answer: "這次我先不直接查文件，因為目前這條文件路徑是 auth-required，而這輪請求沒有帶到可驗證的 Lark 使用者授權。",
        sources: [],
        limitations: ["請從有帶授權的 Lark 對話重新送出這輪需求，或先完成登入授權。"],
      },
      trace: {
        chosen_action: "search_company_brain_docs",
        fallback_reason: "missing_user_access_token",
      },
    }),
  });

  assert.equal(userResponse.failure_class, "permission_denied");
  assert.equal(userResponse.failure_class_v2, "user_input_missing");
  assert.match(userResponse.answer || "", /授權/);
});

test("timeout failures keep fail-soft shape and map v2 failure class", () => {
  const userResponse = normalizeUserResponse({
    requestText: "幫我查 runtime",
    plannerEnvelope: buildPlannerEnvelope({
      ok: false,
      executionOk: false,
      error: "request_timeout",
      data: {
        answer: "request_timeout",
        sources: [],
        limitations: ["請重試"],
      },
      trace: {
        fallback_reason: "request_timeout",
      },
    }),
  });

  assert.equal(userResponse.ok, false);
  assert.equal(userResponse.failure_class_v2, "timeout");
  assert.match(userResponse.answer || "", /逾時|時限|可確認/);
  assert.match(userResponse.next_step || "", /重試|再試/);
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

test("successful document answer plus delivery request is upgraded to partial success with explicit limitation", () => {
  const userResponse = normalizeUserResponse({
    requestText: "幫我整理 OKR 文件重點再寄給團隊",
    plannerEnvelope: buildPlannerEnvelope({
      ok: true,
      action: "search_and_detail_doc",
      executionOk: true,
      formatted_output: {
        kind: "search_and_detail",
        title: "OKR Weekly Review",
        doc_id: "doc-okr-1",
        items: [
          {
            title: "OKR Weekly Review",
            doc_id: "doc-okr-1",
            reason: "文件內容直接命中 OKR。",
          },
        ],
        match_reason: "OKR",
        content_summary: "這份文件整理了本週 OKR 進度、阻塞點與下週重點。",
        found: true,
      },
    }),
  });

  assert.equal(userResponse.ok, true);
  assert.equal(userResponse.failure_class, "partial_success");
  assert.match(userResponse.answer || "", /OKR Weekly Review/);
  assert.match(userResponse.sources.join("\n"), /已先完成：文件內容整理/);
  assert.match(userResponse.sources.join("\n"), /發送或發布/);
  assert.match(userResponse.limitations.join("\n"), /不能直接替你送出|手動貼上/);
});

test("successful runtime answer plus delivery request is upgraded to partial success", () => {
  const userResponse = normalizeUserResponse({
    requestText: "先查 runtime db path 再發給團隊",
    plannerEnvelope: buildPlannerEnvelope({
      ok: true,
      action: "get_runtime_info",
      executionOk: true,
      formatted_output: {
        kind: "get_runtime_info",
        db_path: "/tmp/lobster/runtime.db",
        cwd: "/Users/seanhan/Documents/Playground",
        node_pid: 4242,
      },
    }),
  });

  assert.equal(userResponse.ok, true);
  assert.equal(userResponse.failure_class, "partial_success");
  assert.match(userResponse.answer || "", /runtime 有正常回應|資料庫路徑/);
  assert.match(userResponse.sources.join("\n"), /已先完成：runtime 資訊查詢/);
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
  assert.deepEqual(userResponse.sources, [
    "目前已確認：這輪有初步結論，但還沒有足夠可驗證內容能完整交付。",
  ]);
  assert.match(userResponse.limitations.join(" "), /換個說法|補一點上下文|重試|查詢詞/);
  assert.equal(userResponse.failure_class_v2, "partial_data");
});
