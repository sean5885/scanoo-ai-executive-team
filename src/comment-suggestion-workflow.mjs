import { rewriteDocumentFromComments } from "./doc-comment-rewrite.mjs";
import { listUnseenDocumentComments, markDocumentCommentsSeen } from "./comment-watch-store.mjs";
import { createCommentRewriteConfirmation } from "./doc-update-confirmations.mjs";
import { executeCanonicalLarkMessageReply } from "./lark-mutation-runtime.mjs";
import {
  listDocumentCommentsFromRuntime,
  readDocumentFromRuntime,
} from "./read-runtime.mjs";

async function listAllUnresolvedDocumentComments(accessToken, documentId) {
  const accountId = `token:${String(accessToken || "").trim() || "unknown"}`;
  const items = [];
  let pageToken = "";

  while (true) {
    const page = await listDocumentCommentsFromRuntime({
      accountId,
      accessToken,
      documentId,
      includeSolved: false,
      pageToken,
      pathname: "internal:comment_suggestion/list_comments",
    });
    items.push(...(Array.isArray(page.items) ? page.items : []));
    if (!page.has_more || !page.page_token || pageToken === page.page_token) {
      break;
    }
    pageToken = page.page_token;
  }

  return items;
}

export async function generateDocumentCommentSuggestionCard({
  accessToken,
  accountId,
  documentId,
  messageId = "",
  replyInThread = false,
  resolveComments = false,
  markSeen = true,
}) {
  const unresolvedComments = await listAllUnresolvedDocumentComments(accessToken, documentId);
  const unseenComments = await listUnseenDocumentComments({
    accountId,
    documentId,
    comments: unresolvedComments,
  });

  if (!unseenComments.length) {
    return {
      ok: true,
      document_id: documentId,
      has_new_comments: false,
      message: "目前沒有新的未處理評論需要生成改稿建議卡。",
    };
  }

  const current = await readDocumentFromRuntime({
    accountId,
    accessToken,
    documentId,
    pathname: "internal:comment_suggestion/read_document",
  });
  const result = await rewriteDocumentFromComments(accessToken, documentId, {
    commentIds: unseenComments.map((item) => item.comment_id).filter(Boolean),
    apply: false,
    resolveComments: Boolean(resolveComments),
  });

  const confirmation = await createCommentRewriteConfirmation({
    accountId,
    documentId,
    title: result.title,
    currentRevisionId: current.revision_id,
    currentContent: current.content,
    rewrittenContent: result.revised_content || "",
    patchPlan: result.patch_plan || [],
    changeSummary: result.change_summary || [],
    commentIds: result.comment_ids || unseenComments.map((item) => item.comment_id).filter(Boolean),
    comments: unseenComments,
    resolveComments: Boolean(resolveComments),
  });

  let seenResult = null;
  if (markSeen) {
    seenResult = await markDocumentCommentsSeen({
      accountId,
      documentId,
      comments: unseenComments,
    });
  }

  let notification = null;
  if (String(messageId || "").trim()) {
    const execution = await executeCanonicalLarkMessageReply({
      pathname: "/runtime/comment-suggestion/reply-preview-card",
      accountId,
      accessToken,
      messageId: String(messageId).trim(),
      content: confirmation.preview_card.content,
      replyInThread: Boolean(replyInThread),
      cardTitle: confirmation.preview_card.title,
    });
    if (execution.ok !== true) {
      throw new Error(execution.message || execution.error || "comment_suggestion_reply_failed");
    }
    notification = execution.result;
  }

  return {
    ok: true,
    document_id: documentId,
    has_new_comments: true,
    new_comment_count: unseenComments.length,
    confirmation_id: confirmation.confirmation_id,
    confirmation_type: confirmation.confirmation_type,
    confirmation_expires_at: confirmation.expires_at,
    rewrite_preview: confirmation.preview,
    rewrite_preview_card: confirmation.preview_card,
    seen_result: seenResult,
    notification,
  };
}
