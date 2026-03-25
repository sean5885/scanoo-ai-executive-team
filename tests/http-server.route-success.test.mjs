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
] = await Promise.all([
  import("../src/http-idempotency-store.mjs"),
  import("../src/http-server.mjs"),
  import("../src/config.mjs"),
  import("./helpers/executive-task-state-harness.mjs"),
  import("../src/explicit-user-auth.mjs"),
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
  return {
    getValidUserTokenState: async () => ({
      status: "valid",
      token: { access_token: "token-1", account_id: "acct-1" },
      account: { id: "acct-1" },
      refreshed: false,
      error: null,
    }),
    getStoredAccountContext: async () => ({ account: { id: "acct-1" } }),
    ...overrides,
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

async function startTestServer(t, serviceOverrides) {
  ensureTestAccount("acct-1");
  const sink = createLoggerSink();
  const server = startHttpServer({
    listen: false,
    logger: sink.logger,
    serviceOverrides: createAuthorizedOverrides(serviceOverrides),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return { server, calls: sink.calls };
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

test("document create preview/confirm keeps 200 response when initial content write fails after create", async (t) => {
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
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.document_id, documentId);
  assert.equal(updateCalls, 1);
  assert.equal(payload.write_result, null);
  assert.equal(payload.initial_content_write_failed, true);
  assert.equal(payload.initial_content_write_error?.http_status, 400);
  assert.equal(payload.initial_content_write_error?.platform_msg, "invalid block parent");

  const lifecycleRow = db.prepare(
    "SELECT raw_text, status, failure_reason FROM lark_documents WHERE account_id = ? AND document_id = ?",
  ).get("acct-1", documentId);
  assert.equal(lifecycleRow?.raw_text, null);
  assert.equal(lifecycleRow?.status, "verified");
  assert.equal(lifecycleRow?.failure_reason, null);

  const writeFailureLog = calls.find((entry) => entry[1]?.event === "document_create_initial_content_write_failed");
  assert.equal(writeFailureLog?.[1]?.document_id, documentId);
  assert.equal(writeFailureLog?.[1]?.http_status, 400);
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
  t.after(async () => {
    await restoreFile(docUpdateConfirmationStorePath, snapshot);
  });

  const calls = [];
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
      document_url: "https://larksuite.com/docx/doc-1",
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
      document_id: "doc-1",
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
    documentId: "doc-1",
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
