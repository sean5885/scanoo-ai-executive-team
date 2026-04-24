import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { db } = testDb;

const [
  { getHttpIdempotencyRecord },
  { startHttpServer },
  { docUpdateConfirmationStorePath, executiveImprovementStorePath },
  { setupExecutiveTaskStateTestHarness },
  { EXPLICIT_USER_AUTH_HEADERS },
  { extractDocumentId },
  { replaceDocumentChunks, saveToken, upsertDocument },
  { ensureDocRewriteWorkflowTask },
  { clearActiveExecutiveTask },
  { createCommentRewriteConfirmation },
] = await Promise.all([
  import("../src/http-idempotency-store.mjs"),
  import("../src/http-server.mjs"),
  import("../src/config.mjs"),
  import("./helpers/executive-task-state-harness.mjs"),
  import("../src/explicit-user-auth.mjs"),
  import("../src/message-intent-utils.mjs"),
  import("../src/rag-repository.mjs"),
  import("../src/executive-orchestrator.mjs"),
  import("../src/executive-task-state.mjs"),
  import("../src/doc-update-confirmations.mjs"),
]);

setupExecutiveTaskStateTestHarness();

test.after(() => {
  testDb.close();
});

function createLoggerSink() {
  const calls = [];
  return {
    calls,
    logger: {
      log() {},
      info(...args) {
        calls.push(args);
      },
      warn(...args) {
        calls.push(args);
      },
      error(...args) {
        calls.push(args);
      },
    },
  };
}

function createAuthorizedOverrides(overrides = {}) {
  const normalizedOverrides = { ...overrides };
  if (typeof overrides.readDocumentFromRuntime !== "function" && typeof overrides.getDocument === "function") {
    normalizedOverrides.readDocumentFromRuntime = async ({ accessToken, documentId }) => (
      overrides.getDocument(accessToken, documentId)
    );
  }
  if (
    typeof overrides.listDocumentCommentsFromRuntime !== "function"
    && typeof overrides.listDocumentComments === "function"
  ) {
    normalizedOverrides.listDocumentCommentsFromRuntime = async ({
      accessToken,
      documentId,
      includeSolved,
    }) => (
      overrides.listDocumentComments(accessToken, documentId, {
        fileType: "docx",
        isSolved: includeSolved ? undefined : false,
      })
    );
  }
  return {
    getValidUserTokenState: async () => ({
      status: "valid",
      token: { access_token: "token-1", account_id: "acct-1" },
      account: { id: "acct-1" },
      refreshed: false,
      error: null,
    }),
    getStoredAccountContext: async () => ({ account: { id: "acct-1" } }),
    ...normalizedOverrides,
  };
}

function ensureTestAccount(accountId = "acct-1") {
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO lark_accounts (
      id, open_id, user_id, union_id, tenant_key, name, email, scope, created_at, updated_at
    ) VALUES (
      @id, @open_id, NULL, NULL, NULL, @name, NULL, @scope, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at
  `).run({
    id: accountId,
    open_id: `ou_test_${accountId}`,
    name: "HTTP Route Test",
    scope: "test",
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function createExplicitPlannerAuthHeaders({
  accountId = "acct-1",
  accessToken = "event-token-1",
} = {}) {
  return {
    [EXPLICIT_USER_AUTH_HEADERS.accountId]: accountId,
    [EXPLICIT_USER_AUTH_HEADERS.userAccessToken]: accessToken,
    [EXPLICIT_USER_AUTH_HEADERS.source]: "test_event_user_access_token",
    [EXPLICIT_USER_AUTH_HEADERS.required]: "true",
  };
}

function insertCompanyBrainFixture({
  accountId = "acct-1",
  docId,
  title,
  rawText,
  source = "api",
}) {
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO lark_documents (
      id, account_id, source_id, source_type, external_key, external_id, file_token, node_id,
      document_id, space_id, title, url, parent_path, revision, updated_at_remote, content_hash,
      raw_text, inactive_reason, acl_json, meta_json, active, status, indexed_at, verified_at,
      failure_reason, synced_at, created_at, updated_at
    ) VALUES (
      @id, @account_id, NULL, 'docx', @external_key, NULL, NULL, NULL,
      @document_id, NULL, @title, @url, '/', NULL, NULL, NULL,
      @raw_text, NULL, NULL, NULL, 1, 'verified', NULL, NULL,
      NULL, @synced_at, @created_at, @updated_at
    )
    ON CONFLICT(account_id, external_key) DO UPDATE SET
      document_id = excluded.document_id,
      title = excluded.title,
      url = excluded.url,
      raw_text = excluded.raw_text,
      active = excluded.active,
      status = excluded.status,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at
  `).run({
    id: `route_ldoc_${docId}`,
    account_id: accountId,
    external_key: `route_ext_${docId}`,
    document_id: docId,
    title,
    url: `https://larksuite.com/docx/${docId}`,
    raw_text: rawText,
    synced_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  });

  db.prepare(`
    INSERT INTO company_brain_docs (
      account_id, doc_id, title, source, created_at, creator_json, updated_at
    ) VALUES (
      @account_id, @doc_id, @title, @source, @created_at, @creator_json, @updated_at
    )
    ON CONFLICT(account_id, doc_id) DO UPDATE SET
      title = excluded.title,
      source = excluded.source,
      created_at = excluded.created_at,
      creator_json = excluded.creator_json,
      updated_at = excluded.updated_at
  `).run({
    account_id: accountId,
    doc_id: docId,
    title,
    source,
    created_at: timestamp,
    creator_json: JSON.stringify({
      account_id: accountId,
      open_id: `ou_test_${accountId}`,
    }),
    updated_at: timestamp,
  });
}

function insertIndexedSearchFixture({
  accountId = "acct-1",
  docId,
  title,
  rawText,
}) {
  saveToken(accountId, {
    access_token: `token_${docId}`,
    refresh_token: `refresh_${docId}`,
    token_type: "Bearer",
    scope: "docs:read",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 120_000).toISOString(),
  });

  const document = upsertDocument({
    account_id: accountId,
    source_type: "docx",
    external_key: `route_index_ext_${docId}`,
    external_id: docId,
    document_id: docId,
    title,
    url: `https://larksuite.com/docx/${docId}`,
    parent_path: "/",
    raw_text: rawText,
    active: 1,
    status: "verified",
  });

  replaceDocumentChunks(document, [
    {
      chunk_index: 0,
      content: rawText,
      content_norm: rawText,
      char_count: rawText.length,
      chunk_hash: `route_index_chunk_${docId}`,
    },
  ]);
}

async function startTestServer(t, serviceOverrides, options = {}) {
  ensureTestAccount("acct-1");
  const sink = createLoggerSink();
  const server = startHttpServer({
    listen: false,
    logger: sink.logger,
    serviceOverrides: createAuthorizedOverrides(serviceOverrides),
    ...(Number.isFinite(Number(options?.requestTimeoutMs))
      ? { requestTimeoutMs: Number(options.requestTimeoutMs) }
      : {}),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return { server, calls: sink.calls };
}

async function postPluginDispatch(port, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/agent/lark-plugin/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  return {
    response,
    body,
  };
}

async function snapshotFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function restoreFile(filePath, content) {
  if (content == null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.writeFile(filePath, content, "utf8");
}

function stripTrace(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const { trace_id: _traceId, ...rest } = payload;
  return rest;
}

async function previewThenConfirmDocumentCreate({
  port,
  body,
  assertReplayFailure = true,
}) {
  const previewResponse = await fetch(`http://127.0.0.1:${port}/api/doc/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const previewPayload = await previewResponse.json();

  assert.equal(previewResponse.status, 200);
  assert.equal(previewPayload.ok, true);
  assert.equal(previewPayload.action, "document_create_preview");
  assert.equal(previewPayload.preview_required, true);
  assert.match(previewPayload.confirmation_id || "", /.+/);

  const applyResponse = await fetch(`http://127.0.0.1:${port}/api/doc/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...body,
      confirm: true,
      confirmation_id: previewPayload.confirmation_id,
    }),
  });
  const applyPayload = await applyResponse.json();

  let replayResponse = null;
  let replayPayload = null;
  if (assertReplayFailure) {
    replayResponse = await fetch(`http://127.0.0.1:${port}/api/doc/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...body,
        confirm: true,
        confirmation_id: previewPayload.confirmation_id,
      }),
    });
    replayPayload = await replayResponse.json();
    assert.equal(replayResponse.status, 400);
    assert.equal(replayPayload.ok, false);
    assert.equal(replayPayload.error, "invalid_or_expired_confirmation");
  }

  return {
    previewResponse,
    previewPayload,
    applyResponse,
    applyPayload,
    replayResponse,
    replayPayload,
  };
}

function withEnv(t, values = {}) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  t.after(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test("drive organize preview success route returns trace and handler step logs", async (t) => {
  const { server, calls } = await startTestServer(t, {
    resolveDriveRootFolderToken: async () => "fld-root",
    previewDriveOrganization: async () => ({ task_id: "drive-task-1", items: [{ file_token: "doc-1" }] }),
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/drive/organize/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recursive: true }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(payload.workflow_state, "awaiting_review");
  assert.equal(payload.verification, null);
  assert.equal(calls.some((entry) => entry[1]?.event === "drive_organize_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "drive_organize_completed"), true);
});

test("wiki organize preview success route returns trace and handler step logs", async (t) => {
  const { server, calls } = await startTestServer(t, {
    previewWikiOrganization: async () => ({ items: [{ node_token: "wiki-1" }] }),
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/wiki/organize/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ space_id: "space-1" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(payload.workflow_state, "awaiting_review");
  assert.equal(payload.verification, null);
  assert.equal(calls.some((entry) => entry[1]?.event === "wiki_organize_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "wiki_organize_completed"), true);
});

test("drive organize apply success route returns trace and handler step logs", async (t) => {
  const { server, calls } = await startTestServer(t, {
    resolveDriveRootFolderToken: async () => "fld-root",
    previewDriveOrganization: async () => ({ task_id: "drive-task-preview-1", items: [{ file_token: "doc-1" }] }),
    applyDriveOrganization: async () => ({ task_id: "drive-task-apply-1", moved: 3 }),
  });

  const { port } = server.address();
  const previewResponse = await fetch(`http://127.0.0.1:${port}/api/drive/organize/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recursive: true }),
  });
  assert.equal(previewResponse.status, 200);
  const response = await fetch(`http://127.0.0.1:${port}/api/drive/organize/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recursive: true }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(payload.workflow_state, "completed");
  assert.equal(payload.verification?.pass, true);
  assert.equal(calls.some((entry) => entry[1]?.event === "drive_organize_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "drive_organize_completed"), true);
});

test("wiki organize apply success route returns trace and handler step logs", async (t) => {
  const { server, calls } = await startTestServer(t, {
    previewWikiOrganization: async () => ({ items: [{ node_token: "wiki-1" }] }),
    applyWikiOrganization: async () => ({ moved: [{ node_token: "wiki-1" }] }),
  });

  const { port } = server.address();
  const previewResponse = await fetch(`http://127.0.0.1:${port}/api/wiki/organize/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ space_id: "space-1" }),
  });
  assert.equal(previewResponse.status, 200);
  const response = await fetch(`http://127.0.0.1:${port}/api/wiki/organize/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ space_id: "space-1" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(payload.workflow_state, "completed");
  assert.equal(payload.verification?.pass, true);
  assert.equal(calls.some((entry) => entry[1]?.event === "wiki_organize_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "wiki_organize_completed"), true);
});

test("document read and comments routes accept document_url query input", async (t) => {
  const documentId = "doccn-route-url-1";
  const seen = {
    read: null,
    comments: null,
  };
  const { server } = await startTestServer(t, {
    getDocument: async (_accessToken, incomingDocumentId) => {
      seen.read = incomingDocumentId;
      return {
        document_id: incomingDocumentId,
        title: "Route URL Doc",
        content: "# Route URL Doc",
        revision_id: "rev-route-1",
      };
    },
    listDocumentComments: async (_accessToken, incomingDocumentId) => {
      seen.comments = incomingDocumentId;
      return {
        document_id: incomingDocumentId,
        items: [],
        has_more: false,
        page_token: null,
      };
    },
  });

  const { port } = server.address();
  const encodedUrl = encodeURIComponent(`https://larksuite.com/docx/${documentId}`);
  const readResponse = await fetch(`http://127.0.0.1:${port}/api/doc/read?document_url=${encodedUrl}`);
  const readPayload = await readResponse.json();
  assert.equal(readResponse.status, 200);
  assert.equal(readPayload.document_id, documentId);
  assert.equal(seen.read, documentId);

  const commentsResponse = await fetch(`http://127.0.0.1:${port}/api/doc/comments?document_url=${encodedUrl}`);
  const commentsPayload = await commentsResponse.json();
  assert.equal(commentsResponse.status, 200);
  assert.equal(commentsPayload.document_id, documentId);
  assert.equal(seen.comments, documentId);
});

test("document update replace preview accepts document_url body input", async (t) => {
  const documentId = "doccn-update-url-1";
  let seenDocumentId = null;
  const { server } = await startTestServer(t, {
    getDocument: async (_accessToken, incomingDocumentId) => {
      seenDocumentId = incomingDocumentId;
      return {
        document_id: incomingDocumentId,
        title: "Editable Doc",
        content: "# Existing",
        revision_id: "rev-update-1",
      };
    },
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/doc/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document_url: `https://larksuite.com/docx/${documentId}`,
      content: "# Updated",
      mode: "replace",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.preview?.document_id, documentId);
  assert.equal(seenDocumentId, documentId);
});

test("document rewrite preview accepts nested target document links", async (t) => {
  const documentId = "doccn-rewrite-url-1";
  const seen = {
    read: null,
    rewrite: null,
  };
  const { server } = await startTestServer(t, {
    getDocument: async (_accessToken, incomingDocumentId) => {
      seen.read = incomingDocumentId;
      return {
        document_id: incomingDocumentId,
        title: "Rewrite Target",
        content: "# Current",
        revision_id: "rev-rewrite-1",
      };
    },
    rewriteDocumentFromComments: async (_accessToken, incomingDocumentId) => {
      seen.rewrite = incomingDocumentId;
      return {
        document_id: incomingDocumentId,
        title: "Rewrite Target",
        comment_count: 0,
        comment_ids: [],
        comments: [],
        change_summary: [],
        patch_plan: [],
        revised_content: "# Current",
      };
    },
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/doc/rewrite-from-comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target_document: {
        url: `https://larksuite.com/docx/${documentId}`,
      },
      apply: false,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.document_id, documentId);
  assert.equal(seen.read, documentId);
  assert.equal(seen.rewrite, documentId);
});

test("document rewrite apply succeeds only with the matching awaiting_review confirmation", async (t) => {
  const snapshot = await snapshotFile(docUpdateConfirmationStorePath);
  const documentId = `doc-rewrite-apply-${Date.now()}`;
  const accountId = "acct-1";
  const scope = {
    session_key: `doc-rewrite:${documentId}`,
    trace_id: "trace-doc-rewrite-1",
  };
  t.after(async () => {
    await restoreFile(docUpdateConfirmationStorePath, snapshot);
    await clearActiveExecutiveTask(accountId, scope.session_key);
  });

  const confirmation = await createCommentRewriteConfirmation({
    accountId,
    documentId,
    title: "Rewrite Target",
    currentRevisionId: "rev-apply-1",
    currentContent: "# 背景\n\n舊內容",
    rewrittenContent: "# 背景\n\n新內容",
    patchPlan: [
      {
        patch_type: "replace",
        start_index: 0,
        end_index: 1,
        before: ["# 背景\n\n舊內容"],
        after: ["# 背景\n\n新內容"],
      },
    ],
    changeSummary: ["補上最新限制"],
    commentIds: ["comment-1"],
    comments: [{ comment_id: "comment-1", latest_reply_text: "請更新" }],
    resolveComments: false,
  });
  await ensureDocRewriteWorkflowTask({
    accountId,
    documentId,
    documentTitle: "Rewrite Target",
    scope,
    workflowState: "awaiting_review",
    routingHint: "doc_rewrite_review_pending",
    meta: {
      confirmation_id: confirmation.confirmation_id,
    },
  });

  const updates = [];
  const { server } = await startTestServer(t, {
    getDocument: async () => ({
      document_id: documentId,
      title: "Rewrite Target",
      content: "# 背景\n\n舊內容",
      revision_id: "rev-apply-1",
    }),
    updateDocument: async (_accessToken, incomingDocumentId, content, mode) => {
      updates.push({ documentId: incomingDocumentId, content, mode });
      return {
        document_id: incomingDocumentId,
        revision_id: "rev-apply-2",
        mode,
      };
    },
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/doc/rewrite-from-comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document_id: documentId,
      apply: true,
      confirm: true,
      confirmation_id: confirmation.confirmation_id,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.action, "document_rewrite_from_comments_apply");
  assert.equal(payload.workflow_state, "completed");
  assert.equal(payload.verification?.pass, true);
  assert.equal(updates.length, 1);
  assert.equal(payload.resolve_comments, false);
});

test("document rewrite apply fails closed when confirmation no longer matches awaiting_review task", async (t) => {
  const snapshot = await snapshotFile(docUpdateConfirmationStorePath);
  const documentId = `doc-rewrite-stale-${Date.now()}`;
  const accountId = "acct-1";
  const scope = {
    session_key: `doc-rewrite:${documentId}`,
    trace_id: "trace-doc-rewrite-2",
  };
  t.after(async () => {
    await restoreFile(docUpdateConfirmationStorePath, snapshot);
    await clearActiveExecutiveTask(accountId, scope.session_key);
  });

  const staleConfirmation = await createCommentRewriteConfirmation({
    accountId,
    documentId,
    title: "Rewrite Target",
    currentRevisionId: "rev-stale-1",
    currentContent: "# 背景\n\n舊內容",
    rewrittenContent: "# 背景\n\n舊內容 A",
    patchPlan: [{ patch_type: "replace", start_index: 0, end_index: 1, before: ["舊內容"], after: ["舊內容 A"] }],
    changeSummary: ["第一版"],
    commentIds: ["comment-1"],
    comments: [{ comment_id: "comment-1", latest_reply_text: "請更新 A" }],
  });
  const currentConfirmation = await createCommentRewriteConfirmation({
    accountId,
    documentId,
    title: "Rewrite Target",
    currentRevisionId: "rev-stale-1",
    currentContent: "# 背景\n\n舊內容",
    rewrittenContent: "# 背景\n\n舊內容 B",
    patchPlan: [{ patch_type: "replace", start_index: 0, end_index: 1, before: ["舊內容"], after: ["舊內容 B"] }],
    changeSummary: ["第二版"],
    commentIds: ["comment-2"],
    comments: [{ comment_id: "comment-2", latest_reply_text: "請更新 B" }],
  });
  await ensureDocRewriteWorkflowTask({
    accountId,
    documentId,
    documentTitle: "Rewrite Target",
    scope,
    workflowState: "awaiting_review",
    routingHint: "doc_rewrite_review_pending",
    meta: {
      confirmation_id: currentConfirmation.confirmation_id,
    },
  });

  const updates = [];
  const { server } = await startTestServer(t, {
    getDocument: async () => ({
      document_id: documentId,
      title: "Rewrite Target",
      content: "# 背景\n\n舊內容",
      revision_id: "rev-stale-1",
    }),
    updateDocument: async (_accessToken, incomingDocumentId, content, mode) => {
      updates.push({ documentId: incomingDocumentId, content, mode });
      return {
        document_id: incomingDocumentId,
        revision_id: "rev-stale-2",
        mode,
      };
    },
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/doc/rewrite-from-comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document_id: documentId,
      apply: true,
      confirm: true,
      confirmation_id: staleConfirmation.confirmation_id,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "write_guard_denied");
  assert.equal(payload.write_guard?.reason, "verifier_incomplete");
  assert.equal(updates.length, 0);
});

test("document create preview/confirm classifies verified mirror ingest as direct intake", async (t) => {
  withEnv(t, {
    ALLOW_LARK_WRITES: "true",
  });
  const documentId = `doc-create-direct-${Date.now()}`;
  const title = `Ops Runbook Direct ${Date.now()}`;
  const { server, calls } = await startTestServer(t, {
    createDocument: async () => ({
      document_id: documentId,
      revision_id: "rev-create-direct-1",
      title,
      url: `https://larksuite.com/docx/${documentId}`,
    }),
  });

  const { port } = server.address();
  const {
    previewPayload,
    applyResponse,
    applyPayload,
  } = await previewThenConfirmDocumentCreate({
    port,
    body: { title },
  });
  assert.equal(previewPayload.create_preview.title, title);
  assert.equal(applyResponse.status, 200);
  assert.equal(applyPayload.document_id, documentId);

  const boundaryLog = calls.find((entry) => entry[1]?.event === "document_company_brain_intake_classified");
  assert.equal(boundaryLog?.[1]?.doc_id, documentId);
  assert.equal(boundaryLog?.[1]?.direct_intake_allowed, true);
  assert.equal(boundaryLog?.[1]?.review_required, false);
  assert.equal(boundaryLog?.[1]?.conflict_check_required, false);

  const ingestedLog = calls.find((entry) => entry[1]?.event === "document_company_brain_ingested");
  assert.equal(ingestedLog?.[1]?.doc_id, documentId);
  assert.equal(ingestedLog?.[1]?.source, "api");
});

test("document create preview/confirm classifies title overlap as review and conflict check required", async (t) => {
  withEnv(t, {
    ALLOW_LARK_WRITES: "true",
  });
  const base = Date.now();
  const title = `Ops Runbook Overlap ${base}`;
  let counter = 0;
  const { server, calls } = await startTestServer(t, {
    createDocument: async () => {
      counter += 1;
      const documentId = `doc-create-overlap-${base}-${counter}`;
      return {
        document_id: documentId,
        revision_id: `rev-create-overlap-${counter}`,
        title,
        url: `https://larksuite.com/docx/${documentId}`,
      };
    },
  });

  const { port } = server.address();
  for (let index = 0; index < 2; index += 1) {
    const { applyResponse } = await previewThenConfirmDocumentCreate({
      port,
      body: { title },
    });
    assert.equal(applyResponse.status, 200);
  }

  const overlapBoundaryLog = calls
    .filter((entry) => entry[1]?.event === "document_company_brain_intake_classified")
    .at(-1);
  assert.equal(overlapBoundaryLog?.[1]?.review_required, true);
  assert.equal(overlapBoundaryLog?.[1]?.conflict_check_required, true);
  assert.equal(overlapBoundaryLog?.[1]?.matched_docs?.length, 1);
  assert.equal(overlapBoundaryLog?.[1]?.matched_docs?.[0]?.match_type, "same_title");
});

test("document create is fail-closed when ALLOW_LARK_WRITES is not enabled", async (t) => {
  withEnv(t, {
    ALLOW_LARK_WRITES: null,
    LARK_WRITE_SANDBOX_FOLDER_TOKEN: null,
  });
  const { server } = await startTestServer(t, {
    createDocument: async () => {
      throw new Error("should_not_create");
    },
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/doc/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Blocked Live Create", confirm: true }),
  });
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "internal_error");
  assert.equal(payload.message, "Lark write blocked (ALLOW_LARK_WRITES not enabled)");
});

test("document create returns preview and confirmation_id before any live write", async (t) => {
  withEnv(t, {
    ALLOW_LARK_WRITES: "true",
  });
  const { server } = await startTestServer(t, {
    createDocument: async () => {
      throw new Error("should_not_create");
    },
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/doc/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Missing Confirmation" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "document_create_preview");
  assert.equal(payload.preview_required, true);
  assert.match(payload.confirmation_id || "", /.+/);
});

test("document create preview/confirm redirects demo-like titles into sandbox folder", async (t) => {
  withEnv(t, {
    ALLOW_LARK_WRITES: "true",
    LARK_WRITE_SANDBOX_FOLDER_TOKEN: "sandbox-folder-token",
  });
  const seen = [];
  const { server } = await startTestServer(t, {
    createDocument: async (_accessToken, title, folderToken) => {
      seen.push({ title, folderToken });
      return {
        document_id: "doc-sandbox-demo",
        revision_id: "rev-sandbox-demo",
        title,
        folder_token: folderToken,
        url: "https://larksuite.com/docx/doc-sandbox-demo",
      };
    },
  });

  const { port } = server.address();
  const {
    previewPayload,
    applyResponse,
    applyPayload,
  } = await previewThenConfirmDocumentCreate({
    port,
    body: {
      title: "Planner E2E Success Verify",
      folder_token: "prod-knowledge-folder",
    },
  });

  assert.equal(previewPayload.create_preview.requested_folder_token, "prod-knowledge-folder");
  assert.equal(previewPayload.create_preview.resolved_folder_token, "sandbox-folder-token");
  assert.equal(applyResponse.status, 200);
  assert.equal(applyPayload.ok, true);
  assert.deepEqual(seen, [{
    title: "Planner E2E Success Verify",
    folderToken: "sandbox-folder-token",
  }]);
});

test("document create preview/confirm rolls back created doc when initial content write fails after create", async (t) => {
  withEnv(t, {
    ALLOW_LARK_WRITES: "true",
  });
  const documentId = `doc-create-content-write-fail-${Date.now()}`;
  t.after(() => {
    db.prepare("DELETE FROM company_brain_docs WHERE account_id = ? AND doc_id = ?").run("acct-1", documentId);
    db.prepare("DELETE FROM lark_documents WHERE account_id = ? AND document_id = ?").run("acct-1", documentId);
    db.prepare("DELETE FROM lark_sources WHERE account_id = ? AND external_id = ?").run("acct-1", documentId);
  });
  let updateCalls = 0;
  const deletedDocumentIds = [];
  const { server, calls } = await startTestServer(t, {
    createDocument: async () => ({
      document_id: documentId,
      revision_id: "rev-create-content-write-fail-1",
      title: "Post-create write fail-soft",
      url: `https://larksuite.com/docx/${documentId}`,
    }),
    updateDocument: async () => {
      updateCalls += 1;
      const error = new Error("Failed to write Lark document content");
      error.response = {
        status: 400,
        data: {
          code: 99991663,
          msg: "invalid block parent",
          log_id: "log-post-create-write-400",
        },
      };
      throw error;
    },
    deleteDocument: async (_accessToken, incomingDocumentId) => {
      deletedDocumentIds.push(incomingDocumentId);
      return {
        document_id: incomingDocumentId,
        deleted: true,
      };
    },
  });

  const { port } = server.address();
  const {
    previewPayload,
    applyResponse: response,
    applyPayload: payload,
  } = await previewThenConfirmDocumentCreate({
    port,
    body: {
      title: "Post-create write fail-soft",
      content: "# Draft\n\nInitial content",
    },
  });

  assert.equal(previewPayload.create_preview.has_initial_content, true);
  assert.equal(response.status, 500);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "execution_failed");
  assert.equal(updateCalls, 1);
  assert.deepEqual(deletedDocumentIds, [documentId]);

  const lifecycleRow = db.prepare(
    "SELECT raw_text, status, failure_reason FROM lark_documents WHERE account_id = ? AND document_id = ?",
  ).get("acct-1", documentId);
  const sourceRow = db.prepare(
    "SELECT id FROM lark_sources WHERE account_id = ? AND external_id = ?",
  ).get("acct-1", documentId);
  const companyBrainRow = db.prepare(
    "SELECT doc_id FROM company_brain_docs WHERE account_id = ? AND doc_id = ?",
  ).get("acct-1", documentId);
  assert.equal(lifecycleRow, undefined);
  assert.equal(sourceRow, undefined);
  assert.equal(companyBrainRow, undefined);

  const writeFailureLog = calls.find((entry) => entry[1]?.event === "document_create_initial_content_write_failed");
  assert.equal(writeFailureLog?.[1]?.document_id, documentId);
  assert.equal(writeFailureLog?.[1]?.http_status, 400);
});

test("document create rolls back after permission grant succeeds but initial content write fails", async (t) => {
  withEnv(t, {
    ALLOW_LARK_WRITES: "true",
  });
  const documentId = `doc-create-permission-then-update-fail-${Date.now()}`;
  t.after(() => {
    db.prepare("DELETE FROM company_brain_docs WHERE account_id = ? AND doc_id = ?").run("acct-1", documentId);
    db.prepare("DELETE FROM lark_documents WHERE account_id = ? AND document_id = ?").run("acct-1", documentId);
    db.prepare("DELETE FROM lark_sources WHERE account_id = ? AND external_id = ?").run("acct-1", documentId);
  });

  let permissionCalls = 0;
  const deletedDocumentIds = [];
  const { server } = await startTestServer(t, {
    getValidUserTokenState: async () => ({
      status: "valid",
      token: { access_token: "token-1", account_id: "acct-1" },
      account: { id: "acct-1", open_id: "ou_test_acct-1" },
      refreshed: false,
      error: null,
    }),
    getStoredAccountContext: async () => ({
      account: { id: "acct-1", open_id: "ou_test_acct-1" },
    }),
    createDocument: async () => ({
      document_id: documentId,
      revision_id: "rev-create-permission-then-update-fail-1",
      title: "Permission then update fail",
      created_by_open_id: "ou_someone_else",
      url: `https://larksuite.com/docx/${documentId}`,
    }),
    ensureDocumentManagerPermission: async () => {
      permissionCalls += 1;
      return {
        document_id: documentId,
        manager_open_id: "ou_test_acct-1",
        manager_permission: "full_access",
      };
    },
    updateDocument: async () => {
      const error = new Error("Failed to write Lark document content");
      error.response = {
        status: 400,
        data: {
          code: 99991663,
          msg: "invalid block parent",
          log_id: "log-permission-then-update-400",
        },
      };
      throw error;
    },
    deleteDocument: async (_accessToken, incomingDocumentId) => {
      deletedDocumentIds.push(incomingDocumentId);
      return {
        document_id: incomingDocumentId,
        deleted: true,
      };
    },
  });

  const { port } = server.address();
  const { applyResponse, applyPayload } = await previewThenConfirmDocumentCreate({
    port,
    body: {
      title: "Permission then update fail",
      content: "# Draft\n\nInitial content",
    },
  });

  assert.equal(applyResponse.status, 500);
  assert.equal(applyPayload.ok, false);
  assert.equal(applyPayload.error, "execution_failed");
  assert.equal(permissionCalls, 1);
  assert.deepEqual(deletedDocumentIds, [documentId]);

  const lifecycleRow = db.prepare(
    "SELECT id FROM lark_documents WHERE account_id = ? AND document_id = ?",
  ).get("acct-1", documentId);
  assert.equal(lifecycleRow, undefined);
});

test("agent create_doc blocks when entry governance metadata is missing", async (t) => {
  withEnv(t, {
    ALLOW_LARK_WRITES: "true",
  });
  const { server } = await startTestServer(t, {
    createDocument: async () => {
      throw new Error("should_not_create");
    },
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/agent/docs/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Planner Controlled Create",
      confirm: true,
      source: "api_doc_create",
      intent: "create_doc",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.ok, false);
  assert.equal(payload.action, "create_doc");
  assert.equal(payload.data.error, "entry_governance_required");
  assert.deepEqual(payload.data.missing_fields, ["owner", "type"]);
});

test("agent create_doc succeeds when entry governance metadata is present", async (t) => {
  withEnv(t, {
    ALLOW_LARK_WRITES: "true",
  });
  const documentId = `doc-agent-create-${Date.now()}`;
  const { server } = await startTestServer(t, {
    createDocument: async () => ({
      document_id: documentId,
      revision_id: "rev-agent-create-1",
      title: "Planner Controlled Create",
      url: `https://larksuite.com/docx/${documentId}`,
    }),
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/agent/docs/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Planner Controlled Create",
      confirm: true,
      source: "api_doc_create",
      owner: "planner_agent",
      intent: "create_doc",
      type: "document_create",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "create_doc");
  assert.equal(payload.data.document_id, documentId);
});

test("/search returns index retrieval hits through the unified read runtime", async (t) => {
  const docId = `doc-route-index-${Date.now()}`;
  insertIndexedSearchFixture({
    docId,
    title: "Index Runtime Search Guide",
    rawText: "launch checklist owner timeline from indexed retrieval",
  });
  t.after(() => {
    db.prepare("DELETE FROM lark_chunk_embeddings WHERE account_id = ?").run("acct-1");
    db.prepare("DELETE FROM lark_chunks_fts WHERE account_id = ?").run("acct-1");
    db.prepare("DELETE FROM lark_chunks WHERE account_id = ?").run("acct-1");
    db.prepare("DELETE FROM lark_documents WHERE account_id = ? AND document_id = ?").run("acct-1", docId);
    db.prepare("DELETE FROM lark_tokens WHERE account_id = ?").run("acct-1");
  });

  const { server } = await startTestServer(t, {});
  const { port } = server.address();

  const response = await fetch(
    `http://127.0.0.1:${port}/search?q=launch%20checklist&account_id=acct-1`,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.account_id, "acct-1");
  assert.equal(payload.total, 1);
  assert.equal(payload.items[0].title, "Index Runtime Search Guide");
});

test("/answer keeps planner edge authority even when AGENT_E2E rollout flags are enabled", async (t) => {
  withEnv(t, {
    AGENT_E2E_ENABLED: "true",
    AGENT_E2E_RATIO: "1",
  });
  let agentCalls = 0;
  const plannerCalls = [];
  const { server } = await startTestServer(t, {
    async runAgentE2E(userInput, ctx) {
      agentCalls += 1;
      return {
        ok: true,
        final: {
          ok: true,
          action: "answer_user_directly",
          result: {
            answer: "agent e2e canary answer",
          },
        },
        terminal_reason: "answer_user_directly",
        plan: ["answer_user_directly"],
      };
    },
    async executePlannedUserInput(args) {
      plannerCalls.push(args);
      return {
        ok: true,
        action: "search_company_brain_docs",
        execution_result: {
          ok: true,
          data: {
            answer: "planner edge single authority answer",
            sources: [],
            limitations: [],
          },
        },
      };
    },
  });
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/answer?q=${encodeURIComponent("公司 SOP 在哪裡？")}`, {
    headers: {
      "x-user-id": "user-e2e-canary",
      "x-account-id": "acct-1",
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.answer, "planner edge single authority answer");
  assert.equal(Array.isArray(payload.sources), true);
  assert.equal(Array.isArray(payload.limitations), true);
  assert.equal(agentCalls, 0);
  assert.equal(plannerCalls.length, 1);
});

test("/answer planner ingress fails fast under stalled planner execution", { timeout: 8000 }, async (t) => {
  withEnv(t, {
    AGENT_E2E_ENABLED: "true",
    AGENT_E2E_RATIO: "1",
    AGENT_E2E_LEGACY_FALLBACK_ENABLED: null,
    AGENT_E2E_BUDGET_MS: "80",
  });
  const { server } = await startTestServer(t, {
    async executePlannedUserInput() {
      return new Promise(() => {});
    },
  });
  const { port } = server.address();
  const controller = new AbortController();
  const forceAbortHandle = setTimeout(() => {
    controller.abort(new Error("client-side safety timeout"));
  }, 3000);
  t.after(() => {
    clearTimeout(forceAbortHandle);
  });

  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/answer?q=${encodeURIComponent("幫我查 Scanoo 是什麼，整理給我")}`, {
    headers: {
      "x-user-id": "user-e2e-timeout",
      "x-account-id": "acct-1",
    },
    signal: controller.signal,
  });
  clearTimeout(forceAbortHandle);
  const payload = await response.json();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(response.status, 504);
  assert.equal(payload.ok, false);
  assert.equal(Array.isArray(payload.limitations), true);
  assert.equal(payload.limitations.some((item) => String(item || "").includes("timeout_layer=planner")), true);
  assert.equal(elapsedMs < 2500, true);
});

test("/answer keeps planner edge authority when runAgentE2E override returns non-final state", async (t) => {
  withEnv(t, {
    AGENT_E2E_ENABLED: "true",
    AGENT_E2E_RATIO: "1",
    AGENT_E2E_LEGACY_FALLBACK_ENABLED: null,
  });
  let agentCalls = 0;
  const plannerCalls = [];
  const { server, calls } = await startTestServer(t, {
    async runAgentE2E(userInput, ctx) {
      agentCalls += 1;
      return {
        ok: false,
        final: null,
        terminal_reason: "max_steps_reached",
        plan: ["search_company_brain_docs"],
      };
    },
    async executePlannedUserInput(args) {
      plannerCalls.push(args);
      return {
        ok: true,
        action: "search_company_brain_docs",
        execution_result: {
          ok: true,
          data: {
            answer: "planner fallback answer",
            sources: ["來源 A"],
            limitations: [],
          },
        },
      };
    },
  });
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/answer?q=${encodeURIComponent("我要 SOP")}`, {
    headers: {
      "x-user-id": "user-e2e-fallback",
      "x-account-id": "acct-1",
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "planner fallback answer");
  assert.equal(agentCalls, 0);
  assert.equal(plannerCalls.length, 1);
  assert.equal(calls.some((entry) => entry[1]?.event === "knowledge_answer_agent_e2e_stopped"), false);
  assert.equal(calls.some((entry) => entry[1]?.event === "knowledge_answer_agent_e2e_fallback"), false);
});

test("/answer ignores legacy fallback flag and stays on planner edge authority", async (t) => {
  withEnv(t, {
    AGENT_E2E_ENABLED: "true",
    AGENT_E2E_RATIO: "1",
    AGENT_E2E_LEGACY_FALLBACK_ENABLED: "true",
  });
  let agentCalls = 0;
  const plannerCalls = [];
  const { server, calls } = await startTestServer(t, {
    async runAgentE2E(userInput, ctx) {
      agentCalls += 1;
      return {
        ok: false,
        final: null,
        terminal_reason: "max_steps_reached",
        plan: ["search_company_brain_docs"],
      };
    },
    async executePlannedUserInput(args) {
      plannerCalls.push(args);
      return {
        ok: true,
        action: "search_company_brain_docs",
        execution_result: {
          ok: true,
          data: {
            answer: "planner fallback answer",
            sources: ["來源 A"],
            limitations: [],
          },
        },
      };
    },
  });
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/answer?q=${encodeURIComponent("我要 SOP")}`, {
    headers: {
      "x-user-id": "user-e2e-fallback",
      "x-account-id": "acct-1",
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.answer, "planner fallback answer");
  assert.equal(agentCalls, 0);
  assert.equal(plannerCalls.length, 1);
  assert.equal(calls.some((entry) => entry[1]?.event === "knowledge_answer_agent_e2e_fallback"), false);
});

test("agent company-brain search and detail routes return structured summaries for planner use", async (t) => {
  const docId = `doc-agent-company-brain-${Date.now()}`;
  insertCompanyBrainFixture({
    docId,
    title: "Planner Delivery SOP",
    rawText: [
      "# Planner Delivery SOP",
      "## Owner",
      "CS Team",
      "## Steps",
      "- Confirm onboarding owner",
      "- Review launch checklist",
    ].join("\n"),
  });
  t.after(() => {
    db.prepare("DELETE FROM company_brain_docs WHERE account_id = ? AND doc_id = ?").run("acct-1", docId);
    db.prepare("DELETE FROM lark_documents WHERE account_id = ? AND document_id = ?").run("acct-1", docId);
  });

  const { server } = await startTestServer(t, {});
  const { port } = server.address();

  const searchResponse = await fetch(`http://127.0.0.1:${port}/agent/company-brain/search?q=launch%20checklist`, {
    headers: createExplicitPlannerAuthHeaders(),
  });
  const searchPayload = await searchResponse.json();
  assert.equal(searchResponse.status, 200);
  assert.equal(searchPayload.ok, true);
  assert.equal(searchPayload.action, "search_company_brain_docs");
  assert.equal(searchPayload.data.success, true);
  assert.equal(searchPayload.data.data.items[0].doc_id, docId);
  assert.equal(searchPayload.data.data.items[0].url, `https://larksuite.com/docx/${docId}`);
  assert.match(searchPayload.data.data.items[0].summary.overview, /Planner Delivery SOP/);

  const detailResponse = await fetch(`http://127.0.0.1:${port}/agent/company-brain/docs/${docId}`, {
    headers: createExplicitPlannerAuthHeaders(),
  });
  const detailPayload = await detailResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.equal(detailPayload.ok, true);
  assert.equal(detailPayload.action, "get_company_brain_doc_detail");
  assert.equal(detailPayload.data.success, true);
  assert.equal(detailPayload.data.data.doc.doc_id, docId);
  assert.equal(detailPayload.data.data.doc.url, `https://larksuite.com/docx/${docId}`);
  assert.deepEqual(detailPayload.data.data.summary.headings.slice(0, 2), [
    "Planner Delivery SOP",
    "Owner",
  ]);
});

test("api company-brain read routes stay on minimal mirror views", async (t) => {
  const docId = `doc-api-company-brain-${Date.now()}`;
  insertCompanyBrainFixture({
    docId,
    title: "API Mirror Runbook",
    rawText: [
      "# API Mirror Runbook",
      "mirror owner checklist",
    ].join("\n"),
  });
  t.after(() => {
    db.prepare("DELETE FROM company_brain_docs WHERE account_id = ? AND doc_id = ?").run("acct-1", docId);
    db.prepare("DELETE FROM lark_documents WHERE account_id = ? AND document_id = ?").run("acct-1", docId);
  });

  const { server } = await startTestServer(t, {});
  const { port } = server.address();

  const listResponse = await fetch(`http://127.0.0.1:${port}/api/company-brain/docs?limit=5`);
  const listPayload = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listPayload.ok, true);
  assert.equal(listPayload.action, "company_brain_docs_list");
  assert.equal(Array.isArray(listPayload.items), true);
  assert.equal(listPayload.items.some((item) => item.doc_id === docId), true);

  const searchResponse = await fetch(`http://127.0.0.1:${port}/api/company-brain/search?q=mirror%20owner`);
  const searchPayload = await searchResponse.json();
  assert.equal(searchResponse.status, 200);
  assert.equal(searchPayload.ok, true);
  assert.equal(searchPayload.action, "company_brain_docs_search");
  assert.equal(searchPayload.items[0].doc_id, docId);
  assert.equal(searchPayload.items[0].title, "API Mirror Runbook");
  assert.equal(searchPayload.items[0].summary, undefined);

  const detailResponse = await fetch(`http://127.0.0.1:${port}/api/company-brain/docs/${docId}`);
  const detailPayload = await detailResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.equal(detailPayload.ok, true);
  assert.equal(detailPayload.action, "company_brain_doc_detail");
  assert.equal(detailPayload.item.doc_id, docId);
  assert.equal(detailPayload.item.title, "API Mirror Runbook");
  assert.equal(detailPayload.item.summary, undefined);
});

test("agent company-brain search fails closed without explicit user token", async (t) => {
  const docId = `doc-agent-company-brain-auth-${Date.now()}`;
  insertCompanyBrainFixture({
    docId,
    title: "Scanoo Delivery Notes",
    rawText: "scanoo launch checklist",
  });
  t.after(() => {
    db.prepare("DELETE FROM company_brain_docs WHERE account_id = ? AND doc_id = ?").run("acct-1", docId);
    db.prepare("DELETE FROM lark_documents WHERE account_id = ? AND document_id = ?").run("acct-1", docId);
  });

  const { server } = await startTestServer(t, {});
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/agent/company-brain/search?q=scanoo`);
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "missing_user_access_token");
  assert.match(payload.message, /explicit user_access_token/i);
});

test("agent company-brain review conflict approval apply slice is end-to-end verifiable", async (t) => {
  const docId = `doc-agent-company-brain-approval-${Date.now()}`;
  insertCompanyBrainFixture({
    docId,
    title: "Formal Launch Runbook",
    rawText: [
      "# Formal Launch Runbook",
      "## Owners",
      "Launch owner",
      "## Checklist",
      "- Confirm launch owner",
      "- Approve the final checklist",
    ].join("\n"),
  });
  t.after(() => {
    db.prepare("DELETE FROM company_brain_approved_knowledge WHERE account_id = ? AND doc_id = ?").run("acct-1", docId);
    db.prepare("DELETE FROM company_brain_review_state WHERE account_id = ? AND doc_id = ?").run("acct-1", docId);
    db.prepare("DELETE FROM company_brain_docs WHERE account_id = ? AND doc_id = ?").run("acct-1", docId);
    db.prepare("DELETE FROM lark_documents WHERE account_id = ? AND document_id = ?").run("acct-1", docId);
  });

  const { server } = await startTestServer(t, {});
  const { port } = server.address();

  const beforeResponse = await fetch(`http://127.0.0.1:${port}/agent/company-brain/approved/search?q=launch%20owner`, {
    headers: createExplicitPlannerAuthHeaders(),
  });
  const beforePayload = await beforeResponse.json();
  assert.equal(beforeResponse.status, 200);
  assert.equal(beforePayload.data.data.total, 0);

  const reviewResponse = await fetch(`http://127.0.0.1:${port}/agent/company-brain/review`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createExplicitPlannerAuthHeaders(),
    },
    body: JSON.stringify({
      doc_id: docId,
      title: "Formal Launch Runbook",
      target_stage: "approved_knowledge",
    }),
  });
  const reviewPayload = await reviewResponse.json();
  assert.equal(reviewResponse.status, 200);
  assert.equal(reviewPayload.ok, true);
  assert.equal(reviewPayload.action, "review_company_brain_doc");
  assert.equal(reviewPayload.data.data.review_state.status, "pending_review");
  assert.equal(reviewPayload.data.data.intake_boundary.approval_required_for_formal_source, true);

  const conflictResponse = await fetch(`http://127.0.0.1:${port}/agent/company-brain/conflicts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createExplicitPlannerAuthHeaders(),
    },
    body: JSON.stringify({
      doc_id: docId,
      title: "Formal Launch Runbook",
      target_stage: "approved_knowledge",
    }),
  });
  const conflictPayload = await conflictResponse.json();
  assert.equal(conflictResponse.status, 200);
  assert.equal(conflictPayload.ok, true);
  assert.equal(conflictPayload.action, "check_company_brain_conflicts");
  assert.equal(conflictPayload.data.data.conflict_state, "none");
  assert.equal(conflictPayload.data.data.intake_boundary.conflict_check_required, false);

  const approvalResponse = await fetch(`http://127.0.0.1:${port}/agent/company-brain/approval-transition`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createExplicitPlannerAuthHeaders(),
    },
    body: JSON.stringify({
      doc_id: docId,
      decision: "approve",
      actor: "reviewer@test",
      notes: "Approved for formal knowledge admission.",
    }),
  });
  const approvalPayload = await approvalResponse.json();
  assert.equal(approvalResponse.status, 200);
  assert.equal(approvalPayload.ok, true);
  assert.equal(approvalPayload.action, "approval_transition_company_brain_doc");
  assert.equal(approvalPayload.data.data.review_state.status, "approved");
  assert.equal(approvalPayload.data.data.approval_state.approval, null);

  const applyResponse = await fetch(`http://127.0.0.1:${port}/agent/company-brain/docs/${docId}/apply`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createExplicitPlannerAuthHeaders(),
    },
    body: JSON.stringify({
      actor: "reviewer@test",
      source_stage: "approved_knowledge",
    }),
  });
  const applyPayload = await applyResponse.json();
  assert.equal(applyResponse.status, 200);
  assert.equal(applyPayload.ok, true);
  assert.equal(applyPayload.action, "apply_company_brain_approved_knowledge");
  assert.equal(applyPayload.data.data.approval.status, "approved");

  const approvedSearchResponse = await fetch(`http://127.0.0.1:${port}/agent/company-brain/approved/search?q=launch%20owner`, {
    headers: createExplicitPlannerAuthHeaders(),
  });
  const approvedSearchPayload = await approvedSearchResponse.json();
  assert.equal(approvedSearchResponse.status, 200);
  assert.equal(approvedSearchPayload.ok, true);
  assert.equal(approvedSearchPayload.data.data.total, 1);
  assert.equal(approvedSearchPayload.data.data.items[0].doc_id, docId);
  assert.equal(approvedSearchPayload.data.data.items[0].knowledge_state.stage, "approved");

  const approvedDetailResponse = await fetch(`http://127.0.0.1:${port}/agent/company-brain/approved/docs/${docId}`, {
    headers: createExplicitPlannerAuthHeaders(),
  });
  const approvedDetailPayload = await approvedDetailResponse.json();
  assert.equal(approvedDetailResponse.status, 200);
  assert.equal(approvedDetailPayload.ok, true);
  assert.equal(approvedDetailPayload.action, "get_approved_company_brain_knowledge_detail");
  assert.equal(approvedDetailPayload.data.data.doc.doc_id, docId);
  assert.equal(approvedDetailPayload.data.data.knowledge_state.stage, "approved");
});

test("agent company-brain conflicts stages conflict_detected when overlap exists", async (t) => {
  const timestamp = Date.now();
  const title = `Shared Launch Checklist ${timestamp}`;
  const primaryDocId = `doc-agent-company-brain-conflict-a-${timestamp}`;
  const conflictingDocId = `doc-agent-company-brain-conflict-b-${timestamp}`;
  insertCompanyBrainFixture({
    docId: primaryDocId,
    title,
    rawText: [
      "# Shared Launch Checklist",
      "Owner A",
    ].join("\n"),
  });
  insertCompanyBrainFixture({
    docId: conflictingDocId,
    title,
    rawText: [
      "# Shared Launch Checklist",
      "Owner B",
    ].join("\n"),
  });
  t.after(() => {
    db.prepare("DELETE FROM company_brain_review_state WHERE account_id = ? AND doc_id IN (?, ?)").run(
      "acct-1",
      primaryDocId,
      conflictingDocId,
    );
    db.prepare("DELETE FROM company_brain_docs WHERE account_id = ? AND doc_id IN (?, ?)").run(
      "acct-1",
      primaryDocId,
      conflictingDocId,
    );
    db.prepare("DELETE FROM lark_documents WHERE account_id = ? AND document_id IN (?, ?)").run(
      "acct-1",
      primaryDocId,
      conflictingDocId,
    );
  });

  const { server } = await startTestServer(t, {});
  const { port } = server.address();

  const conflictResponse = await fetch(`http://127.0.0.1:${port}/agent/company-brain/conflicts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createExplicitPlannerAuthHeaders(),
    },
    body: JSON.stringify({
      doc_id: primaryDocId,
      title,
      target_stage: "approved_knowledge",
    }),
  });
  const conflictPayload = await conflictResponse.json();

  assert.equal(conflictResponse.status, 200);
  assert.equal(conflictPayload.ok, true);
  assert.equal(conflictPayload.action, "check_company_brain_conflicts");
  assert.equal(conflictPayload.data.success, true);
  assert.equal(conflictPayload.data.data.conflict_state, "confirmed");
  assert.equal(conflictPayload.data.data.review_state.status, "conflict_detected");
  assert.equal(conflictPayload.data.data.conflict_items.length, 1);
  assert.equal(conflictPayload.data.data.conflict_items[0].doc_id, conflictingDocId);
});

test("agent company-brain learning state update routes through the runtime and persists learning metadata", async (t) => {
  const docId = `doc-agent-company-brain-learning-${Date.now()}`;
  insertCompanyBrainFixture({
    docId,
    title: "Learning Route Fixture",
    rawText: [
      "# Learning Route Fixture",
      "## Notes",
      "Planner-side learning metadata should persist through the shared mutation runtime.",
    ].join("\n"),
  });
  t.after(() => {
    db.prepare("DELETE FROM company_brain_learning_state WHERE account_id = ? AND doc_id = ?").run("acct-1", docId);
    db.prepare("DELETE FROM company_brain_docs WHERE account_id = ? AND doc_id = ?").run("acct-1", docId);
    db.prepare("DELETE FROM lark_documents WHERE account_id = ? AND document_id = ?").run("acct-1", docId);
  });

  const { server } = await startTestServer(t, {});
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/agent/company-brain/learning/state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createExplicitPlannerAuthHeaders(),
    },
    body: JSON.stringify({
      doc_id: docId,
      status: "learned",
      tags: ["runtime-route-tag"],
      key_concepts: ["shared mutation runtime"],
      notes: "Persisted through the runtime.",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, "update_learning_state");
  assert.equal(payload.data.data.doc.doc_id, docId);
  assert.equal(payload.data.data.learning_state.status, "learned");
  assert.equal(payload.data.data.learning_state.tags.includes("runtime-route-tag"), true);
  assert.equal(payload.data.data.learning_state.key_concepts.includes("shared mutation runtime"), true);
});

test("cloud doc apply route requires prior preview and cannot bypass verifier path", async (t) => {
  const { server } = await startTestServer(t, {
    resolveDriveRootFolderToken: async () => "fld-root",
    applyDriveOrganization: async () => ({ task_id: "drive-task-apply-1", moved: 3 }),
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/drive/organize/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recursive: true }),
  });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.error, "preview_required");
});

test("bitable records list and search success routes return trace and handler step logs", async (t) => {
  const { server, calls } = await startTestServer(t, {
    listBitableRecords: async () => ({ items: [{ record_id: "rec-1" }] }),
    searchBitableRecords: async () => ({ items: [{ record_id: "rec-2" }] }),
  });

  const { port } = server.address();
  const listResponse = await fetch(`http://127.0.0.1:${port}/api/bitable/apps/app-1/tables/tbl-1/records`);
  const listPayload = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.match(listPayload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "bitable_records_list_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "bitable_records_list_completed"), true);

  const searchResponse = await fetch(`http://127.0.0.1:${port}/api/bitable/apps/app-1/tables/tbl-1/records/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filter: { conditions: [] } }),
  });
  const searchPayload = await searchResponse.json();
  assert.equal(searchResponse.status, 200);
  assert.match(searchPayload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "bitable_records_search_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "bitable_records_search_completed"), true);
});

test("bitable record crud success routes return trace and handler step logs", async (t) => {
  const { server, calls } = await startTestServer(t, {
    createBitableRecord: async () => ({ record: { record_id: "rec-created" } }),
    getBitableRecord: async () => ({ record: { record_id: "rec-1" } }),
    updateBitableRecord: async () => ({ record: { record_id: "rec-1" } }),
    deleteBitableRecord: async () => ({ deleted: true }),
  });

  const { port } = server.address();

  const createResponse = await fetch(`http://127.0.0.1:${port}/api/bitable/apps/app-1/tables/tbl-1/records/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: { Name: "Alpha" } }),
  });
  assert.equal(createResponse.status, 200);
  assert.match((await createResponse.json()).trace_id, /^http_/);

  const getResponse = await fetch(`http://127.0.0.1:${port}/api/bitable/apps/app-1/tables/tbl-1/records/rec-1`);
  assert.equal(getResponse.status, 200);
  assert.match((await getResponse.json()).trace_id, /^http_/);

  const updateResponse = await fetch(`http://127.0.0.1:${port}/api/bitable/apps/app-1/tables/tbl-1/records/rec-1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: { Name: "Beta" } }),
  });
  assert.equal(updateResponse.status, 200);
  assert.match((await updateResponse.json()).trace_id, /^http_/);

  const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/bitable/apps/app-1/tables/tbl-1/records/rec-1`, {
    method: "DELETE",
  });
  assert.equal(deleteResponse.status, 200);
  assert.match((await deleteResponse.json()).trace_id, /^http_/);

  assert.equal(calls.some((entry) => entry[1]?.event === "bitable_record_create_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "bitable_record_create_completed"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "bitable_record_get_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "bitable_record_get_completed"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "bitable_record_update_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "bitable_record_update_completed"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "bitable_record_delete_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "bitable_record_delete_completed"), true);
});

test("calendar freebusy success route returns trace and handler step logs", async (t) => {
  const { server, calls } = await startTestServer(t, {
    listFreebusy: async () => ({ items: [{ id: "fb-1", busy: true }] }),
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/calendar/freebusy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ time_min: "2026-03-17T09:00:00+08:00", time_max: "2026-03-17T10:00:00+08:00" }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "calendar_freebusy_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "calendar_freebusy_completed"), true);
});

test("calendar create event success route returns trace and handler step logs", async (t) => {
  const { server, calls } = await startTestServer(t, {
    createCalendarEvent: async () => ({ event: { event_id: "evt-1" } }),
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/calendar/events/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      calendar_id: "cal-1",
      summary: "Weekly sync",
      start_time: "2026-03-17T09:00:00+08:00",
      end_time: "2026-03-17T10:00:00+08:00",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(payload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "calendar_create_event_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "calendar_create_event_completed"), true);
});

test("task comments list and create success routes return trace and handler step logs", async (t) => {
  const { server, calls } = await startTestServer(t, {
    listTaskComments: async () => ({ items: [{ comment_id: "c-1" }] }),
    createTaskComment: async () => ({ comment: { comment_id: "c-2" } }),
  });

  const { port } = server.address();
  const listResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/task-1/comments`);
  const listPayload = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.match(listPayload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "task_comments_list_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "task_comments_list_completed"), true);

  const createResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/task-1/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "please review" }),
  });
  const createPayload = await createResponse.json();
  assert.equal(createResponse.status, 200);
  assert.match(createPayload.trace_id, /^http_/);
  assert.equal(calls.some((entry) => entry[1]?.event === "task_comment_create_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "task_comment_create_completed"), true);
});

test("task get/create and comment update/delete success routes return trace and handler step logs", async (t) => {
  const { server, calls } = await startTestServer(t, {
    getTask: async () => ({ task: { task_id: "task-1" } }),
    createTask: async () => ({ task: { task_id: "task-created" } }),
    updateTaskComment: async () => ({ comment: { comment_id: "c-1" } }),
    deleteTaskComment: async () => ({ deleted: true }),
  });

  const { port } = server.address();

  const getTaskResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/task-1`);
  assert.equal(getTaskResponse.status, 200);
  assert.match((await getTaskResponse.json()).trace_id, /^http_/);

  const createTaskResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary: "Ship feature" }),
  });
  assert.equal(createTaskResponse.status, 200);
  assert.match((await createTaskResponse.json()).trace_id, /^http_/);

  const updateCommentResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/task-1/comments/c-1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "updated comment" }),
  });
  assert.equal(updateCommentResponse.status, 200);
  assert.match((await updateCommentResponse.json()).trace_id, /^http_/);

  const deleteCommentResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/task-1/comments/c-1`, {
    method: "DELETE",
  });
  assert.equal(deleteCommentResponse.status, 200);
  assert.match((await deleteCommentResponse.json()).trace_id, /^http_/);

  assert.equal(calls.some((entry) => entry[1]?.event === "task_get_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "task_get_completed"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "task_create_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "task_create_completed"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "task_comment_update_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "task_comment_update_completed"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "task_comment_delete_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "task_comment_delete_completed"), true);
});

test("task create idempotency replays first result without rerunning handler", async (t) => {
  let createCalls = 0;
  const { server } = await startTestServer(t, {
    createTask: async () => {
      createCalls += 1;
      return {
        task: {
          task_id: `task-created-${createCalls}`,
          summary: "Ship feature",
        },
      };
    },
  });

  const { port } = server.address();
  const idempotencyKey = `task-create-${Date.now()}`;
  const requestBody = {
    summary: "Ship feature",
    idempotency_key: idempotencyKey,
  };

  const firstResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const firstPayload = await firstResponse.json();

  const secondResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const secondPayload = await secondResponse.json();

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(createCalls, 1);
  assert.deepEqual(stripTrace(secondPayload), stripTrace(firstPayload));
  assert.equal(secondPayload.task?.task_id, firstPayload.task?.task_id);

  const record = getHttpIdempotencyRecord({
    method: "POST",
    pathname: "/api/tasks/create",
    idempotencyKey,
  });

  assert.ok(record);
  assert.equal(record.status_code, 200);
  assert.equal(record.account_id, null);
  assert.equal(record.first_trace_id, firstPayload.trace_id);
  assert.equal(record.response_payload?.task?.task_id, firstPayload.task?.task_id);
});

test("document update can preview a heading-targeted insert", async (t) => {
  const snapshot = await snapshotFile(docUpdateConfirmationStorePath);
  t.after(async () => {
    await restoreFile(docUpdateConfirmationStorePath, snapshot);
  });

  const { server } = await startTestServer(t, {
    getDocument: async () => ({
      document_id: "doc-1",
      revision_id: "rev-1",
      title: "Spec",
      content: [
        "# 第一部分",
        "Alpha",
        "",
        "# 第二部分",
        "Beta",
        "",
        "# 第三部分",
        "Gamma",
      ].join("\n"),
    }),
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/doc/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document_id: "doc-1",
      content: "New line",
      target_heading: "第二部分",
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.preview_required, true);
  assert.equal(payload.action, "document_update_targeted_preview");
  assert.equal(payload.targeting?.type, "heading");
  assert.equal(payload.targeting?.matched_heading, "第二部分");
  assert.match(payload.trace_id, /^http_/);
  assert.match(payload.message, /explicit confirmation/i);
});

test("document update can apply a heading-targeted insert after confirmation", async (t) => {
  const snapshot = await snapshotFile(docUpdateConfirmationStorePath);
  const documentId = `doc-update-heading-${Date.now()}`;
  t.after(async () => {
    await restoreFile(docUpdateConfirmationStorePath, snapshot);
    db.prepare("DELETE FROM company_brain_docs WHERE account_id = ? AND doc_id = ?").run("acct-1", documentId);
    db.prepare("DELETE FROM lark_documents WHERE account_id = ? AND document_id = ?").run("acct-1", documentId);
  });
  insertCompanyBrainFixture({
    docId: documentId,
    title: "Spec",
    rawText: [
      "# 第一部分",
      "Alpha",
      "",
      "# 第二部分",
      "Beta",
      "",
      "# 第三部分",
      "Gamma",
    ].join("\n"),
  });

  const calls = [];
  const { server } = await startTestServer(t, {
    getDocument: async () => ({
      document_id: documentId,
      revision_id: "rev-1",
      title: "Spec",
      content: [
        "# 第一部分",
        "Alpha",
        "",
        "# 第二部分",
        "Beta",
        "",
        "# 第三部分",
        "Gamma",
      ].join("\n"),
    }),
    updateDocument: async (_accessToken, documentId, content, mode) => {
      calls.push({ documentId, content, mode });
      return {
        document_id: documentId,
        mode,
        root_block_id: "blk-root",
        appended_blocks: 1,
      };
    },
  });

  const { port } = server.address();
  const previewResponse = await fetch(`http://127.0.0.1:${port}/api/doc/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document_url: `https://larksuite.com/docx/${documentId}`,
      content: "New line",
      section_heading: "第二部分",
    }),
  });
  const previewPayload = await previewResponse.json();

  assert.equal(previewResponse.status, 200);
  assert.equal(previewPayload.preview_required, true);

  const applyResponse = await fetch(`http://127.0.0.1:${port}/api/doc/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document_id: documentId,
      content: "New line",
      section_heading: "第二部分",
      confirm: true,
      confirmation_id: previewPayload.confirmation_id,
    }),
  });
  const applyPayload = await applyResponse.json();

  assert.equal(applyResponse.status, 200);
  assert.equal(applyPayload.action, "document_update_targeted_apply");
  assert.equal(applyPayload.targeting?.matched_heading, "第二部分");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    documentId,
    content: [
      "# 第一部分",
      "Alpha",
      "",
      "# 第二部分",
      "Beta",
      "",
      "New line",
      "",
      "# 第三部分",
      "Gamma",
    ].join("\n"),
    mode: "replace",
  });
});

test("document update fails closed when company-brain review sync does not find a mirrored doc", async (t) => {
  const snapshot = await snapshotFile(docUpdateConfirmationStorePath);
  const documentId = `doc-update-review-miss-${Date.now()}`;
  t.after(async () => {
    await restoreFile(docUpdateConfirmationStorePath, snapshot);
    db.prepare("DELETE FROM company_brain_docs WHERE account_id = ? AND doc_id = ?").run("acct-1", documentId);
    db.prepare("DELETE FROM lark_documents WHERE account_id = ? AND document_id = ?").run("acct-1", documentId);
  });

  const calls = [];
  const { server } = await startTestServer(t, {
    getDocument: async () => ({
      document_id: documentId,
      revision_id: "rev-1",
      title: "Spec",
      content: [
        "# 第一部分",
        "Alpha",
        "",
        "# 第二部分",
        "Beta",
      ].join("\n"),
    }),
    updateDocument: async (_accessToken, incomingDocumentId, content, mode) => {
      calls.push({ documentId: incomingDocumentId, content, mode });
      return {
        document_id: incomingDocumentId,
        mode,
        root_block_id: "blk-root",
        appended_blocks: 1,
      };
    },
  });

  const { port } = server.address();
  const previewResponse = await fetch(`http://127.0.0.1:${port}/api/doc/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document_url: `https://larksuite.com/docx/${documentId}`,
      content: "New line",
      section_heading: "第二部分",
    }),
  });
  const previewPayload = await previewResponse.json();

  assert.equal(previewResponse.status, 200);
  assert.equal(previewPayload.preview_required, true);

  const applyResponse = await fetch(`http://127.0.0.1:${port}/api/doc/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document_id: documentId,
      content: "New line",
      section_heading: "第二部分",
      confirm: true,
      confirmation_id: previewPayload.confirmation_id,
    }),
  });
  const applyPayload = await applyResponse.json();

  assert.equal(applyResponse.status, 404);
  assert.equal(applyPayload.ok, false);
  assert.equal(applyPayload.error, "not_found");
  assert.match(applyPayload.message || "", /company-brain review sync failed/i);
  assert.equal(calls.length, 1);
});

test("document update apply rejects writes without explicit document_id and section_heading", async (t) => {
  const snapshot = await snapshotFile(docUpdateConfirmationStorePath);
  t.after(async () => {
    await restoreFile(docUpdateConfirmationStorePath, snapshot);
  });

  const { server } = await startTestServer(t, {
    getDocument: async () => ({
      document_id: "doc-1",
      revision_id: "rev-1",
      title: "Spec",
      content: [
        "# 第一部分",
        "Alpha",
        "",
        "# 第二部分",
        "Beta",
      ].join("\n"),
    }),
    updateDocument: async () => {
      throw new Error("updateDocument should not run when explicit write target is missing");
    },
  });

  const { port } = server.address();
  const previewResponse = await fetch(`http://127.0.0.1:${port}/api/doc/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document_url: "https://larksuite.com/docx/doc-1",
      content: "New line",
      target_heading: "第二部分",
    }),
  });
  const previewPayload = await previewResponse.json();

  assert.equal(previewResponse.status, 200);
  assert.equal(previewPayload.preview_required, true);

  const applyResponse = await fetch(`http://127.0.0.1:${port}/api/doc/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "New line",
      target_heading: "第二部分",
      confirm: true,
      confirmation_id: previewPayload.confirmation_id,
    }),
  });
  const applyPayload = await applyResponse.json();

  assert.equal(applyResponse.status, 400);
  assert.equal(applyPayload.ok, false);
  assert.equal(applyPayload.error, "missing_explicit_write_target");
  assert.deepEqual(applyPayload.missing_fields, ["document_id", "section_heading"]);
  assert.deepEqual(applyPayload.required_fields, ["document_id", "section_heading"]);
  assert.match(applyPayload.message, /explicit document_id and section_heading/i);
});

test("improvement workflow routes support list approve reject apply", async (t) => {
  const snapshot = await snapshotFile(executiveImprovementStorePath);
  t.after(async () => {
    await restoreFile(executiveImprovementStorePath, snapshot);
  });
  await fs.writeFile(executiveImprovementStorePath, JSON.stringify({
    items: [
      {
        id: "proposal-1",
        task_id: "task-1",
        account_id: "acct-1",
        session_key: "sess-1",
        reflection_id: "reflection-1",
        category: "verification_improvement",
        mode: "proposal_only",
        title: "Tighten meeting owner check",
        description: "owner missing should stay blocked",
        target: "executive-verifier",
        source_error_type: "missing_owner",
        status: "pending_approval",
        created_at: "2026-03-18T00:00:00.000Z",
        updated_at: "2026-03-18T00:00:00.000Z",
      },
      {
        id: "proposal-2",
        task_id: "task-1",
        account_id: "acct-1",
        session_key: "sess-1",
        reflection_id: "reflection-1",
        category: "prompt_improvement",
        mode: "proposal_only",
        title: "Shorten robotic status wording",
        description: "replace robotic fallback wording",
        target: "agent-dispatcher",
        source_error_type: "robotic_response",
        status: "pending_approval",
        created_at: "2026-03-18T00:00:00.000Z",
        updated_at: "2026-03-18T00:00:00.000Z",
      },
    ],
  }, null, 2));

  const { server, calls } = await startTestServer(t, {});
  const { port } = server.address();

  const listResponse = await fetch(`http://127.0.0.1:${port}/agent/improvements?account_id=acct-1`);
  const listPayload = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listPayload.total, 2);
  assert.match(listPayload.trace_id, /^http_/);

  const approveResponse = await fetch(`http://127.0.0.1:${port}/agent/improvements/proposal-1/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "sean" }),
  });
  const approvePayload = await approveResponse.json();
  assert.equal(approveResponse.status, 200);
  assert.equal(approvePayload.item.status, "approved");

  const applyResponse = await fetch(`http://127.0.0.1:${port}/agent/improvements/proposal-1/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "sean" }),
  });
  const applyPayload = await applyResponse.json();
  assert.equal(applyResponse.status, 200);
  assert.equal(applyPayload.item.status, "applied");

  const rejectResponse = await fetch(`http://127.0.0.1:${port}/agent/improvements/proposal-2/reject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor: "sean" }),
  });
  const rejectPayload = await rejectResponse.json();
  assert.equal(rejectResponse.status, 200);
  assert.equal(rejectPayload.item.status, "rejected");

  assert.equal(calls.some((entry) => entry[1]?.event === "improvement_list_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "improvement_list_completed"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "improvement_resolution_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "improvement_resolution_completed"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "improvement_apply_started"), true);
  assert.equal(calls.some((entry) => entry[1]?.event === "improvement_apply_completed"), true);
});

test("lark plugin dispatch route returns plugin_native forward decisions without entering planner or lane paths", async (t) => {
  const { server, calls } = await startTestServer(t, {
    async executePlannedUserInput() {
      throw new Error("executePlannedUserInput should not run for plugin_native dispatch");
    },
    async executeCapabilityLane() {
      throw new Error("executeCapabilityLane should not run for plugin_native dispatch");
    },
  });
  const { port } = server.address();

  const { response, body } = await postPluginDispatch(port, {
    request_text: null,
    session_id: null,
    thread_id: null,
    chat_id: null,
    user_id: null,
    account_id: "acct-1",
    source: "official_lark_plugin",
    tool_name: "lark_doc_read",
    requested_capability: "lark_doc_read",
    route_request: {
      path: "/api/doc/read?document_id=doc_1",
      method: "GET",
      body: null,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.route_target, "plugin_native");
  assert.equal(body.final_status, "plugin_native_forward");
  assert.equal(body.fallback_reason, "plugin_native_capability");
  assert.equal(body.forward_request.path, "/api/doc/read?document_id=doc_1");
  assert.equal(calls.some((entry) => entry[1]?.event === "lark_plugin_dispatch_completed" && entry[1]?.fallback_reason === "plugin_native_capability"), true);
});

test("lark plugin dispatch route sends knowledge_answer requests through the existing answer edge", async (t) => {
  const plannerCalls = [];
  const { server, calls } = await startTestServer(t, {
    async executePlannedUserInput(args) {
      plannerCalls.push(args);
      return {
        ok: true,
        action: "search_company_brain_docs",
        execution_result: {
          ok: true,
          data: {
            answer: "這是知識回答",
            sources: ["來源 A"],
            limitations: [],
          },
        },
      };
    },
  });
  const { port } = server.address();

  const { response, body } = await postPluginDispatch(port, {
    request_text: "公司 SOP 在哪裡？",
    session_id: "sess_1",
    thread_id: null,
    chat_id: "chat_1",
    user_id: "user_1",
    account_id: "acct-1",
    user_access_token: "token-1",
    source: "official_lark_plugin",
    tool_name: "lark_kb_answer",
    requested_capability: "knowledge_answer",
    route_request: {
      path: "/answer?q=%E5%85%AC%E5%8F%B8%20SOP%20%E5%9C%A8%E5%93%AA%E8%A3%A1%EF%BC%9F&account_id=acct-1",
      method: "GET",
      body: null,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.route_target, "knowledge_answer");
  assert.equal(body.chosen_lane, "knowledge-assistant");
  assert.equal(body.final_status, "completed");
  assert.equal(body.response.status, 200);
  assert.equal(body.response.data.answer, "這是知識回答");
  assert.equal(plannerCalls.length, 1);
  assert.equal(plannerCalls[0].text, "公司 SOP 在哪裡？");
  assert.equal(calls.some((entry) => entry[1]?.event === "lark_plugin_dispatch_completed" && entry[1]?.fallback_reason === "knowledge_answer_path"), true);
});

test("lark plugin dispatch route respects explicit knowledge_answer capability over scanoo heuristics", async (t) => {
  const plannerCalls = [];
  const laneCalls = [];
  const { server } = await startTestServer(t, {
    async executePlannedUserInput(args) {
      plannerCalls.push(args);
      return {
        ok: true,
        action: "search_company_brain_docs",
        execution_result: {
          ok: true,
          data: {
            answer: "這是 answer edge 的回答",
            sources: ["來源 A"],
            limitations: [],
          },
        },
      };
    },
    async executeCapabilityLane(args) {
      laneCalls.push(args);
      return {
        text: "這不應該被用到",
      };
    },
  });
  const { port } = server.address();

  const { body } = await postPluginDispatch(port, {
    request_text: "幫我比較 Scanoo onboarding funnel 差異",
    session_id: "sess_explicit_knowledge",
    chat_id: "chat_explicit_knowledge",
    user_id: "user_knowledge",
    account_id: "acct-knowledge",
    source: "official_lark_plugin",
    tool_name: "lark_kb_answer",
    requested_capability: "knowledge_answer",
    capability_source: "explicit",
    route_request: {
      path: "/answer?q=Scanoo",
      method: "GET",
      body: null,
    },
  });

  assert.equal(body.route_target, "knowledge_answer");
  assert.equal(body.chosen_lane, "knowledge-assistant");
  assert.equal(plannerCalls.length, 1);
  assert.equal(laneCalls.length, 0);
});

test("lark plugin dispatch route sends lane_style requests through the existing lane path and prefers thread session keys", async (t) => {
  const laneCalls = [];
  const { server, calls } = await startTestServer(t, {
    async executeCapabilityLane(args) {
      laneCalls.push(args);
      return {
        text: "這是 lane backend 的回答",
      };
    },
  });
  const { port } = server.address();

  const { response, body } = await postPluginDispatch(port, {
    request_text: "幫我分析 Scanoo onboarding funnel 的問題",
    session_id: "sess_low_priority",
    thread_id: "thr_priority",
    chat_id: "chat_fallback",
    user_id: "user_1",
    account_id: "acct-1",
    source: "official_lark_plugin",
    tool_name: "lark_kb_answer",
    requested_capability: "lane_style_capability",
    route_request: {
      path: "/answer?q=Scanoo",
      method: "GET",
      body: null,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.route_target, "lane_backend");
  assert.equal(body.final_status, "completed");
  assert.equal(body.chosen_skill, "lane_style_capability");
  assert.equal(body.fallback_reason, "lane_style_capability");
  assert.equal(body.response.data.answer, "這是 lane backend 的回答");
  assert.equal(laneCalls.length, 1);
  assert.equal(laneCalls[0].scope.session_key, "thread:thr_priority");
  assert.equal(calls.some((entry) => entry[1]?.event === "lark_plugin_dispatch_completed" && entry[1]?.fallback_reason === "lane_style_capability"), true);
});

test("lark plugin dispatch route sends explicit scanoo compare capability through the dedicated compare lane", async (t) => {
  const plannerCalls = [];
  const laneCalls = [];
  const { server, calls } = await startTestServer(t, {
    async executePlannedUserInput(args) {
      plannerCalls.push(args);
      return {
        ok: true,
        execution_result: {
          ok: true,
          data: {
            answer: "planner should stay unused",
            sources: [],
            limitations: [],
          },
        },
      };
    },
    async executeCapabilityLane(args) {
      laneCalls.push(args);
      return {
        text: "這是 scanoo lane backend 的回答",
      };
    },
  });
  const { port } = server.address();

  const { body } = await postPluginDispatch(port, {
    request_text: "公司 SOP 在哪裡？",
    session_id: "sess_scanoo_compare",
    chat_id: "chat_scanoo_compare",
    user_id: "user_scanoo",
    account_id: "acct-scanoo",
    source: "official_lark_plugin",
    tool_name: "lark_kb_answer",
    requested_capability: "scanoo_compare",
    capability_source: "explicit",
    route_request: {
      path: "/answer?q=SOP",
      method: "GET",
      body: null,
    },
  });

  assert.equal(body.route_target, "lane_backend");
  assert.equal(body.requested_capability, "scanoo_compare");
  assert.equal(body.mapped_lane, "scanoo-compare");
  assert.equal(body.chosen_skill, "scanoo_compare");
  assert.equal(body.chosen_lane, "scanoo-compare");
  assert.equal(body.lane_mapping_source, "explicit");
  assert.equal(body.fallback_reason, null);
  assert.equal(body.response.data.answer, "這是 scanoo lane backend 的回答");
  assert.equal(plannerCalls.length, 0);
  assert.equal(laneCalls.length, 1);
  assert.equal(laneCalls[0].scope.capability_lane, "scanoo-compare");
  assert.equal(calls.some((entry) => (
    entry[1]?.event === "lark_plugin_dispatch_started"
    && entry[1]?.capability_source === "explicit"
    && entry[1]?.lane_mapping_source === "explicit"
  )), true);
});

test("lark plugin dispatch route maps explicit scanoo_diagnose into the dedicated diagnose lane", async (t) => {
  const plannerCalls = [];
  const laneCalls = [];
  const { server, calls } = await startTestServer(t, {
    async executePlannedUserInput(args) {
      plannerCalls.push(args);
      return {
        ok: true,
        execution_result: {
          ok: true,
          data: {
            answer: "planner should stay unused",
            sources: [],
            limitations: [],
          },
        },
      };
    },
    async executeCapabilityLane(args) {
      laneCalls.push(args);
      return {
        text: "這是 scanoo diagnose lane 的回答",
      };
    },
  });
  const { port } = server.address();

  const { body } = await postPluginDispatch(port, {
    request_text: "請幫我診斷 Scanoo onboarding funnel 的掉轉換原因",
    session_id: "sess_scanoo_diagnose",
    chat_id: "chat_scanoo_diagnose",
    user_id: "user_scanoo_diag",
    account_id: "acct-scanoo",
    source: "official_lark_plugin",
    tool_name: "lark_kb_answer",
    requested_capability: "scanoo_diagnose",
    capability_source: "explicit",
    route_request: {
      path: "/answer?q=Scanoo%20diagnose",
      method: "GET",
      body: null,
    },
  });

  assert.equal(body.route_target, "lane_backend");
  assert.equal(body.requested_capability, "scanoo_diagnose");
  assert.equal(body.mapped_lane, "scanoo-diagnose");
  assert.equal(body.chosen_skill, "scanoo_diagnose");
  assert.equal(body.chosen_lane, "scanoo-diagnose");
  assert.equal(body.lane_mapping_source, "explicit");
  assert.equal(body.fallback_reason, null);
  assert.equal(body.response.data.answer, "這是 scanoo diagnose lane 的回答");
  assert.equal(plannerCalls.length, 0);
  assert.equal(laneCalls.length, 1);
  assert.equal(laneCalls[0].scope.capability_lane, "scanoo-diagnose");
  assert.equal(calls.some((entry) => (
    entry[1]?.event === "lark_plugin_dispatch_completed"
    && entry[1]?.requested_capability === "scanoo_diagnose"
    && entry[1]?.lane_mapping_source === "explicit"
  )), true);
});

test("lark plugin dispatch route keeps explicit auth, doc refs, and compare objects on lane handoff", async (t) => {
  const laneCalls = [];
  const { server } = await startTestServer(t, {
    async executeCapabilityLane(args) {
      laneCalls.push(args);
      return {
        text: "這是帶 context 的 lane 回答",
      };
    },
  });
  const { port } = server.address();

  const { body } = await postPluginDispatch(port, {
    request_text: "比較北極星店和月光店的 onboarding funnel",
    session_id: "sess_context",
    thread_id: "thr_context",
    chat_id: "chat_context",
    user_id: "user_context",
    account_id: "acct-context",
    user_access_token: "event-user-token-context",
    source: "official_lark_plugin",
    tool_name: "lark_kb_answer",
    requested_capability: "scanoo_compare",
    capability_source: "explicit",
    plugin_context: {
      explicit_auth: {
        account_id: "acct-context",
        access_token: "event-user-token-context",
        source: "plugin_dispatch_params",
      },
      document_refs: [
        {
          document_id: "doc_context_1",
          title: "Scanoo Compare SOP",
        },
      ],
      compare_objects: [
        { name: "北極星店", metric: "activation" },
        { name: "月光店", metric: "activation" },
      ],
    },
    route_request: {
      path: "/answer?q=compare",
      method: "POST",
      body: {
        document_id: "doc_context_1",
      },
    },
  });

  assert.equal(body.response.data.answer, "這是帶 context 的 lane 回答");
  assert.equal(laneCalls.length, 1);
  assert.equal(laneCalls[0].event.user_access_token, "event-user-token-context");
  assert.equal(laneCalls[0].event.context.user_access_token, "event-user-token-context");
  assert.equal(extractDocumentId(laneCalls[0].event), "doc_context_1");
  assert.equal(JSON.parse(laneCalls[0].event.message.content).compare_objects[0].name, "北極星店");
  assert.equal(laneCalls[0].event.__lobster_plugin_dispatch.plugin_context.document_refs[0].document_id, "doc_context_1");
});

test("lark plugin dispatch route lets lane backend return a bounded fallback before the hard timeout", async (t) => {
  const { server } = await startTestServer(t, {
    async executeCapabilityLane({ signal }) {
      await new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", resolve, { once: true });
      });
      return {
        text: [
          "【比較對象】",
          "我先保住這輪比較需求，先回一個 bounded fallback。",
          "",
          "【比較維度】",
          "- onboarding funnel",
        ].join("\n"),
      };
    },
  }, {
    requestTimeoutMs: 80,
  });
  const { port } = server.address();

  const { response, body } = await postPluginDispatch(port, {
    request_text: "比較北極星店和月光店的 onboarding funnel",
    session_id: "sess_timeout",
    chat_id: "chat_timeout",
    user_id: "user_timeout",
    account_id: "acct-timeout",
    source: "official_lark_plugin",
    tool_name: "lark_kb_answer",
    requested_capability: "scanoo_compare",
    capability_source: "explicit",
    route_request: {
      path: "/answer?q=compare",
      method: "GET",
      body: null,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.final_status, "completed");
  assert.match(body.response.data.answer, /bounded fallback/);
});
