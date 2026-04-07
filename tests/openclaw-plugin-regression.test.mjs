import test from "node:test";
import assert from "node:assert/strict";

import register from "../openclaw-plugin/lark-kb/index.ts";

function createPluginApi() {
  const tools = [];
  return {
    pluginConfig: {
      baseUrl: "http://127.0.0.1:3333",
      timeoutMs: 2_000,
    },
    tools,
    registerTool(tool) {
      tools.push(tool);
    },
  };
}

function getTool(api, name) {
  const tool = api.tools.find((item) => item.name === name);
  assert.ok(tool, `expected tool ${name} to be registered`);
  return tool;
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test("openclaw plugin registers company-brain runtime tools", () => {
  const api = createPluginApi();
  register(api);

  const names = new Set(api.tools.map((tool) => tool.name));
  assert.equal(names.has("company_brain_review_doc"), true);
  assert.equal(names.has("company_brain_conflict_check"), true);
  assert.equal(names.has("company_brain_approval_transition"), true);
  assert.equal(names.has("company_brain_apply"), true);
  assert.equal(names.has("company_brain_search_approved"), true);
  assert.equal(names.has("company_brain_get_approved_doc"), true);
});

test("company_brain_apply uses the explicit apply route and returns structured output", async (t) => {
  const api = createPluginApi();
  register(api);
  const tool = getTool(api, "company_brain_apply");
  const seen = [];

  stubFetch(t, async (url, init = {}) => {
    seen.push({
      url: String(url),
      method: init.method || "GET",
      headers: init.headers,
      body: init.body ? JSON.parse(String(init.body)) : null,
    });

    if (String(url).endsWith("/agent/lark-plugin/dispatch")) {
      return new Response(JSON.stringify({
        ok: true,
        route_target: "plugin_native",
        final_status: "plugin_native_forward",
        forward_request: {
          path: "/agent/company-brain/docs/doc-1/apply",
          method: "POST",
          body: {
            actor: "reviewer@test",
            source_stage: "approved_knowledge",
            account_id: "acct-1",
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      action: "apply_company_brain_approved_knowledge",
      data: {
        success: true,
        data: {
          doc_id: "doc-1",
          approval: {
            status: "approved",
          },
        },
        error: null,
      },
      trace_id: "trace_company_brain_apply",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const result = await tool.execute("tool-1", {
    doc_id: "doc-1",
    actor: "reviewer@test",
    source_stage: "approved_knowledge",
    account_id: "acct-1",
  });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, "http://127.0.0.1:3333/agent/lark-plugin/dispatch");
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].body.tool_name, "company_brain_apply");
  assert.equal(seen[0].body.route_request.path, "/agent/company-brain/docs/doc-1/apply");
  assert.equal(seen[1].url, "http://127.0.0.1:3333/agent/company-brain/docs/doc-1/apply");
  assert.equal(seen[1].method, "POST");
  assert.equal(typeof seen[1].headers["X-Request-Id"], "string");
  assert.deepEqual(seen[1].body, {
    actor: "reviewer@test",
    source_stage: "approved_knowledge",
    account_id: "acct-1",
  });
  assert.match(result.content[0].text, /company_brain_apply/);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.action, "apply_company_brain_approved_knowledge");
});

test("lark_kb_answer first enters plugin dispatch instead of calling /answer directly", async (t) => {
  const api = createPluginApi();
  register(api);
  const tool = getTool(api, "lark_kb_answer");
  const seen = [];

  stubFetch(t, async (url, init = {}) => {
    seen.push({
      url: String(url),
      method: init.method || "GET",
      body: init.body ? JSON.parse(String(init.body)) : null,
    });

    assert.equal(String(url), "http://127.0.0.1:3333/agent/lark-plugin/dispatch");
    return new Response(JSON.stringify({
      ok: true,
      route_target: "knowledge_answer",
      final_status: "completed",
      response: {
        status: 200,
        data: {
          ok: true,
          answer: "這是 adapter 回來的答案",
          sources: ["source-a"],
          limitations: [],
        },
      },
      trace_id: "trace_dispatch_answer",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const result = await tool.execute("tool-2", {
    q: "公司知識庫現在怎麼運作？",
    account_id: "acct-2",
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.tool_name, "lark_kb_answer");
  assert.equal(seen[0].body.route_request.path, "/answer?q=%E5%85%AC%E5%8F%B8%E7%9F%A5%E8%AD%98%E5%BA%AB%E7%8F%BE%E5%9C%A8%E6%80%8E%E9%BA%BC%E9%81%8B%E4%BD%9C%EF%BC%9F&account_id=acct-2");
  assert.match(result.content[0].text, /lark_kb_answer/);
  assert.equal(result.details.answer, "這是 adapter 回來的答案");
});

test("plugin dispatch payload keeps metadata keys complete and preserves explicit values", async (t) => {
  const api = createPluginApi();
  register(api);
  const tool = getTool(api, "lark_kb_answer");
  const seen = [];

  stubFetch(t, async (url, init = {}) => {
    seen.push({
      url: String(url),
      method: init.method || "GET",
      body: init.body ? JSON.parse(String(init.body)) : null,
    });

    return new Response(JSON.stringify({
      ok: true,
      route_target: "knowledge_answer",
      final_status: "completed",
      response: {
        status: 200,
        data: {
          ok: true,
          answer: "ok",
          sources: [],
          limitations: [],
        },
      },
      trace_id: "trace_dispatch_meta",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await tool.execute("tool-meta", {
    q: "請分析這個問題",
    account_id: "acct-meta",
    request_text: "請分析這個問題",
    session_id: "sess-meta",
    thread_id: "thr-meta",
    chat_id: "chat-meta",
    user_id: "user-meta",
    source: "official_lark_plugin",
    requested_capability: "lane_style_capability",
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://127.0.0.1:3333/agent/lark-plugin/dispatch");
  assert.deepEqual(seen[0].body, {
    request_text: "請分析這個問題",
    session_id: "sess-meta",
    thread_id: "thr-meta",
    chat_id: "chat-meta",
    user_id: "user-meta",
    account_id: "acct-meta",
    source: "official_lark_plugin",
    tool_name: "lark_kb_answer",
    requested_capability: "lane_style_capability",
    route_request: {
      path: "/answer?q=%E8%AB%8B%E5%88%86%E6%9E%90%E9%80%99%E5%80%8B%E5%95%8F%E9%A1%8C&account_id=acct-meta",
      method: "GET",
      body: null,
    },
  });
});

test("plugin dispatch payload keeps missing metadata as null instead of omitting keys", async (t) => {
  const api = createPluginApi();
  register(api);
  const tool = getTool(api, "lark_doc_read");
  const seen = [];

  stubFetch(t, async (url, init = {}) => {
    seen.push({
      url: String(url),
      method: init.method || "GET",
      body: init.body ? JSON.parse(String(init.body)) : null,
    });

    return new Response(JSON.stringify({
      ok: true,
      route_target: "plugin_native",
      final_status: "plugin_native_forward",
      forward_request: {
        path: "/api/doc/read?document_id=doc_meta",
        method: "GET",
        body: null,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await tool.execute("tool-meta-null", {
    document_id: "doc_meta",
  });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, "http://127.0.0.1:3333/agent/lark-plugin/dispatch");
  assert.deepEqual(seen[0].body, {
    request_text: null,
    session_id: null,
    thread_id: null,
    chat_id: null,
    user_id: null,
    account_id: null,
    source: "official_lark_plugin",
    tool_name: "lark_doc_read",
    requested_capability: "lark_doc_read",
    route_request: {
      path: "/api/doc/read?document_id=doc_meta",
      method: "GET",
      body: null,
    },
  });
});

test("lobster_security_run_action keeps approval_required as a non-throwing plugin result", async (t) => {
  const api = createPluginApi();
  register(api);
  const tool = getTool(api, "lobster_security_run_action");

  stubFetch(t, async (url) => {
    if (String(url).endsWith("/agent/lark-plugin/dispatch")) {
      return new Response(JSON.stringify({
        ok: true,
        route_target: "plugin_native",
        final_status: "plugin_native_forward",
        forward_request: {
          path: "/agent/tasks/task-1/actions",
          method: "POST",
          body: {
            action: {
              type: "command",
              command: ["rm", "-rf", "/tmp/not-real"],
            },
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      ok: false,
      status: "approval_required",
      approval_request: {
        request_id: "req-1",
        reason: "high_risk_command",
      },
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  });

  const result = await tool.execute("tool-1", {
    task_id: "task-1",
    action: {
      type: "command",
      command: ["rm", "-rf", "/tmp/not-real"],
    },
  });

  assert.match(result.content[0].text, /lobster_security_run_action/);
  assert.equal(result.details.status, "approval_required");
  assert.equal(result.details.approval_request.request_id, "req-1");
});
