import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCloudOrganizationWhyReply,
  buildCloudOrganizationReviewReplyCached,
  CLOUD_DOC_ORGANIZATION_MODE,
  extractCloudOrganizationScopedSubject,
  looksLikeCloudOrganizationReReviewRequest,
  resolveCloudOrganizationAction,
  readSessionWorkflowMode,
  writeSessionWorkflowMode,
} from "../src/cloud-doc-organization-workflow.mjs";
import { upsertAccount, upsertDocument } from "../src/rag-repository.mjs";

function seedIndexedDocument({ accountId, suffix, title, rawText }) {
  upsertDocument({
    account_id: accountId,
    source_type: "docx",
    external_key: `test:${accountId}:${suffix}`,
    external_id: `ext:${suffix}`,
    file_token: `file_${suffix}`,
    document_id: `doc_${suffix}`,
    title,
    raw_text: rawText,
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
