import http from "node:http";
import {
  oauthBaseUrl,
  oauthCallbackPath,
  oauthPort,
  searchTopK,
} from "./config.mjs";
import { resolveLarkBindingRuntime } from "./binding-runtime.mjs";
import {
  buildAuthorizeUrl,
  buildOAuthState,
  exchangeCodeForUserToken,
  getStoredAccountContext,
  getStoredUserToken,
  getUserProfile,
  getValidUserToken,
} from "./lark-user-auth.mjs";
import {
  bulkUpsertBitableRecords,
  checkDriveTask,
  createBitableApp,
  createBitableRecord,
  createBitableTable,
  createCalendarEvent,
  createDocument,
  createDriveFolder,
  createMessageReaction,
  createSpreadsheet,
  createTask,
  createTaskComment,
  deleteBitableRecord,
  deleteDriveItem,
  deleteMessageReaction,
  deleteTaskComment,
  getMessage,
  getPrimaryCalendar,
  getBitableApp,
  getBitableRecord,
  getSpreadsheet,
  getSpreadsheetSheet,
  getTask,
  getTaskComment,
  getDocument,
  listDriveFolder,
  listDriveRoot,
  listCalendarEvents,
  listBitableRecords,
  listBitableTables,
  listFreebusy,
  listMessages,
  listMessageReactions,
  listSpreadsheetSheets,
  listTasks,
  listTaskComments,
  moveDriveItem,
  replyMessage,
  replaceSpreadsheetCells,
  replaceSpreadsheetCellsBatch,
  resolveDriveRootFolderToken,
  searchCalendarEvents,
  searchBitableRecords,
  searchMessages,
  createWikiNode,
  listWikiSpaceNodes,
  listWikiSpaces,
  moveWikiNode,
  updateBitableApp,
  updateBitableRecord,
  updateDocument,
  updateSpreadsheet,
  updateTaskComment,
  listDocumentComments,
} from "./lark-content.mjs";
import { answerQuestion, searchKnowledgeBase } from "./answer-service.mjs";
import { applyRewrittenDocument, rewriteDocumentFromComments } from "./doc-comment-rewrite.mjs";
import { listUnseenDocumentComments, markDocumentCommentsSeen } from "./comment-watch-store.mjs";
import { generateDocumentCommentSuggestionCard } from "./comment-suggestion-workflow.mjs";
import { runCommentSuggestionPollOnce } from "./comment-suggestion-poller.mjs";
import {
  consumeCommentRewriteConfirmation,
  consumeDocumentReplaceConfirmation,
  createCommentRewriteConfirmation,
  createDocumentReplaceConfirmation,
} from "./doc-update-confirmations.mjs";
import {
  executeSecureAction,
  finishSecureTask,
  getSecurityStatus,
  listPendingApprovals,
  resolvePendingApproval,
  rollbackSecureTask,
  startSecureTask,
} from "./lobster-security-bridge.mjs";
import { runSync } from "./lark-sync-service.mjs";
import { applyDriveOrganization, previewDriveOrganization } from "./lark-drive-organizer.mjs";
import { applyWikiOrganization, previewWikiOrganization } from "./lark-wiki-organizer.mjs";
import { getAllowedMethodsForPath } from "./http-route-contracts.mjs";
import { listResolvedSessions } from "./session-scope-store.mjs";

const pendingOauthStates = new Map();

function cleanupOauthStates() {
  const cutoff = Date.now() - 10 * 60 * 1000;

  for (const [state, createdAt] of pendingOauthStates.entries()) {
    if (createdAt < cutoff) {
      pendingOauthStates.delete(state);
    }
  }
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function htmlResponse(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(html);
}

function methodNotAllowed(res, allowedMethods) {
  res.writeHead(405, {
    "Content-Type": "application/json; charset=utf-8",
    Allow: allowedMethods.join(", "),
  });
  res.end(`${JSON.stringify({
    ok: false,
    error: "method_not_allowed",
    allowed_methods: allowedMethods,
  }, null, 2)}\n`);
}

async function readJsonBody(req) {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") {
    return {};
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function resolveAccountContext(accountId) {
  const validToken = await getValidUserToken(accountId);
  if (!validToken?.access_token) {
    return null;
  }

  const context = await getStoredAccountContext(validToken.account_id || accountId);
  if (!context?.account) {
    return null;
  }

  return {
    account: context.account,
    token: validToken,
  };
}

async function requireUserContext(res, accountId) {
  const context = await resolveAccountContext(accountId);
  if (!context?.token?.access_token) {
    jsonResponse(res, 401, {
      ok: false,
      error: "missing_user_access_token",
      login_url: `${oauthBaseUrl}/oauth/lark/login`,
      message: "Open the login URL first to grant Lobster access to your Lark account.",
    });
    return null;
  }

  return context;
}

function getAccountId(requestUrl, body) {
  return requestUrl.searchParams.get("account_id") || body.account_id || undefined;
}

async function handleAuthStatus(res, accountId) {
  const stored = await getStoredUserToken(accountId);
  if (!stored?.access_token) {
    jsonResponse(res, 200, {
      ok: false,
      authorized: false,
      login_url: `${oauthBaseUrl}/oauth/lark/login`,
    });
    return;
  }

  const context = await resolveAccountContext(accountId);
  if (!context) {
    jsonResponse(res, 200, {
      ok: false,
      authorized: false,
      login_url: `${oauthBaseUrl}/oauth/lark/login`,
      message: "Stored token is expired and could not be refreshed.",
    });
    return;
  }

  const profile = await getUserProfile(context.token.access_token);
  jsonResponse(res, 200, {
    ok: true,
    authorized: true,
    account_id: context.account.id,
    scope: context.token.scope,
    expires_at: context.token.expires_at,
    user: {
      name: profile.name,
      open_id: profile.open_id,
      union_id: profile.union_id,
      user_id: profile.user_id,
      email: profile.email || profile.enterprise_email,
    },
  });
}

async function handleRuntimeResolveScopes(res, body) {
  const scope = resolveLarkBindingRuntime(body || {});
  jsonResponse(res, 200, {
    ok: true,
    action: "runtime_resolve_scopes",
    ...scope,
  });
}

async function handleRuntimeSessions(res) {
  const sessions = await listResolvedSessions();
  jsonResponse(res, 200, {
    ok: true,
    action: "runtime_sessions_list",
    total: sessions.length,
    items: sessions,
  });
}

async function handleSync(res, requestUrl, body, mode) {
  const accountId = getAccountId(requestUrl, body);
  const context = await requireUserContext(res, accountId);
  if (!context) {
    return;
  }

  const summary = await runSync({
    account: context.account,
    accessToken: context.token.access_token,
    mode,
  });

  jsonResponse(res, 200, {
    ok: true,
    ...summary,
  });
}

async function handleDriveList(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const folderToken = requestUrl.searchParams.get("folder_token") || body.folder_token || undefined;
  const pageToken = requestUrl.searchParams.get("page_token") || body.page_token || undefined;
  const data = folderToken
    ? await listDriveFolder(context.token.access_token, folderToken, pageToken)
    : await listDriveRoot(context.token.access_token, pageToken);

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    source: "drive.v1.files",
    folder_token: folderToken || null,
    ...data,
  });
}

async function handleDriveCreateFolder(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const folderToken = String(body.folder_token || "").trim();
  const name = String(body.name || "").trim();

  if (!folderToken || !name) {
    jsonResponse(res, 400, { ok: false, error: "missing_folder_token_or_name" });
    return;
  }

  const result = await createDriveFolder(context.token.access_token, folderToken, name);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "create_folder",
    ...result,
  });
}

async function handleDriveMove(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const fileToken = String(body.file_token || "").trim();
  const folderToken = String(body.folder_token || "").trim();
  const type = String(body.type || "").trim();

  if (!fileToken || !folderToken || !type) {
    jsonResponse(res, 400, { ok: false, error: "missing_file_token_type_or_folder_token" });
    return;
  }

  const result = await moveDriveItem(context.token.access_token, fileToken, type, folderToken);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "move",
    ...result,
  });
}

async function handleDriveTaskStatus(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const taskId = requestUrl.searchParams.get("task_id") || body.task_id || "";
  if (!String(taskId).trim()) {
    jsonResponse(res, 400, { ok: false, error: "missing_task_id" });
    return;
  }

  const result = await checkDriveTask(context.token.access_token, String(taskId));
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_status",
    ...result,
  });
}

async function handleDriveDelete(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const fileToken = String(body.file_token || "").trim();
  const type = String(body.type || "").trim();

  if (!fileToken || !type) {
    jsonResponse(res, 400, { ok: false, error: "missing_file_token_or_type" });
    return;
  }

  const result = await deleteDriveItem(context.token.access_token, fileToken, type);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "delete",
    ...result,
  });
}

async function handleDriveOrganize(res, requestUrl, body, apply) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  let folderToken = String(body.folder_token || requestUrl.searchParams.get("folder_token") || "").trim();
  if (!folderToken) {
    folderToken = await resolveDriveRootFolderToken(context.token.access_token) || "";
  }
  if (!folderToken) {
    jsonResponse(res, 400, { ok: false, error: "missing_folder_token" });
    return;
  }

  const options = {
    recursive: body.recursive !== false && requestUrl.searchParams.get("recursive") !== "false",
    includeFolders: body.include_folders === true || requestUrl.searchParams.get("include_folders") === "true",
    accountId: context.account.id,
  };

  const result = apply
    ? await applyDriveOrganization(context.token.access_token, folderToken, options)
    : await previewDriveOrganization(context.token.access_token, folderToken, options);

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: apply ? "organize_apply" : "organize_preview",
    ...result,
  });
}

async function handleWikiCreateNode(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const spaceId = String(body.space_id || "").trim();
  const title = String(body.title || "").trim();
  const parentNodeToken = String(body.parent_node_token || "").trim() || undefined;

  if (!spaceId || !title) {
    jsonResponse(res, 400, { ok: false, error: "missing_space_id_or_title" });
    return;
  }

  const result = await createWikiNode(context.token.access_token, spaceId, title, parentNodeToken);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "create_wiki_node",
    ...result,
  });
}

async function handleWikiMove(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const spaceId = String(body.space_id || "").trim();
  const nodeToken = String(body.node_token || "").trim();
  const targetParentToken = String(body.target_parent_token || "").trim();
  const targetSpaceId = String(body.target_space_id || "").trim() || undefined;

  if (!spaceId || !nodeToken || !targetParentToken) {
    jsonResponse(res, 400, { ok: false, error: "missing_space_id_node_token_or_target_parent_token" });
    return;
  }

  const result = await moveWikiNode(
    context.token.access_token,
    spaceId,
    nodeToken,
    targetParentToken,
    targetSpaceId,
  );
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "move_wiki_node",
    ...result,
  });
}

async function handleWikiOrganize(res, requestUrl, body, apply) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const options = {
    spaceId: String(body.space_id || requestUrl.searchParams.get("space_id") || "").trim() || undefined,
    spaceName: String(body.space_name || requestUrl.searchParams.get("space_name") || "").trim() || undefined,
    parentNodeToken:
      String(body.parent_node_token || requestUrl.searchParams.get("parent_node_token") || "").trim() || undefined,
    recursive: body.recursive === true || requestUrl.searchParams.get("recursive") === "true",
    includeContainers:
      body.include_containers === true || requestUrl.searchParams.get("include_containers") === "true",
    accountId: context.account.id,
  };

  const result = apply
    ? await applyWikiOrganization(context.token.access_token, options)
    : await previewWikiOrganization(context.token.access_token, options);

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: apply ? "wiki_organize_apply" : "wiki_organize_preview",
    ...result,
  });
}

async function handleDocumentRead(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const documentId = String(
    requestUrl.searchParams.get("document_id") || body.document_id || body.doc_token || "",
  ).trim();
  if (!documentId) {
    jsonResponse(res, 400, { ok: false, error: "missing_document_id" });
    return;
  }

  const result = await getDocument(context.token.access_token, documentId);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "document_read",
    ...result,
  });
}

async function handleDocumentCreate(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const title = String(body.title || "").trim();
  const folderToken = String(body.folder_token || "").trim() || undefined;
  const content = String(body.content || "").trim();

  if (!title) {
    jsonResponse(res, 400, { ok: false, error: "missing_document_title" });
    return;
  }

  const created = await createDocument(context.token.access_token, title, folderToken);
  let writeResult = null;
  if (content && created.document_id) {
    writeResult = await updateDocument(context.token.access_token, created.document_id, content, "replace");
  }

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "document_create",
    ...created,
    write_result: writeResult,
  });
}

async function handleDocumentUpdate(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const documentId = String(body.document_id || body.doc_token || "").trim();
  const content = String(body.content || "").trim();
  const mode = String(body.mode || "append").trim() === "replace" ? "replace" : "append";
  const confirm = body.confirm === true;
  const confirmationId = String(body.confirmation_id || "").trim();

  if (!documentId || !content) {
    jsonResponse(res, 400, { ok: false, error: "missing_document_id_or_content" });
    return;
  }

  if (mode === "replace") {
    const current = await getDocument(context.token.access_token, documentId);

    if (!confirm) {
      const preview = await createDocumentReplaceConfirmation({
        accountId: context.account.id,
        documentId,
        title: current.title,
        currentRevisionId: current.revision_id,
        currentContent: current.content,
        proposedContent: content,
      });

      jsonResponse(res, 200, {
        ok: true,
        account_id: context.account.id,
        auth_mode: "user_access_token",
        action: "document_update_replace_preview",
        preview_required: true,
        message: "Replace mode needs explicit confirmation. Re-submit with confirm=true and confirmation_id.",
        ...preview,
      });
      return;
    }

    if (!confirmationId) {
      jsonResponse(res, 400, {
        ok: false,
        error: "missing_confirmation_id",
        message: "Replace mode requires confirmation_id when confirm=true.",
      });
      return;
    }

    const confirmation = await consumeDocumentReplaceConfirmation({
      confirmationId,
      accountId: context.account.id,
      documentId,
      proposedContent: content,
    });

    if (!confirmation) {
      jsonResponse(res, 400, {
        ok: false,
        error: "invalid_or_expired_confirmation",
        message: "The replace confirmation is missing, expired, or no longer matches this document/content.",
      });
      return;
    }

    if (
      confirmation.current_revision_id &&
      current.revision_id &&
      confirmation.current_revision_id !== current.revision_id
    ) {
      jsonResponse(res, 409, {
        ok: false,
        error: "stale_confirmation",
        message: "The document changed after preview. Create a new replace preview first.",
        current_revision_id: current.revision_id,
      });
      return;
    }
  }

  const result = await updateDocument(context.token.access_token, documentId, content, mode);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: mode === "replace" ? "document_update_replace_apply" : "document_update",
    ...result,
  });
}

async function handleDocumentComments(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const documentId = String(
    requestUrl.searchParams.get("document_id") || body.document_id || body.doc_token || "",
  ).trim();
  if (!documentId) {
    jsonResponse(res, 400, { ok: false, error: "missing_document_id" });
    return;
  }

  const includeSolved = String(requestUrl.searchParams.get("include_solved") || body.include_solved || "").trim();
  const result = await listDocumentComments(context.token.access_token, documentId, {
    fileType: "docx",
    isSolved:
      includeSolved === "true"
        ? undefined
        : false,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "document_comments",
    ...result,
  });
}

async function handleDocumentRewriteFromComments(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const documentId = String(body.document_id || body.doc_token || "").trim();
  if (!documentId) {
    jsonResponse(res, 400, { ok: false, error: "missing_document_id" });
    return;
  }

  const commentIds = Array.isArray(body.comment_ids)
    ? body.comment_ids.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const apply = body.apply === true;
  const confirm = body.confirm === true;
  const confirmationId = String(body.confirmation_id || "").trim();
  const resolveComments = Boolean(body.resolve_comments);

  if (!apply) {
    const current = await getDocument(context.token.access_token, documentId);
    const result = await rewriteDocumentFromComments(context.token.access_token, documentId, {
      includeSolved: Boolean(body.include_solved),
      commentIds,
      apply: false,
      resolveComments,
    });
    if (!result.comment_count) {
      jsonResponse(res, 200, {
        ok: true,
        account_id: context.account.id,
        auth_mode: "user_access_token",
        action: "document_rewrite_from_comments_preview",
        ...result,
      });
      return;
    }
    const confirmation = await createCommentRewriteConfirmation({
      accountId: context.account.id,
      documentId,
      title: result.title,
      currentRevisionId: current.revision_id,
      currentContent: current.content,
      rewrittenContent: result.revised_content || "",
      patchPlan: result.patch_plan || [],
      changeSummary: result.change_summary || [],
      commentIds: result.comment_ids || commentIds,
      comments: result.comments || [],
      resolveComments,
    });

    jsonResponse(res, 200, {
      ok: true,
      account_id: context.account.id,
      auth_mode: "user_access_token",
      action: "document_rewrite_from_comments_preview",
      preview_required: true,
      ...result,
      confirmation_id: confirmation.confirmation_id,
      confirmation_type: confirmation.confirmation_type,
      confirmation_expires_at: confirmation.expires_at,
      rewrite_preview: confirmation.preview,
      rewrite_preview_card: confirmation.preview_card,
    });
    return;
  }

  if (!confirm || !confirmationId) {
    jsonResponse(res, 400, {
      ok: false,
      error: "missing_comment_rewrite_confirmation",
      message: "Apply mode requires confirm=true and a valid confirmation_id from the preview step.",
    });
    return;
  }

  const current = await getDocument(context.token.access_token, documentId);
  const confirmation = await consumeCommentRewriteConfirmation({
    confirmationId,
    accountId: context.account.id,
    documentId,
  });
  if (!confirmation) {
    jsonResponse(res, 400, {
      ok: false,
      error: "invalid_or_expired_confirmation",
      message: "The rewrite confirmation is missing or expired. Generate a fresh preview first.",
    });
    return;
  }
  if (
    confirmation.current_revision_id &&
    current.revision_id &&
    confirmation.current_revision_id !== current.revision_id
  ) {
    jsonResponse(res, 409, {
      ok: false,
      error: "stale_confirmation",
      message: "The document changed after preview. Generate a fresh rewrite preview first.",
      current_revision_id: current.revision_id,
    });
    return;
  }

  const applied = await applyRewrittenDocument(
    context.token.access_token,
    documentId,
    confirmation.rewritten_content,
    {
      patchPlan: confirmation.patch_plan || [],
      resolveCommentIds: confirmation.resolve_comments ? confirmation.comment_ids : [],
    },
  );

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "document_rewrite_from_comments_apply",
    document_id: documentId,
    applied: true,
    resolve_comments: Boolean(confirmation.resolve_comments),
    change_summary: confirmation.change_summary || [],
    update_result: applied.update_result,
    resolved_comment_ids: applied.resolved_comment_ids,
  });
}

async function handleDocumentCommentSuggestionCard(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const documentId = String(body.document_id || body.doc_token || "").trim();
  if (!documentId) {
    jsonResponse(res, 400, { ok: false, error: "missing_document_id" });
    return;
  }

  const result = await generateDocumentCommentSuggestionCard({
    accessToken: context.token.access_token,
    accountId: context.account.id,
    documentId,
    messageId: String(body.message_id || body.notify_message_id || "").trim(),
    replyInThread: body.reply_in_thread === true,
    resolveComments: Boolean(body.resolve_comments),
    markSeen: body.mark_seen !== false,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "document_comment_suggestion_card",
    ...result,
  });
}

async function handleDocumentCommentSuggestionPoll(res) {
  const result = await runCommentSuggestionPollOnce();
  jsonResponse(res, 200, result);
}

async function handleMessagesList(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const containerId = String(requestUrl.searchParams.get("container_id") || body.container_id || "").trim();
  const containerIdType = String(
    requestUrl.searchParams.get("container_id_type") || body.container_id_type || "chat",
  ).trim();

  if (!containerId) {
    jsonResponse(res, 400, { ok: false, error: "missing_container_id" });
    return;
  }

  const result = await listMessages(context.token.access_token, containerId, {
    containerIdType,
    startTime: requestUrl.searchParams.get("start_time") || body.start_time || undefined,
    endTime: requestUrl.searchParams.get("end_time") || body.end_time || undefined,
    sortType: requestUrl.searchParams.get("sort_type") || body.sort_type || undefined,
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "messages_list",
    ...result,
  });
}

async function handleMessageSearch(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const containerId = String(requestUrl.searchParams.get("container_id") || body.container_id || "").trim();
  const keyword = String(requestUrl.searchParams.get("q") || body.q || body.keyword || "").trim();
  const containerIdType = String(
    requestUrl.searchParams.get("container_id_type") || body.container_id_type || "chat",
  ).trim();
  const limit = Number.parseInt(requestUrl.searchParams.get("limit") || body.limit || "20", 10);

  if (!containerId || !keyword) {
    jsonResponse(res, 400, { ok: false, error: "missing_container_id_or_query" });
    return;
  }

  const result = await searchMessages(context.token.access_token, containerId, keyword, {
    containerIdType,
    startTime: requestUrl.searchParams.get("start_time") || body.start_time || undefined,
    endTime: requestUrl.searchParams.get("end_time") || body.end_time || undefined,
    sortType: requestUrl.searchParams.get("sort_type") || body.sort_type || undefined,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 50)) : 20,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "messages_search",
    ...result,
  });
}

async function handleMessageGet(res, requestUrl, body, messageId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const result = await getMessage(context.token.access_token, messageId);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "message_get",
    ...result,
  });
}

async function handleMessageReply(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const messageId = String(body.message_id || "").trim();
  const content = String(body.content || body.text || "").trim();
  const replyInThread = body.reply_in_thread === true;
  const cardTitle = typeof body.card_title === "string" ? body.card_title.trim() : undefined;

  if (!messageId || !content) {
    jsonResponse(res, 400, { ok: false, error: "missing_message_id_or_content" });
    return;
  }

  const result = await replyMessage(context.token.access_token, messageId, content, {
    replyInThread,
    cardTitle,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: cardTitle ? "message_reply_card" : "message_reply",
    ...result,
  });
}

async function handleCalendarPrimary(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const result = await getPrimaryCalendar(context.token.access_token);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "calendar_primary",
    ...result,
  });
}

async function handleCalendarEvents(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const calendarId = String(requestUrl.searchParams.get("calendar_id") || body.calendar_id || "").trim();
  if (!calendarId) {
    jsonResponse(res, 400, { ok: false, error: "missing_calendar_id" });
    return;
  }

  const result = await listCalendarEvents(context.token.access_token, calendarId, {
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
    startTime: requestUrl.searchParams.get("start_time") || body.start_time || undefined,
    endTime: requestUrl.searchParams.get("end_time") || body.end_time || undefined,
    anchorTime: requestUrl.searchParams.get("anchor_time") || body.anchor_time || undefined,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "calendar_events",
    ...result,
  });
}

async function handleCalendarSearch(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const calendarId = String(body.calendar_id || requestUrl.searchParams.get("calendar_id") || "").trim();
  const query = String(body.q || body.query || requestUrl.searchParams.get("q") || "").trim();
  if (!calendarId || !query) {
    jsonResponse(res, 400, { ok: false, error: "missing_calendar_id_or_query" });
    return;
  }

  const result = await searchCalendarEvents(context.token.access_token, calendarId, query);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "calendar_search",
    ...result,
  });
}

async function handleCalendarCreateEvent(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const calendarId = String(body.calendar_id || "").trim();
  const summary = String(body.summary || "").trim();
  const startTime = String(body.start_time || "").trim();
  const endTime = String(body.end_time || "").trim();

  if (!calendarId || !summary || !startTime || !endTime) {
    jsonResponse(res, 400, { ok: false, error: "missing_calendar_id_summary_start_time_or_end_time" });
    return;
  }

  const reminders = Array.isArray(body.reminders)
    ? body.reminders.map((value) => Number.parseInt(`${value}`, 10)).filter(Number.isFinite)
    : [];

  const result = await createCalendarEvent(context.token.access_token, calendarId, {
    summary,
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    startTime,
    endTime,
    timezone: typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : "Asia/Taipei",
    reminders,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "calendar_create_event",
    ...result,
  });
}

async function handleTasksList(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const completedParam = requestUrl.searchParams.get("completed");
  const completed =
    typeof body.completed === "boolean"
      ? body.completed
      : completedParam === "true"
        ? true
        : completedParam === "false"
          ? false
          : undefined;

  const result = await listTasks(context.token.access_token, {
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
    startCreateTime: requestUrl.searchParams.get("start_create_time") || body.start_create_time || undefined,
    endCreateTime: requestUrl.searchParams.get("end_create_time") || body.end_create_time || undefined,
    completed,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "tasks_list",
    ...result,
  });
}

async function handleTaskGet(res, requestUrl, body, taskId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const result = await getTask(context.token.access_token, taskId);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_get",
    ...result,
  });
}

async function handleTaskCreate(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) {
    return;
  }

  const summary = String(body.summary || "").trim();
  if (!summary) {
    jsonResponse(res, 400, { ok: false, error: "missing_task_summary" });
    return;
  }

  const result = await createTask(context.token.access_token, {
    summary,
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    dueTime: typeof body.due_time === "string" ? body.due_time.trim() : undefined,
    timezone: typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : "Asia/Taipei",
    linkUrl: typeof body.link_url === "string" ? body.link_url.trim() : undefined,
    linkTitle: typeof body.link_title === "string" ? body.link_title.trim() : undefined,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_create",
    ...result,
  });
}

async function handleBitableAppCreate(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const name = String(body.name || "").trim();
  if (!name) {
    jsonResponse(res, 400, { ok: false, error: "missing_bitable_name" });
    return;
  }

  const result = await createBitableApp(context.token.access_token, {
    name,
    folderToken: typeof body.folder_token === "string" ? body.folder_token.trim() : undefined,
    timeZone: typeof body.time_zone === "string" ? body.time_zone.trim() : undefined,
    customizedConfig: typeof body.customized_config === "boolean" ? body.customized_config : undefined,
    sourceAppToken: typeof body.source_app_token === "string" ? body.source_app_token.trim() : undefined,
    copyTypes: Array.isArray(body.copy_types) ? body.copy_types : undefined,
    apiType: typeof body.api_type === "string" ? body.api_type.trim() : undefined,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_app_create",
    ...result,
  });
}

async function handleBitableAppGet(res, requestUrl, body, appToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await getBitableApp(context.token.access_token, appToken);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_app_get",
    ...result,
  });
}

async function handleBitableAppUpdate(res, requestUrl, body, appToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await updateBitableApp(context.token.access_token, appToken, {
    name: typeof body.name === "string" ? body.name.trim() : undefined,
    isAdvanced: typeof body.is_advanced === "boolean" ? body.is_advanced : undefined,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_app_update",
    ...result,
  });
}

async function handleBitableTablesList(res, requestUrl, body, appToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const pageSize = Number.parseInt(requestUrl.searchParams.get("page_size") || body.page_size || "50", 10);
  const result = await listBitableTables(context.token.access_token, appToken, {
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
    pageSize: Number.isFinite(pageSize) ? Math.max(1, Math.min(pageSize, 100)) : 50,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_tables_list",
    ...result,
  });
}

async function handleBitableTableCreate(res, requestUrl, body, appToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const name = String(body.name || "").trim();
  if (!name) {
    jsonResponse(res, 400, { ok: false, error: "missing_table_name" });
    return;
  }

  const result = await createBitableTable(context.token.access_token, appToken, {
    name,
    defaultViewName: typeof body.default_view_name === "string" ? body.default_view_name.trim() : undefined,
    fields: Array.isArray(body.fields) ? body.fields : [],
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_table_create",
    ...result,
  });
}

async function handleBitableRecordsList(res, requestUrl, body, appToken, tableId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const pageSize = Number.parseInt(requestUrl.searchParams.get("page_size") || body.page_size || "50", 10);
  const fieldNames = requestUrl.searchParams.getAll("field_name");
  const result = await listBitableRecords(context.token.access_token, appToken, tableId, {
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
    pageSize: Number.isFinite(pageSize) ? Math.max(1, Math.min(pageSize, 100)) : 50,
    viewId: requestUrl.searchParams.get("view_id") || body.view_id || undefined,
    fieldNames: fieldNames.length ? fieldNames : Array.isArray(body.field_names) ? body.field_names : undefined,
    sort: requestUrl.searchParams.get("sort") || body.sort || undefined,
    filter: requestUrl.searchParams.get("filter") || body.filter || undefined,
    automaticFields: body.automatic_fields === true || requestUrl.searchParams.get("automatic_fields") === "true",
    userIdType: requestUrl.searchParams.get("user_id_type") || body.user_id_type || undefined,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_records_list",
    ...result,
  });
}

async function handleBitableRecordsSearch(res, requestUrl, body, appToken, tableId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await searchBitableRecords(context.token.access_token, appToken, tableId, {
    pageToken: typeof body.page_token === "string" ? body.page_token.trim() : undefined,
    pageSize: Number.isFinite(Number(body.page_size)) ? Math.max(1, Math.min(Number(body.page_size), 100)) : 50,
    viewId: typeof body.view_id === "string" ? body.view_id.trim() : undefined,
    fieldNames: Array.isArray(body.field_names) ? body.field_names : undefined,
    sort: Array.isArray(body.sort) ? body.sort : [],
    filter: body.filter,
    automaticFields: body.automatic_fields === true,
    userIdType: typeof body.user_id_type === "string" ? body.user_id_type.trim() : undefined,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_records_search",
    ...result,
  });
}

async function handleBitableRecordCreate(res, requestUrl, body, appToken, tableId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  if (!body.fields || typeof body.fields !== "object") {
    jsonResponse(res, 400, { ok: false, error: "missing_record_fields" });
    return;
  }

  const result = await createBitableRecord(context.token.access_token, appToken, tableId, {
    fields: body.fields,
    userIdType: typeof body.user_id_type === "string" ? body.user_id_type.trim() : undefined,
    clientToken: typeof body.client_token === "string" ? body.client_token.trim() : undefined,
    ignoreConsistencyCheck: body.ignore_consistency_check === true,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_record_create",
    ...result,
  });
}

async function handleBitableRecordGet(res, requestUrl, body, appToken, tableId, recordId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await getBitableRecord(context.token.access_token, appToken, tableId, recordId, {
    userIdType: requestUrl.searchParams.get("user_id_type") || body.user_id_type || undefined,
    withSharedUrl: requestUrl.searchParams.get("with_shared_url") === "true" || body.with_shared_url === true,
    automaticFields: requestUrl.searchParams.get("automatic_fields") === "true" || body.automatic_fields === true,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_record_get",
    ...result,
  });
}

async function handleBitableRecordUpdate(res, requestUrl, body, appToken, tableId, recordId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  if (!body.fields || typeof body.fields !== "object") {
    jsonResponse(res, 400, { ok: false, error: "missing_record_fields" });
    return;
  }

  const result = await updateBitableRecord(context.token.access_token, appToken, tableId, recordId, {
    fields: body.fields,
    userIdType: typeof body.user_id_type === "string" ? body.user_id_type.trim() : undefined,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_record_update",
    ...result,
  });
}

async function handleBitableRecordDelete(res, requestUrl, body, appToken, tableId, recordId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await deleteBitableRecord(context.token.access_token, appToken, tableId, recordId);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_record_delete",
    ...result,
  });
}

async function handleBitableRecordsBulkUpsert(res, requestUrl, body, appToken, tableId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;
  if (!Array.isArray(body.records) || !body.records.length) {
    jsonResponse(res, 400, { ok: false, error: "missing_bulk_records" });
    return;
  }

  const result = await bulkUpsertBitableRecords(context.token.access_token, appToken, tableId, {
    records: body.records,
    userIdType: body.user_id_type,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "bitable_records_bulk_upsert",
    ...result,
  });
}

async function handleSpreadsheetCreate(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const title = String(body.title || "").trim();
  if (!title) {
    jsonResponse(res, 400, { ok: false, error: "missing_spreadsheet_title" });
    return;
  }

  const result = await createSpreadsheet(context.token.access_token, {
    title,
    folderToken: typeof body.folder_token === "string" ? body.folder_token.trim() : undefined,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_create",
    ...result,
  });
}

async function handleSpreadsheetGet(res, requestUrl, body, spreadsheetToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await getSpreadsheet(context.token.access_token, spreadsheetToken);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_get",
    ...result,
  });
}

async function handleSpreadsheetUpdate(res, requestUrl, body, spreadsheetToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const title = String(body.title || "").trim();
  if (!title) {
    jsonResponse(res, 400, { ok: false, error: "missing_spreadsheet_title" });
    return;
  }

  const result = await updateSpreadsheet(context.token.access_token, spreadsheetToken, { title });
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_update",
    ...result,
  });
}

async function handleSpreadsheetSheetsList(res, requestUrl, body, spreadsheetToken) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await listSpreadsheetSheets(context.token.access_token, spreadsheetToken);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_sheets_list",
    ...result,
  });
}

async function handleSpreadsheetSheetGet(res, requestUrl, body, spreadsheetToken, sheetId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await getSpreadsheetSheet(context.token.access_token, spreadsheetToken, sheetId);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_sheet_get",
    ...result,
  });
}

async function handleSpreadsheetReplace(res, requestUrl, body, spreadsheetToken, sheetId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const range = String(body.range || "").trim();
  const find = String(body.find || "").trim();
  const replacement = String(body.replacement || "").trim();
  if (!range || !find) {
    jsonResponse(res, 400, { ok: false, error: "missing_range_or_find" });
    return;
  }

  const result = await replaceSpreadsheetCells(context.token.access_token, spreadsheetToken, sheetId, {
    range,
    find,
    replacement,
    matchCase: body.match_case === true,
    matchEntireCell: body.match_entire_cell === true,
    searchByRegex: body.search_by_regex === true,
    includeFormulas: body.include_formulas === true,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_replace",
    ...result,
  });
}

async function handleSpreadsheetReplaceBatch(res, requestUrl, body, spreadsheetToken, sheetId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;
  if (!Array.isArray(body.replacements) || !body.replacements.length) {
    jsonResponse(res, 400, { ok: false, error: "missing_replacements" });
    return;
  }

  const result = await replaceSpreadsheetCellsBatch(
    context.token.access_token,
    spreadsheetToken,
    sheetId,
    { replacements: body.replacements },
  );

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "spreadsheet_replace_batch",
    ...result,
  });
}

async function handleCalendarFreebusy(res, requestUrl, body) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const timeMin = String(body.time_min || requestUrl.searchParams.get("time_min") || "").trim();
  const timeMax = String(body.time_max || requestUrl.searchParams.get("time_max") || "").trim();
  if (!timeMin || !timeMax) {
    jsonResponse(res, 400, { ok: false, error: "missing_time_min_or_time_max" });
    return;
  }

  const result = await listFreebusy(context.token.access_token, {
    timeMin,
    timeMax,
    userId: typeof body.user_id === "string" ? body.user_id.trim() : requestUrl.searchParams.get("user_id") || undefined,
    roomId: typeof body.room_id === "string" ? body.room_id.trim() : requestUrl.searchParams.get("room_id") || undefined,
    userIdType:
      (typeof body.user_id_type === "string" && body.user_id_type.trim()) ||
      requestUrl.searchParams.get("user_id_type") ||
      "open_id",
    includeExternalCalendar:
      body.include_external_calendar === true || requestUrl.searchParams.get("include_external_calendar") === "true",
    onlyBusy: body.only_busy === true || requestUrl.searchParams.get("only_busy") === "true",
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "calendar_freebusy",
    ...result,
  });
}

async function handleTaskCommentsList(res, requestUrl, body, taskId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const pageSize = Number.parseInt(requestUrl.searchParams.get("page_size") || body.page_size || "50", 10);
  const result = await listTaskComments(context.token.access_token, taskId, {
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
    pageSize: Number.isFinite(pageSize) ? Math.max(1, Math.min(pageSize, 100)) : 50,
    listDirection: requestUrl.searchParams.get("list_direction") || body.list_direction || undefined,
    userIdType: requestUrl.searchParams.get("user_id_type") || body.user_id_type || "open_id",
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_comments_list",
    ...result,
  });
}

async function handleTaskCommentCreate(res, requestUrl, body, taskId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const content = String(body.content || "").trim();
  if (!content && !String(body.rich_content || "").trim()) {
    jsonResponse(res, 400, { ok: false, error: "missing_comment_content" });
    return;
  }

  const result = await createTaskComment(context.token.access_token, taskId, {
    content: content || undefined,
    richContent: typeof body.rich_content === "string" ? body.rich_content.trim() : undefined,
    parentId: typeof body.parent_id === "string" ? body.parent_id.trim() : undefined,
    userIdType: typeof body.user_id_type === "string" ? body.user_id_type.trim() : undefined,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_comment_create",
    ...result,
  });
}

async function handleTaskCommentGet(res, requestUrl, body, taskId, commentId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await getTaskComment(context.token.access_token, taskId, commentId, {
    userIdType: requestUrl.searchParams.get("user_id_type") || body.user_id_type || "open_id",
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_comment_get",
    ...result,
  });
}

async function handleTaskCommentUpdate(res, requestUrl, body, taskId, commentId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const content = String(body.content || "").trim();
  if (!content && !String(body.rich_content || "").trim()) {
    jsonResponse(res, 400, { ok: false, error: "missing_comment_content" });
    return;
  }

  const result = await updateTaskComment(context.token.access_token, taskId, commentId, {
    content: content || undefined,
    richContent: typeof body.rich_content === "string" ? body.rich_content.trim() : undefined,
    userIdType: typeof body.user_id_type === "string" ? body.user_id_type.trim() : undefined,
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_comment_update",
    ...result,
  });
}

async function handleTaskCommentDelete(res, requestUrl, body, taskId, commentId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await deleteTaskComment(context.token.access_token, taskId, commentId);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "task_comment_delete",
    ...result,
  });
}

async function handleMessageReactionsList(res, requestUrl, body, messageId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const pageSize = Number.parseInt(requestUrl.searchParams.get("page_size") || body.page_size || "50", 10);
  const result = await listMessageReactions(context.token.access_token, messageId, {
    reactionType: requestUrl.searchParams.get("reaction_type") || body.reaction_type || undefined,
    pageToken: requestUrl.searchParams.get("page_token") || body.page_token || undefined,
    pageSize: Number.isFinite(pageSize) ? Math.max(1, Math.min(pageSize, 100)) : 50,
    userIdType: requestUrl.searchParams.get("user_id_type") || body.user_id_type || "open_id",
  });

  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "message_reactions_list",
    ...result,
  });
}

async function handleMessageReactionCreate(res, requestUrl, body, messageId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const emojiType = String(body.emoji_type || body.reaction_type || "").trim();
  if (!emojiType) {
    jsonResponse(res, 400, { ok: false, error: "missing_emoji_type" });
    return;
  }

  const result = await createMessageReaction(context.token.access_token, messageId, emojiType);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "message_reaction_create",
    ...result,
  });
}

async function handleMessageReactionDelete(res, requestUrl, body, messageId, reactionId) {
  const context = await requireUserContext(res, getAccountId(requestUrl, body));
  if (!context) return;

  const result = await deleteMessageReaction(context.token.access_token, messageId, reactionId);
  jsonResponse(res, 200, {
    ok: true,
    account_id: context.account.id,
    auth_mode: "user_access_token",
    action: "message_reaction_delete",
    ...result,
  });
}

async function handleSearch(res, requestUrl, body) {
  const accountId = getAccountId(requestUrl, body);
  const q = requestUrl.searchParams.get("q") || body.q || "";
  const k = Number.parseInt(requestUrl.searchParams.get("k") || body.k || `${searchTopK}`, 10);

  if (!q.trim()) {
    jsonResponse(res, 400, { ok: false, error: "missing_query" });
    return;
  }

  try {
    const { account, items } = searchKnowledgeBase(accountId, q, k);
    jsonResponse(res, 200, {
      ok: true,
      account_id: account.id,
      q,
      total: items.length,
      items,
    });
  } catch (error) {
    jsonResponse(res, 401, {
      ok: false,
      error: "unauthorized",
      message: error.message,
      login_url: `${oauthBaseUrl}/oauth/lark/login`,
    });
  }
}

async function handleAnswer(res, requestUrl, body) {
  const accountId = getAccountId(requestUrl, body);
  const q = requestUrl.searchParams.get("q") || body.q || "";
  const k = Number.parseInt(requestUrl.searchParams.get("k") || body.k || `${searchTopK}`, 10);

  if (!q.trim()) {
    jsonResponse(res, 400, { ok: false, error: "missing_query" });
    return;
  }

  try {
    const result = await answerQuestion(accountId, q, k);
    jsonResponse(res, 200, {
      ok: true,
      account_id: result.account.id,
      q,
      answer: result.answer,
      provider: result.provider,
      sources: result.sources,
    });
  } catch (error) {
    jsonResponse(res, 401, {
      ok: false,
      error: "unauthorized",
      message: error.message,
      login_url: `${oauthBaseUrl}/oauth/lark/login`,
    });
  }
}

async function handleSecureTaskStart(res, body) {
  const name = String(body.name || "lobster-secure-task").trim();
  if (!name) {
    jsonResponse(res, 400, { ok: false, error: "missing_task_name" });
    return;
  }
  const task = await startSecureTask(name);
  jsonResponse(res, 200, { ok: true, task });
}

async function handleSecureAction(res, taskId, body) {
  if (!body || typeof body !== "object" || !body.action || typeof body.action !== "object") {
    jsonResponse(res, 400, { ok: false, error: "missing_action" });
    return;
  }
  const result = await executeSecureAction(taskId, body.action);
  if (result.status === "approval_required") {
    jsonResponse(res, 409, result);
    return;
  }
  jsonResponse(res, 200, result);
}

async function handleSecureTaskFinish(res, taskId, body) {
  const diff = await finishSecureTask(taskId, Boolean(body.success));
  jsonResponse(res, 200, { ok: true, diff });
}

async function handleSecureTaskRollback(res, taskId, body) {
  const diff = await rollbackSecureTask(taskId, Boolean(body.dry_run));
  jsonResponse(res, 200, { ok: true, diff });
}

async function handleSecurityStatus(res) {
  const status = await getSecurityStatus();
  jsonResponse(res, 200, status);
}

async function handleApprovalList(res) {
  const items = await listPendingApprovals();
  jsonResponse(res, 200, { ok: true, total: items.length, items });
}

async function handleApprovalResolution(res, requestId, body, approved) {
  const actor = typeof body.actor === "string" && body.actor.trim() ? body.actor.trim() : "openclaw";
  const result = await resolvePendingApproval(requestId, approved, actor);
  jsonResponse(res, 200, result);
}

export function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    try {
      cleanupOauthStates();
      const requestUrl = new URL(req.url || "/", oauthBaseUrl);
      const body = await readJsonBody(req).catch(() => ({}));

      if (requestUrl.pathname === "/health") {
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/agent/security/status") {
        await handleSecurityStatus(res);
        return;
      }

      if (requestUrl.pathname === "/agent/approvals" && req.method === "GET") {
        await handleApprovalList(res);
        return;
      }

      const approvalResolveMatch = requestUrl.pathname.match(/^\/agent\/approvals\/([^/]+)\/(approve|reject)$/);
      if (approvalResolveMatch && req.method === "POST") {
        await handleApprovalResolution(
          res,
          decodeURIComponent(approvalResolveMatch[1]),
          body,
          approvalResolveMatch[2] === "approve",
        );
        return;
      }

      if (requestUrl.pathname === "/agent/tasks" && req.method === "POST") {
        await handleSecureTaskStart(res, body);
        return;
      }

      const taskActionMatch = requestUrl.pathname.match(/^\/agent\/tasks\/([^/]+)\/actions$/);
      if (taskActionMatch && req.method === "POST") {
        await handleSecureAction(res, decodeURIComponent(taskActionMatch[1]), body);
        return;
      }

      const taskFinishMatch = requestUrl.pathname.match(/^\/agent\/tasks\/([^/]+)\/finish$/);
      if (taskFinishMatch && req.method === "POST") {
        await handleSecureTaskFinish(res, decodeURIComponent(taskFinishMatch[1]), body);
        return;
      }

      const taskRollbackMatch = requestUrl.pathname.match(/^\/agent\/tasks\/([^/]+)\/rollback$/);
      if (taskRollbackMatch && req.method === "POST") {
        await handleSecureTaskRollback(res, decodeURIComponent(taskRollbackMatch[1]), body);
        return;
      }

      if (requestUrl.pathname === "/oauth/lark/login") {
        const state = buildOAuthState();
        pendingOauthStates.set(state, Date.now());
        res.writeHead(302, { Location: buildAuthorizeUrl(state) });
        res.end();
        return;
      }

      if (requestUrl.pathname === oauthCallbackPath) {
        const code = requestUrl.searchParams.get("code");
        const state = requestUrl.searchParams.get("state");

        if (!code || !state || !pendingOauthStates.has(state)) {
          htmlResponse(res, 400, "<h1>Lark OAuth failed</h1><p>Missing or invalid code/state.</p>");
          return;
        }

        pendingOauthStates.delete(state);
        const token = await exchangeCodeForUserToken(code);
        const profile = await getUserProfile(token.access_token);

        htmlResponse(
          res,
          200,
          `<h1>Lark OAuth success</h1>
<p>Signed in as ${profile.name || profile.en_name || profile.open_id || "unknown user"}.</p>
<ul>
  <li><a href="/api/auth/status">Auth status</a></li>
  <li><a href="/sync/full">Run full sync</a></li>
  <li><a href="/api/drive/root">Drive root</a></li>
  <li><a href="/api/wiki/spaces">Wiki spaces</a></li>
</ul>`,
        );
        return;
      }

      if (requestUrl.pathname === "/api/auth/status" && req.method === "GET") {
        await handleAuthStatus(res, getAccountId(requestUrl, body));
        return;
      }

      if (requestUrl.pathname === "/api/runtime/resolve-scopes" && req.method === "POST") {
        await handleRuntimeResolveScopes(res, body);
        return;
      }

      if (requestUrl.pathname === "/api/runtime/sessions" && req.method === "GET") {
        await handleRuntimeSessions(res);
        return;
      }

      if (requestUrl.pathname === "/api/drive/root" && req.method === "GET") {
        await handleDriveList(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/drive/list" && req.method === "GET") {
        await handleDriveList(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/drive/create-folder" && req.method === "POST") {
        await handleDriveCreateFolder(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/drive/move" && req.method === "POST") {
        await handleDriveMove(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/drive/task-status" && req.method === "GET") {
        await handleDriveTaskStatus(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/drive/delete" && req.method === "POST") {
        await handleDriveDelete(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/drive/organize/preview" && req.method === "POST") {
        await handleDriveOrganize(res, requestUrl, body, false);
        return;
      }

      if (requestUrl.pathname === "/api/drive/organize/apply" && req.method === "POST") {
        await handleDriveOrganize(res, requestUrl, body, true);
        return;
      }

      if (requestUrl.pathname === "/api/wiki/spaces" && req.method === "GET") {
        const context = await requireUserContext(res, getAccountId(requestUrl, body));
        if (!context) {
          return;
        }

        const data = await listWikiSpaces(
          context.token.access_token,
          requestUrl.searchParams.get("page_token") || undefined,
        );
        jsonResponse(res, 200, {
          ok: true,
          account_id: context.account.id,
          auth_mode: "user_access_token",
          source: "wiki.v2.spaces",
          ...data,
        });
        return;
      }

      if (requestUrl.pathname === "/api/doc/read" && req.method === "GET") {
        await handleDocumentRead(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/doc/create" && req.method === "POST") {
        await handleDocumentCreate(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/doc/update" && req.method === "POST") {
        await handleDocumentUpdate(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/doc/comments" && req.method === "GET") {
        await handleDocumentComments(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/doc/rewrite-from-comments" && req.method === "POST") {
        await handleDocumentRewriteFromComments(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/doc/comments/suggestion-card" && req.method === "POST") {
        await handleDocumentCommentSuggestionCard(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/doc/comments/poll-suggestion-cards" && req.method === "POST") {
        await handleDocumentCommentSuggestionPoll(res);
        return;
      }

      if (requestUrl.pathname === "/api/messages" && req.method === "GET") {
        await handleMessagesList(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/messages/search" && req.method === "GET") {
        await handleMessageSearch(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/messages/reply" && req.method === "POST") {
        await handleMessageReply(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/messages/reply-card" && req.method === "POST") {
        await handleMessageReply(res, requestUrl, {
          ...body,
          card_title: body.card_title || body.title || "Lobster",
        });
        return;
      }

      const messageGetMatch = requestUrl.pathname.match(/^\/api\/messages\/([^/]+)$/);
      if (messageGetMatch && req.method === "GET") {
        await handleMessageGet(res, requestUrl, body, decodeURIComponent(messageGetMatch[1]));
        return;
      }

      if (requestUrl.pathname === "/api/calendar/primary" && req.method === "GET") {
        await handleCalendarPrimary(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/calendar/events" && req.method === "GET") {
        await handleCalendarEvents(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/calendar/events/search" && req.method === "POST") {
        await handleCalendarSearch(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/calendar/events/create" && req.method === "POST") {
        await handleCalendarCreateEvent(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/tasks" && req.method === "GET") {
        await handleTasksList(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/tasks/create" && req.method === "POST") {
        await handleTaskCreate(res, requestUrl, body);
        return;
      }

      const taskGetMatch = requestUrl.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskGetMatch && req.method === "GET") {
        await handleTaskGet(res, requestUrl, body, decodeURIComponent(taskGetMatch[1]));
        return;
      }

      if (requestUrl.pathname === "/api/bitable/apps/create" && req.method === "POST") {
        await handleBitableAppCreate(res, requestUrl, body);
        return;
      }

      const bitableAppMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)$/);
      if (bitableAppMatch && req.method === "GET") {
        await handleBitableAppGet(res, requestUrl, body, decodeURIComponent(bitableAppMatch[1]));
        return;
      }
      if (bitableAppMatch && (req.method === "POST" || req.method === "PATCH")) {
        await handleBitableAppUpdate(res, requestUrl, body, decodeURIComponent(bitableAppMatch[1]));
        return;
      }

      const bitableTablesMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables$/);
      if (bitableTablesMatch && req.method === "GET") {
        await handleBitableTablesList(res, requestUrl, body, decodeURIComponent(bitableTablesMatch[1]));
        return;
      }

      const bitableTableCreateMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables\/create$/);
      if (bitableTableCreateMatch && req.method === "POST") {
        await handleBitableTableCreate(res, requestUrl, body, decodeURIComponent(bitableTableCreateMatch[1]));
        return;
      }

      const bitableRecordsMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables\/([^/]+)\/records$/);
      if (bitableRecordsMatch && req.method === "GET") {
        await handleBitableRecordsList(
          res,
          requestUrl,
          body,
          decodeURIComponent(bitableRecordsMatch[1]),
          decodeURIComponent(bitableRecordsMatch[2]),
        );
        return;
      }

      const bitableRecordsSearchMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables\/([^/]+)\/records\/search$/);
      if (bitableRecordsSearchMatch && req.method === "POST") {
        await handleBitableRecordsSearch(
          res,
          requestUrl,
          body,
          decodeURIComponent(bitableRecordsSearchMatch[1]),
          decodeURIComponent(bitableRecordsSearchMatch[2]),
        );
        return;
      }

      const bitableRecordCreateMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables\/([^/]+)\/records\/create$/);
      if (bitableRecordCreateMatch && req.method === "POST") {
        await handleBitableRecordCreate(
          res,
          requestUrl,
          body,
          decodeURIComponent(bitableRecordCreateMatch[1]),
          decodeURIComponent(bitableRecordCreateMatch[2]),
        );
        return;
      }

      const bitableRecordBulkMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables\/([^/]+)\/records\/bulk-upsert$/);
      if (bitableRecordBulkMatch && req.method === "POST") {
        await handleBitableRecordsBulkUpsert(
          res,
          requestUrl,
          body,
          decodeURIComponent(bitableRecordBulkMatch[1]),
          decodeURIComponent(bitableRecordBulkMatch[2]),
        );
        return;
      }

      const bitableRecordMatch = requestUrl.pathname.match(/^\/api\/bitable\/apps\/([^/]+)\/tables\/([^/]+)\/records\/([^/]+)$/);
      if (bitableRecordMatch && req.method === "GET") {
        await handleBitableRecordGet(
          res,
          requestUrl,
          body,
          decodeURIComponent(bitableRecordMatch[1]),
          decodeURIComponent(bitableRecordMatch[2]),
          decodeURIComponent(bitableRecordMatch[3]),
        );
        return;
      }
      if (bitableRecordMatch && (req.method === "POST" || req.method === "PATCH")) {
        await handleBitableRecordUpdate(
          res,
          requestUrl,
          body,
          decodeURIComponent(bitableRecordMatch[1]),
          decodeURIComponent(bitableRecordMatch[2]),
          decodeURIComponent(bitableRecordMatch[3]),
        );
        return;
      }
      if (bitableRecordMatch && req.method === "DELETE") {
        await handleBitableRecordDelete(
          res,
          requestUrl,
          body,
          decodeURIComponent(bitableRecordMatch[1]),
          decodeURIComponent(bitableRecordMatch[2]),
          decodeURIComponent(bitableRecordMatch[3]),
        );
        return;
      }

      if (requestUrl.pathname === "/api/sheets/spreadsheets/create" && req.method === "POST") {
        await handleSpreadsheetCreate(res, requestUrl, body);
        return;
      }

      const spreadsheetMatch = requestUrl.pathname.match(/^\/api\/sheets\/spreadsheets\/([^/]+)$/);
      if (spreadsheetMatch && req.method === "GET") {
        await handleSpreadsheetGet(res, requestUrl, body, decodeURIComponent(spreadsheetMatch[1]));
        return;
      }
      if (spreadsheetMatch && (req.method === "POST" || req.method === "PATCH")) {
        await handleSpreadsheetUpdate(res, requestUrl, body, decodeURIComponent(spreadsheetMatch[1]));
        return;
      }

      const spreadsheetSheetsMatch = requestUrl.pathname.match(/^\/api\/sheets\/spreadsheets\/([^/]+)\/sheets$/);
      if (spreadsheetSheetsMatch && req.method === "GET") {
        await handleSpreadsheetSheetsList(res, requestUrl, body, decodeURIComponent(spreadsheetSheetsMatch[1]));
        return;
      }

      const spreadsheetSheetMatch = requestUrl.pathname.match(/^\/api\/sheets\/spreadsheets\/([^/]+)\/sheets\/([^/]+)$/);
      if (spreadsheetSheetMatch && req.method === "GET") {
        await handleSpreadsheetSheetGet(
          res,
          requestUrl,
          body,
          decodeURIComponent(spreadsheetSheetMatch[1]),
          decodeURIComponent(spreadsheetSheetMatch[2]),
        );
        return;
      }

      const spreadsheetReplaceMatch = requestUrl.pathname.match(/^\/api\/sheets\/spreadsheets\/([^/]+)\/sheets\/([^/]+)\/replace$/);
      if (spreadsheetReplaceMatch && req.method === "POST") {
        await handleSpreadsheetReplace(
          res,
          requestUrl,
          body,
          decodeURIComponent(spreadsheetReplaceMatch[1]),
          decodeURIComponent(spreadsheetReplaceMatch[2]),
        );
        return;
      }

      const spreadsheetReplaceBatchMatch = requestUrl.pathname.match(/^\/api\/sheets\/spreadsheets\/([^/]+)\/sheets\/([^/]+)\/replace-batch$/);
      if (spreadsheetReplaceBatchMatch && req.method === "POST") {
        await handleSpreadsheetReplaceBatch(
          res,
          requestUrl,
          body,
          decodeURIComponent(spreadsheetReplaceBatchMatch[1]),
          decodeURIComponent(spreadsheetReplaceBatchMatch[2]),
        );
        return;
      }

      if (requestUrl.pathname === "/api/calendar/freebusy" && req.method === "POST") {
        await handleCalendarFreebusy(res, requestUrl, body);
        return;
      }

      const taskCommentsMatch = requestUrl.pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
      if (taskCommentsMatch && req.method === "GET") {
        await handleTaskCommentsList(res, requestUrl, body, decodeURIComponent(taskCommentsMatch[1]));
        return;
      }
      if (taskCommentsMatch && req.method === "POST") {
        await handleTaskCommentCreate(res, requestUrl, body, decodeURIComponent(taskCommentsMatch[1]));
        return;
      }

      const taskCommentMatch = requestUrl.pathname.match(/^\/api\/tasks\/([^/]+)\/comments\/([^/]+)$/);
      if (taskCommentMatch && req.method === "GET") {
        await handleTaskCommentGet(
          res,
          requestUrl,
          body,
          decodeURIComponent(taskCommentMatch[1]),
          decodeURIComponent(taskCommentMatch[2]),
        );
        return;
      }
      if (taskCommentMatch && (req.method === "POST" || req.method === "PUT" || req.method === "PATCH")) {
        await handleTaskCommentUpdate(
          res,
          requestUrl,
          body,
          decodeURIComponent(taskCommentMatch[1]),
          decodeURIComponent(taskCommentMatch[2]),
        );
        return;
      }
      if (taskCommentMatch && req.method === "DELETE") {
        await handleTaskCommentDelete(
          res,
          requestUrl,
          body,
          decodeURIComponent(taskCommentMatch[1]),
          decodeURIComponent(taskCommentMatch[2]),
        );
        return;
      }

      const messageReactionsMatch = requestUrl.pathname.match(/^\/api\/messages\/([^/]+)\/reactions$/);
      if (messageReactionsMatch && req.method === "GET") {
        await handleMessageReactionsList(res, requestUrl, body, decodeURIComponent(messageReactionsMatch[1]));
        return;
      }
      if (messageReactionsMatch && req.method === "POST") {
        await handleMessageReactionCreate(res, requestUrl, body, decodeURIComponent(messageReactionsMatch[1]));
        return;
      }

      const messageReactionMatch = requestUrl.pathname.match(/^\/api\/messages\/([^/]+)\/reactions\/([^/]+)$/);
      if (messageReactionMatch && req.method === "DELETE") {
        await handleMessageReactionDelete(
          res,
          requestUrl,
          body,
          decodeURIComponent(messageReactionMatch[1]),
          decodeURIComponent(messageReactionMatch[2]),
        );
        return;
      }

      if (requestUrl.pathname === "/api/wiki/create-node" && req.method === "POST") {
        await handleWikiCreateNode(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/api/wiki/move" && req.method === "POST") {
        await handleWikiMove(res, requestUrl, body);
        return;
      }

      const wikiNodesMatch = requestUrl.pathname.match(/^\/api\/wiki\/spaces\/([^/]+)\/nodes$/);
      if (wikiNodesMatch && req.method === "GET") {
        const context = await requireUserContext(res, getAccountId(requestUrl, body));
        if (!context) {
          return;
        }

        const spaceId = decodeURIComponent(wikiNodesMatch[1]);
        const data = await listWikiSpaceNodes(
          context.token.access_token,
          spaceId,
          requestUrl.searchParams.get("parent_node_token") || undefined,
          requestUrl.searchParams.get("page_token") || undefined,
        );
        jsonResponse(res, 200, {
          ok: true,
          account_id: context.account.id,
          auth_mode: "user_access_token",
          source: "wiki.v2.space_node.list",
          space_id: spaceId,
          ...data,
        });
        return;
      }

      if (requestUrl.pathname === "/api/wiki/organize/preview" && req.method === "POST") {
        await handleWikiOrganize(res, requestUrl, body, false);
        return;
      }

      if (requestUrl.pathname === "/api/wiki/organize/apply" && req.method === "POST") {
        await handleWikiOrganize(res, requestUrl, body, true);
        return;
      }

      if (requestUrl.pathname === "/sync/full" && req.method === "POST") {
        await handleSync(res, requestUrl, body, "full");
        return;
      }

      if (requestUrl.pathname === "/sync/incremental" && req.method === "POST") {
        await handleSync(res, requestUrl, body, "incremental");
        return;
      }

      if (requestUrl.pathname === "/search" && req.method === "GET") {
        await handleSearch(res, requestUrl, body);
        return;
      }

      if (requestUrl.pathname === "/answer" && req.method === "GET") {
        await handleAnswer(res, requestUrl, body);
        return;
      }

      const allowedMethods = getAllowedMethodsForPath(requestUrl.pathname);
      if (allowedMethods && !allowedMethods.includes(req.method || "GET")) {
        methodNotAllowed(res, allowedMethods);
        return;
      }

      jsonResponse(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      console.error("HTTP server error:", error);
      jsonResponse(res, 500, {
        ok: false,
        error: "internal_error",
        message: error.message,
      });
    }
  });

  server.listen(oauthPort, () => {
    console.log(`HTTP server listening on ${oauthBaseUrl}`);
    console.log(`Open this URL to sign in: ${oauthBaseUrl}/oauth/lark/login`);
  });

  return server;
}
