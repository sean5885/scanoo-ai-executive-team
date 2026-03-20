import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { startHttpServer } from "../src/http-server.mjs";
import { docUpdateConfirmationStorePath, executiveImprovementStorePath } from "../src/config.mjs";
import { setupExecutiveTaskStateTestHarness } from "./helpers/executive-task-state-harness.mjs";

setupExecutiveTaskStateTestHarness();

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
    getValidUserToken: async () => ({ access_token: "token-1", account_id: "acct-1" }),
    getStoredAccountContext: async () => ({ account: { id: "acct-1" } }),
    ...overrides,
  };
}

async function startTestServer(t, serviceOverrides) {
  const sink = createLoggerSink();
  const server = startHttpServer({
    listen: false,
    logger: sink.logger,
    serviceOverrides: createAuthorizedOverrides(serviceOverrides),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
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

test("document create classifies verified mirror ingest as direct intake", async (t) => {
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
  const createResponse = await fetch(`http://127.0.0.1:${port}/api/doc/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const createPayload = await createResponse.json();
  assert.equal(createResponse.status, 200);
  assert.equal(createPayload.document_id, documentId);
  console.log("direct-calls", JSON.stringify(calls.slice(-8), null, 2));

  const boundaryLog = calls.find((entry) => entry[1]?.event === "document_company_brain_intake_classified");
  assert.equal(boundaryLog?.[1]?.doc_id, documentId);
  assert.equal(boundaryLog?.[1]?.direct_intake_allowed, true);
  assert.equal(boundaryLog?.[1]?.review_required, false);
  assert.equal(boundaryLog?.[1]?.conflict_check_required, false);

  const ingestedLog = calls.find((entry) => entry[1]?.event === "document_company_brain_ingested");
  assert.equal(ingestedLog?.[1]?.doc_id, documentId);
  assert.equal(ingestedLog?.[1]?.source, "api");
});

test("document create classifies title overlap as review and conflict check required", async (t) => {
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
    const response = await fetch(`http://127.0.0.1:${port}/api/doc/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    assert.equal(response.status, 200);
  }
  console.log("overlap-calls", JSON.stringify(calls.slice(-12), null, 2));

  const overlapBoundaryLog = calls
    .filter((entry) => entry[1]?.event === "document_company_brain_intake_classified")
    .at(-1);
  assert.equal(overlapBoundaryLog?.[1]?.review_required, true);
  assert.equal(overlapBoundaryLog?.[1]?.conflict_check_required, true);
  assert.equal(overlapBoundaryLog?.[1]?.matched_docs?.length, 1);
  assert.equal(overlapBoundaryLog?.[1]?.matched_docs?.[0]?.match_type, "same_title");
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
      document_id: "doc-1",
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
      document_id: "doc-1",
      content: "New line",
      target_heading: "第二部分",
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
