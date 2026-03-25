import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
import { setupExecutiveTaskStateTestHarness } from "./helpers/executive-task-state-harness.mjs";

const testDb = await createTestDbHarness();
const [
  { executeDocumentReviewWorkflow },
  { getActiveExecutiveTask },
] = await Promise.all([
  import("../src/executive-orchestrator.mjs"),
  import("../src/executive-task-state.mjs"),
]);

setupExecutiveTaskStateTestHarness();
test.after(() => {
  testDb.close();
});

test("document review workflow executes end-to-end with evidence-first triage output", async () => {
  const seed = `document-review-${Date.now()}`;
  const accountId = `acct-${seed}`;
  const scope = {
    session_key: `document-review:${seed}`,
    trace_id: `trace-${seed}`,
  };
  const event = {
    trace_id: scope.trace_id,
    message: {
      chat_id: `chat-${seed}`,
      message_id: `msg-${seed}`,
    },
  };

  const result = await executeDocumentReviewWorkflow({
    accountId,
    scope,
    event,
    requestText: "請 review onboarding 跟 SLA 文件，先 triage 哪些需要產品確認",
    documents: [
      {
        document_id: "doc-onboarding",
        title: "Product onboarding checklist",
        url: "https://example.com/onboarding",
        tags: ["onboarding", "product"],
        summary: "新客 onboarding 流程，且目前有幾個 rollout owner 需要產品確認。",
      },
      {
        document_id: "doc-sla",
        title: "SLA escalation policy",
        url: "https://example.com/sla",
        tags: ["sla", "support"],
        summary: "定義客訴分級、回應時限與 escalation 規則。",
      },
      {
        document_id: "doc-finance",
        title: "Finance reimbursement guide",
        tags: ["finance"],
        summary: "報銷流程與請款規則。",
      },
    ],
  });

  assert.equal(result?.verification?.pass, true);
  assert.equal(result?.task?.workflow_state, "completed");
  assert.equal(result?.task?.lifecycle_state, "completed");
  assert.equal(result?.structured_result?.workflow, "document_review");
  assert.equal(result?.structured_result?.document_count, 3);
  assert.equal(result?.structured_result?.review_status, "needs_confirmation");
  assert.deepEqual(
    result?.structured_result?.referenced_documents?.map((item) => item.title),
    ["SLA escalation policy", "Product onboarding checklist"],
  );
  assert.match(result?.structured_result?.conclusion || "", /直接相關文件/);
  assert.match(result?.structured_result?.conclusion || "", /需要人工確認/);
  assert.match(result?.reply_text || "", /^結論/m);
  assert.match(result?.reply_text || "", /^重點/m);
  assert.match(result?.reply_text || "", /^下一步/m);
  assert.match(result?.reply_text || "", /SLA escalation policy/);
  assert.match(result?.reply_text || "", /Product onboarding checklist/);
  assert.equal(await getActiveExecutiveTask(accountId, scope.session_key), null);
});
