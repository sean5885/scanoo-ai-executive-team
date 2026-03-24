import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCloudOrganizationWhyReply,
  buildCloudDocPendingActionScopeKey,
  buildCloudDocWorkflowScopeKey,
  buildCloudOrganizationReviewReplyCached,
  clearCloudOrganizationReviewCache,
  CLOUD_DOC_ORGANIZATION_MODE,
  extractCloudOrganizationScopedSubject,
  looksLikeCloudOrganizationReReviewRequest,
  resolveCloudOrganizationAction,
  readSessionWorkflowMode,
  writeSessionWorkflowMode,
} from "../src/cloud-doc-organization-workflow.mjs";
import {
  handlePlannerPendingItemAction,
  maybeRunPlannerTaskLifecycleFollowUp,
} from "../src/planner-task-lifecycle-v1.mjs";
import { upsertAccount, upsertDocument } from "../src/rag-repository.mjs";
import { setupPlannerTaskLifecycleTestHarness } from "./helpers/planner-task-lifecycle-harness.mjs";

setupPlannerTaskLifecycleTestHarness();

function seedIndexedDocument({ accountId, suffix, title, rawText, parentPath = "/", sourceType = "docx" }) {
  upsertDocument({
    account_id: accountId,
    source_type: sourceType,
    external_key: `test:${accountId}:${suffix}`,
    external_id: `ext:${suffix}`,
    file_token: `file_${suffix}`,
    document_id: `doc_${suffix}`,
    title,
    raw_text: rawText,
    parent_path: parentPath,
    active: 1,
  });
}

test("cloud doc workflow keeps second-confirmation follow-up in review branch", () => {
  const action = resolveCloudOrganizationAction({
    text: "好的，現在請告訴我還有什麼內容是需要我二次做確認的",
    activeWorkflowMode: CLOUD_DOC_ORGANIZATION_MODE,
  });

  assert.equal(action, "review");
});

test("cloud doc workflow routes explicit reassignment follow-up into rereview branch", () => {
  const action = resolveCloudOrganizationAction({
    text: "去學習吧 各個角色分別看完之後要告訴我哪些文檔跟你無關 我們再重新分配",
    activeWorkflowMode: CLOUD_DOC_ORGANIZATION_MODE,
  });

  assert.equal(action, "rereview");
});

test("cloud doc workflow routes scoped exclusion follow-up into rereview branch before mode stickiness", () => {
  const text = "把非 scanoo 的文檔摘出去";
  const action = resolveCloudOrganizationAction({
    text,
    activeWorkflowMode: null,
  });

  assert.equal(looksLikeCloudOrganizationReReviewRequest(text), true);
  assert.equal(action, "rereview");
});

test("cloud doc workflow exposes rereview signal helper", () => {
  assert.equal(looksLikeCloudOrganizationReReviewRequest("我們再重新分配"), true);
  assert.equal(looksLikeCloudOrganizationReReviewRequest("好的，還有什麼要我二次確認"), false);
});

test("cloud doc workflow keeps doc-intent exclusion family on rereview signals", () => {
  const rereviewQueries = [
    "把跟 scanoo 無關的文檔排除",
    "摘出無關文檔",
    "只保留 AI agent 主題的文檔，把非 AI agent 的文檔排出去",
    "只保留 onboarding 主題文件，把非 onboarding 的文件摘出去",
    "把不是產品需求範圍的文件移出去",
    "把 HR 之外的文檔剔出去",
    "把非交付集合的文件排出去",
    "重新審核哪些文件不屬於 scanoo 集合",
    "再審核哪些文檔不屬於產品文檔集合",
    "把非客服知識庫範圍的文件排除",
  ];

  for (const text of rereviewQueries) {
    assert.equal(looksLikeCloudOrganizationReReviewRequest(text), true, text);
    assert.equal(resolveCloudOrganizationAction({ text, activeWorkflowMode: null }), "rereview", text);
  }
});

test("cloud doc workflow extracts the scoped subject from the exact scanoo exclusion live query", () => {
  assert.equal(
    extractCloudOrganizationScopedSubject("你把我的雲端文件再看一遍，把不屬於scanoo的內容摘出去讓我確認"),
    "scanoo",
  );
});

test("cloud doc workflow keeps plain-language follow-up in review branch", () => {
  const action = resolveCloudOrganizationAction({
    text: "圖二我看不懂，請講人話",
    activeWorkflowMode: CLOUD_DOC_ORGANIZATION_MODE,
  });

  assert.equal(action, "review");
});

test("cloud doc workflow routes direct why-question into why branch", () => {
  const action = resolveCloudOrganizationAction({
    text: "這些待人工確認的文件，到底為什麼不能直接分配？",
    activeWorkflowMode: CLOUD_DOC_ORGANIZATION_MODE,
  });

  assert.equal(action, "why");
});

test("cloud doc workflow persists mode by session key", () => {
  const account = upsertAccount({
    open_id: `acct-mode-open-${Date.now()}`,
    name: "acct-mode",
  });
  const sessionKey = `chat-${Date.now()}`;

  writeSessionWorkflowMode(account.id, sessionKey, CLOUD_DOC_ORGANIZATION_MODE);
  assert.equal(readSessionWorkflowMode(account.id, sessionKey), CLOUD_DOC_ORGANIZATION_MODE);
  writeSessionWorkflowMode(account.id, sessionKey, null);
  assert.equal(readSessionWorkflowMode(account.id, sessionKey), null);
});

test("why reply explains pending confirmation docs in plain language", async () => {
  const account = upsertAccount({
    open_id: `acct-why-open-${Date.now()}`,
    name: "acct-why",
  });
  seedIndexedDocument({
    accountId: account.id,
    suffix: "administrator-manual",
    title: "Administrator Manual",
    rawText: "",
  });
  seedIndexedDocument({
    accountId: account.id,
    suffix: "member-manual",
    title: "Member Manual",
    rawText: "workspace member onboarding",
  });

  const reply = await buildCloudOrganizationWhyReply({ accountId: account.id });

  assert.match(reply.text, /不是完全不能分配/);
  assert.match(reply.text, /Administrator Manual|Member Manual/);
  assert.doesNotMatch(reply.text, /local_rule_fallback|local_default|信心/);
});

test("review reply renders concrete pending files with status reason and locator fields", async () => {
  const account = upsertAccount({
    open_id: `acct-review-locators-open-${Date.now()}`,
    name: "acct-review-locators",
  });
  seedIndexedDocument({
    accountId: account.id,
    suffix: "administrator-manual",
    title: "Administrator Manual",
    rawText: "manual",
    parentPath: "/shared/manuals",
  });
  seedIndexedDocument({
    accountId: account.id,
    suffix: "member-workspace-guide",
    title: "Member Workspace Guide",
    rawText: "workspace guide",
    parentPath: "/shared/onboarding",
    sourceType: "wiki",
  });

  const reply = await buildCloudOrganizationReviewReplyCached({
    accountId: account.id,
    sessionKey: `session-locators-${Date.now()}`,
    forceReReview: false,
  });

  assert.match(reply.text, /待人工確認：2 份/);
  assert.match(reply.text, /文件：Administrator Manual｜狀態：待人工確認/);
  assert.match(reply.text, /文件：Member Workspace Guide｜狀態：待人工確認/);
  assert.match(reply.text, /原因：/);
  assert.match(reply.text, /路徑：\/shared\/manuals/);
  assert.match(reply.text, /路徑：\/shared\/onboarding/);
  assert.match(reply.text, /document_id：doc_administrator-manual/);
  assert.match(reply.text, /file_token：file_member-workspace-guide/);
  assert.match(reply.text, /來源：wiki/);
  assert.match(reply.text, /操作：標記完成/);
  assert.equal(Array.isArray(reply.pending_items), true);
  assert.equal(reply.pending_items[0]?.actions?.[0]?.type, "mark_resolved");
  assert.equal(reply.pending_items[0]?.actions?.[0]?.metadata?.action, "mark_resolved");
  assert.match(reply.pending_items[0]?.actions?.[0]?.metadata?.document_id || "", /^doc_/);
  assert.match(reply.pending_items[0]?.actions?.[0]?.metadata?.file_token || "", /^file_/);
});

test("generic review reply uses local fast summary instead of semantic rereview wording", async () => {
  const account = upsertAccount({
    open_id: `acct-review-open-${Date.now()}`,
    name: "acct-review",
  });
  seedIndexedDocument({
    accountId: account.id,
    suffix: "admin-manual",
    title: "Administrator Manual",
    rawText: "",
  });
  seedIndexedDocument({
    accountId: account.id,
    suffix: "workspace-guide",
    title: "Create workspace",
    rawText: "workspace onboarding guide",
  });

  const reply = await buildCloudOrganizationReviewReplyCached({
    accountId: account.id,
    sessionKey: `session-${Date.now()}`,
    forceReReview: false,
  });

  assert.match(reply.text, /先用目前已索引的/);
  assert.doesNotMatch(reply.text, /MiniMax 小批量語義複審/);
});

test("cloud doc pending item follow-up resolves one file via mark_resolved", async () => {
  const account = upsertAccount({
    open_id: `acct-review-action-open-${Date.now()}`,
    name: "acct-review-action",
  });
  const sessionKey = `session-review-action-${Date.now()}`;
  seedIndexedDocument({
    accountId: account.id,
    suffix: "planner-intent-demo",
    title: "Planner Intent Demo",
    rawText: "manual",
    parentPath: "/06_知識庫歸檔",
  });
  seedIndexedDocument({
    accountId: account.id,
    suffix: "planner-full-demo",
    title: "Planner Full Demo",
    rawText: "workspace guide",
    parentPath: "/06_知識庫歸檔",
  });

  const initialReply = await buildCloudOrganizationReviewReplyCached({
    accountId: account.id,
    sessionKey,
    forceReReview: false,
  });
  assert.match(initialReply.text, /操作：標記完成/);
  assert.equal(initialReply.pending_items.length, 2);

  const pendingScopeKey = buildCloudDocPendingActionScopeKey(buildCloudDocWorkflowScopeKey({ sessionKey }));
  const followUp = await maybeRunPlannerTaskLifecycleFollowUp({
    userIntent: "第一個標記完成",
    scopeKey: pendingScopeKey,
    logger: {
      debug() {},
    },
  });

  assert.equal(followUp?.selected_action, "mark_resolved");
  assert.equal(followUp?.pending_item_action?.item_id != null, true);

  const actionResult = await handlePlannerPendingItemAction({
    itemId: followUp.pending_item_action.item_id,
    action: "mark_resolved",
    actor: "cloud_doc_pending_item_action_test",
  });
  assert.equal(actionResult.ok, true);
  assert.equal(actionResult.action, "mark_resolved");

  clearCloudOrganizationReviewCache(account.id, sessionKey);
  const refreshedReply = await buildCloudOrganizationReviewReplyCached({
    accountId: account.id,
    sessionKey,
    forceReReview: false,
  });

  assert.equal(refreshedReply.pending_items.length, 1);
  assert.match(refreshedReply.text, /待人工確認：1 份/);
  assert.doesNotMatch(refreshedReply.text, /Planner Intent Demo[\s\S]*操作：標記完成/);
  assert.match(refreshedReply.text, /Planner Full Demo/);
});
