import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const [
  { buildCloudDocWorkflowScopeKey },
  { decideIntent },
] = await Promise.all([
  import("../src/cloud-doc-organization-workflow.mjs"),
  import("../src/control-kernel.mjs"),
]);

test.after(() => {
  testDb.close();
});

test("same_session precedence keeps active doc rewrite on doc editor owner", () => {
  const decision = decideIntent({
    text: "請繼續改這份文件",
    lane: "personal-assistant",
    activeTask: {
      id: "task-doc-1",
      workflow: "doc_rewrite",
      status: "active",
    },
  });

  assert.equal(decision.decision, "continue_active_workflow");
  assert.equal(decision.matched_task_id, "task-doc-1");
  assert.equal(decision.precedence_source, "same_session_same_workflow");
  assert.equal(decision.final_owner, "doc-editor");
  assert.equal(decision.guard.same_session, true);
  assert.equal(decision.guard.same_workflow, true);
});

test("same_scope is required before active cloud doc workflow can keep ownership", () => {
  const decision = decideIntent({
    text: "好的，現在請告訴我還有什麼內容是需要我二次做確認的",
    lane: "personal-assistant",
    activeTask: {
      id: "task-cloud-1",
      workflow: "cloud_doc",
      status: "active",
      meta: {
        scope_key: buildCloudDocWorkflowScopeKey({ folderToken: "fld-origin" }),
      },
    },
    wantsCloudOrganizationFollowUp: false,
    cloudDocScopeKey: buildCloudDocWorkflowScopeKey({ folderToken: "fld-other" }),
  });

  assert.equal(decision.decision, "lane_default");
  assert.equal(decision.matched_task_id, null);
  assert.equal(decision.final_owner, "personal-assistant");
  assert.equal(decision.guard.same_scope_required, true);
  assert.equal(decision.guard.same_scope, false);
});

test("executive fallback only applies after non-executive workflow matches miss", () => {
  const decision = decideIntent({
    text: "幫我整理一下",
    lane: "personal-assistant",
    activeTask: {
      id: "task-cloud-2",
      workflow: "cloud_doc",
      status: "active",
      meta: {
        scope_key: buildCloudDocWorkflowScopeKey({ folderToken: "fld-origin" }),
      },
    },
    cloudDocScopeKey: buildCloudDocWorkflowScopeKey({ folderToken: "fld-other" }),
  });

  assert.equal(decision.decision, "lane_default");
  assert.equal(decision.precedence_source, "lane_default");
  assert.equal(decision.final_owner, "personal-assistant");
  assert.equal(decision.guard.executive_fallback_eligible, false);
  assert.equal(decision.guard.same_scope, false);
});
