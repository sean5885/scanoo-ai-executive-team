import test from "node:test";
import assert from "node:assert/strict";

import {
  dispatchPlannerTool,
  listPlannerSkillBridges,
} from "../src/executive-planner.mjs";
import { getSkillMetadata } from "../src/skill-registry.mjs";

function buildSearchSkillPayload() {
  return {
    q: "launch checklist",
    reader_overrides: {
      index: {
        search_knowledge_base: {
          success: true,
          data: {
            items: [
              {
                id: "doc_account_guard_search:0",
                snippet: "launch checklist owner timeline and review cadence",
                metadata: {
                  title: "Launch Runbook",
                  url: "https://example.com/doc_account_guard_search",
                },
              },
            ],
          },
          error: null,
        },
      },
    },
  };
}

function buildDocumentSkillPayload() {
  return {
    doc_id: "doc_account_guard_detail",
    reader_overrides: {
      mirror: {
        get_company_brain_doc_detail: {
          success: true,
          data: {
            doc: {
              doc_id: "doc_account_guard_detail",
              title: "Detail Doc",
              url: "https://example.com/doc_account_guard_detail",
              source: "mirror",
              created_at: "2026-03-20T00:00:00.000Z",
              creator: {
                account_id: "acct_writer",
                open_id: "ou_writer",
              },
            },
            summary: {
              overview: "Detail summary",
              headings: ["Section A"],
              highlights: ["Point A"],
              snippet: "Detail summary snippet",
              content_length: 42,
            },
            learning_state: {
              status: "learned",
              structured_summary: {
                overview: "",
                headings: [],
                highlights: [],
                snippet: "",
                content_length: 0,
              },
              key_concepts: [],
              tags: [],
              notes: "",
              learned_at: null,
              updated_at: null,
            },
          },
          error: null,
        },
      },
    },
  };
}

function buildSkillPayloadForAction(action = "") {
  if (action === "search_and_summarize") {
    return buildSearchSkillPayload();
  }
  if (action === "document_summarize") {
    return buildDocumentSkillPayload();
  }
  return {};
}

test("missing account_id blocks planner-visible skill dispatch before execution", async () => {
  const ctx = {};
  const result = await dispatchPlannerTool({
    action: "search_and_summarize",
    payload: buildSearchSkillPayload(),
    ctx,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_required_account_id");
  assert.equal(result.data?.reason, "missing_required_account_id");
  assert.equal(result.data?.safe_path, "non_execution");
  assert.equal(result.data?.account_id_guarantee?.blocked, true);
  assert.equal(result.data?.account_id_guarantee?.guaranteed, false);
  assert.equal(ctx.__account_id_guarantee?.reason, "missing_required_account_id");
  assert.equal(ctx.__account_id_guarantee?.blocked, true);
});

test("authContext account_id is backfilled before planner-visible skill dispatch", async () => {
  const ctx = {};
  const result = await dispatchPlannerTool({
    action: "search_and_summarize",
    payload: {
      query: "launch checklist",
      reader_overrides: buildSearchSkillPayload().reader_overrides,
    },
    authContext: { account_id: "acct_from_auth_context" },
    ctx,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "search_and_summarize");
  assert.equal(result.data?.skill, "search_and_summarize");
  assert.equal(ctx.__account_id_guarantee?.guaranteed, true);
  assert.equal(ctx.__account_id_guarantee?.source, "authContext.account_id");
  assert.equal(ctx.__account_id_guarantee?.account_id, "acct_from_auth_context");
});

test("account_id resolution order prefers payload before authContext and ctx", async () => {
  const ctx = {
    account_id: "acct_ctx",
    authContext: {
      account_id: "acct_ctx_auth",
    },
  };
  const result = await dispatchPlannerTool({
    action: "search_and_summarize",
    payload: {
      ...buildSearchSkillPayload(),
      account_id: "acct_payload",
    },
    authContext: { account_id: "acct_auth" },
    ctx,
  });

  assert.equal(result.ok, true);
  assert.equal(ctx.__account_id_guarantee?.source, "payload.account_id");
  assert.equal(ctx.__account_id_guarantee?.account_id, "acct_payload");
});

test("ctx and ctx.authContext account_id are used when payload and authContext are missing", async () => {
  const fromCtx = {
    account_id: "acct_ctx_only",
  };
  const ctxResult = await dispatchPlannerTool({
    action: "document_summarize",
    payload: buildDocumentSkillPayload(),
    ctx: fromCtx,
  });
  assert.equal(ctxResult.ok, true);
  assert.equal(fromCtx.__account_id_guarantee?.source, "ctx.account_id");
  assert.equal(fromCtx.__account_id_guarantee?.account_id, "acct_ctx_only");

  const fromNestedCtxAuth = {
    authContext: {
      account_id: "acct_ctx_auth_only",
    },
  };
  const ctxAuthResult = await dispatchPlannerTool({
    action: "document_summarize",
    payload: buildDocumentSkillPayload(),
    ctx: fromNestedCtxAuth,
  });
  assert.equal(ctxAuthResult.ok, true);
  assert.equal(fromNestedCtxAuth.__account_id_guarantee?.source, "ctx.authContext.account_id");
  assert.equal(fromNestedCtxAuth.__account_id_guarantee?.account_id, "acct_ctx_auth_only");
});

test("all planner-visible skills that require account_id fail closed without guaranteed account_id", async () => {
  const plannerVisibleRequiringAccount = listPlannerSkillBridges()
    .filter((entry) => entry?.surface_layer === "planner_visible")
    .filter((entry) => getSkillMetadata(entry.skill_name)?.auth_requirements?.account_id?.required === true);

  assert.equal(plannerVisibleRequiringAccount.length > 0, true);

  for (const entry of plannerVisibleRequiringAccount) {
    const result = await dispatchPlannerTool({
      action: entry.action,
      payload: buildSkillPayloadForAction(entry.action),
      ctx: {},
    });
    assert.equal(result.ok, false, `expected hard fail for ${entry.action}`);
    assert.equal(result.error, "missing_required_account_id", `expected missing_required_account_id for ${entry.action}`);
  }
});
