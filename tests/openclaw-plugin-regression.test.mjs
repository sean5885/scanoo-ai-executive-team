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

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://127.0.0.1:3333/agent/company-brain/docs/doc-1/apply");
  assert.equal(seen[0].method, "POST");
  assert.equal(typeof seen[0].headers["X-Request-Id"], "string");
  assert.deepEqual(seen[0].body, {
    actor: "reviewer@test",
    source_stage: "approved_knowledge",
    account_id: "acct-1",
  });
  assert.match(result.content[0].text, /company_brain_apply/);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.action, "apply_company_brain_approved_knowledge");
});

test("lobster_security_run_action keeps approval_required as a non-throwing plugin result", async (t) => {
  const api = createPluginApi();
  register(api);
  const tool = getTool(api, "lobster_security_run_action");

  stubFetch(t, async () => new Response(JSON.stringify({
    ok: false,
    status: "approval_required",
    approval_request: {
      request_id: "req-1",
      reason: "high_risk_command",
    },
  }), {
    status: 409,
    headers: { "content-type": "application/json" },
  }));

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
