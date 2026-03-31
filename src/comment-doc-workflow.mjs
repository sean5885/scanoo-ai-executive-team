import crypto from "node:crypto";

import { rewriteDocumentFromComments } from "./doc-comment-rewrite.mjs";
import {
  createCommentRewriteConfirmation,
  peekCommentRewriteConfirmation,
} from "./doc-update-confirmations.mjs";
import { ensureDocRewriteWorkflowTask } from "./executive-orchestrator.mjs";
import {
  clearActiveExecutiveTask,
  getActiveExecutiveTask,
} from "./executive-task-state.mjs";
import { readDocumentFromRuntime } from "./read-runtime.mjs";

function cleanText(value) {
  return String(value || "").trim();
}

function buildWorkflowTraceId() {
  return `doc_rewrite_${crypto.randomUUID()}`;
}

export function buildDocumentRewriteWorkflowScope(documentId = "", { traceId = "" } = {}) {
  const normalizedDocumentId = cleanText(documentId) || "unknown";
  return {
    session_key: `doc-rewrite:${normalizedDocumentId}`,
    trace_id: cleanText(traceId) || buildWorkflowTraceId(),
  };
}

export function buildDocumentRewriteTaskMeta(route = "", extra = {}) {
  return {
    route: cleanText(route) || null,
    ...(extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {}),
  };
}

async function clearDocRewriteTask({
  accountId = "",
  workflowScope = null,
  clearActiveTaskFn = clearActiveExecutiveTask,
} = {}) {
  if (!accountId || !cleanText(workflowScope?.session_key) || typeof clearActiveTaskFn !== "function") {
    return;
  }
  await clearActiveTaskFn(accountId, workflowScope.session_key);
}

export async function prepareDocumentCommentRewritePreview({
  accountId = "",
  accessToken = "",
  documentId = "",
  includeSolved = false,
  commentIds = [],
  resolveComments = false,
  event = {},
  scope = null,
  route = "document_rewrite_from_comments_preview",
  readDocumentFn = readDocumentFromRuntime,
  rewriteDocumentFn = rewriteDocumentFromComments,
  createConfirmationFn = createCommentRewriteConfirmation,
  ensureWorkflowTaskFn = ensureDocRewriteWorkflowTask,
  clearActiveTaskFn = clearActiveExecutiveTask,
} = {}) {
  const workflowScope = scope && typeof scope === "object"
    ? {
        session_key: cleanText(scope.session_key) || `doc-rewrite:${cleanText(documentId) || "unknown"}`,
        trace_id: cleanText(scope.trace_id) || buildWorkflowTraceId(),
      }
    : buildDocumentRewriteWorkflowScope(documentId);
  const normalizedRoute = cleanText(route) || "document_rewrite_from_comments_preview";
  const normalizedCommentIds = Array.isArray(commentIds)
    ? commentIds.map((item) => cleanText(item)).filter(Boolean)
    : [];
  const current = await readDocumentFn({
    accountId,
    accessToken,
    documentId,
    pathname: "internal:comment_doc_workflow/read_document",
    logger: null,
  });

  if (typeof ensureWorkflowTaskFn === "function") {
    await ensureWorkflowTaskFn({
      accountId,
      documentId,
      documentTitle: current.title,
      scope: workflowScope,
      event,
      workflowState: "loading_source",
      routingHint: "doc_rewrite_loading_source",
      meta: buildDocumentRewriteTaskMeta(normalizedRoute),
    });
  }

  const result = await rewriteDocumentFn(accessToken, documentId, {
    includeSolved: includeSolved === true,
    commentIds: normalizedCommentIds,
    apply: false,
    resolveComments: resolveComments === true,
  });

  if (!result?.comment_count) {
    await clearDocRewriteTask({
      accountId,
      workflowScope,
      clearActiveTaskFn,
    });
    return {
      current,
      result,
      confirmation: null,
      workflowScope,
    };
  }

  if (typeof ensureWorkflowTaskFn === "function") {
    await ensureWorkflowTaskFn({
      accountId,
      documentId,
      documentTitle: current.title,
      scope: workflowScope,
      event,
      workflowState: "drafting",
      routingHint: "doc_rewrite_drafting",
      meta: buildDocumentRewriteTaskMeta(normalizedRoute),
    });
  }

  const confirmation = await createConfirmationFn({
    accountId,
    documentId,
    title: result.title,
    currentRevisionId: current.revision_id,
    currentContent: current.content,
    rewrittenContent: result.revised_content || "",
    patchPlan: result.patch_plan || [],
    changeSummary: result.change_summary || [],
    commentIds: result.comment_ids || normalizedCommentIds,
    comments: result.comments || [],
    resolveComments: resolveComments === true,
  });

  if (typeof ensureWorkflowTaskFn === "function") {
    await ensureWorkflowTaskFn({
      accountId,
      documentId,
      documentTitle: current.title,
      scope: workflowScope,
      event,
      workflowState: "awaiting_review",
      routingHint: "doc_rewrite_review_pending",
      meta: buildDocumentRewriteTaskMeta(normalizedRoute, {
        confirmation_id: confirmation.confirmation_id,
      }),
    });
  }

  return {
    current,
    result,
    confirmation,
    workflowScope,
  };
}

export async function loadDocumentCommentRewriteApplyState({
  accountId = "",
  documentId = "",
  confirmationId = "",
  scope = null,
  peekConfirmationFn = peekCommentRewriteConfirmation,
  getActiveTaskFn = getActiveExecutiveTask,
} = {}) {
  const normalizedConfirmationId = cleanText(confirmationId);
  const workflowScope = scope && typeof scope === "object"
    ? {
        session_key: cleanText(scope.session_key) || `doc-rewrite:${cleanText(documentId) || "unknown"}`,
        trace_id: cleanText(scope.trace_id) || buildWorkflowTraceId(),
      }
    : buildDocumentRewriteWorkflowScope(documentId);
  const pendingConfirmation = normalizedConfirmationId && typeof peekConfirmationFn === "function"
    ? await peekConfirmationFn({
        confirmationId: normalizedConfirmationId,
        accountId,
        documentId,
      })
    : null;
  const activeTask = accountId && typeof getActiveTaskFn === "function"
    ? await getActiveTaskFn(accountId, workflowScope.session_key)
    : null;
  const reviewReady = Boolean(
    pendingConfirmation
    && activeTask?.id
    && activeTask.workflow === "doc_rewrite"
    && activeTask.workflow_state === "awaiting_review"
    && cleanText(activeTask?.meta?.document_id) === cleanText(documentId)
    && cleanText(activeTask?.meta?.confirmation_id) === normalizedConfirmationId
  );

  return {
    workflowScope,
    pendingConfirmation,
    activeTask,
    reviewReady,
  };
}
