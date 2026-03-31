import { prepareDocumentCommentRewritePreview } from "./comment-doc-workflow.mjs";
import { listUnseenDocumentComments, markDocumentCommentsSeen } from "./comment-watch-store.mjs";
import { executeCanonicalLarkMessageReply } from "./lark-mutation-runtime.mjs";
import {
  listDocumentCommentsFromRuntime,
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
  listCommentsFn = listAllUnresolvedDocumentComments,
  listUnseenDocumentCommentsFn = listUnseenDocumentComments,
  executeMessageReplyFn = executeCanonicalLarkMessageReply,
  markDocumentCommentsSeenFn = markDocumentCommentsSeen,
  preparePreviewFn = prepareDocumentCommentRewritePreview,
}) {
  const unresolvedComments = await listCommentsFn(accessToken, documentId);
  const unseenComments = await listUnseenDocumentCommentsFn({
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

  const preview = await preparePreviewFn({
    accountId,
    accessToken,
    documentId,
    commentIds: unseenComments.map((item) => item.comment_id).filter(Boolean),
    resolveComments: Boolean(resolveComments),
    route: "document_comment_suggestion_card",
  });
  const confirmation = preview.confirmation;
  if (!confirmation) {
    return {
      ok: true,
      document_id: documentId,
      has_new_comments: false,
      message: "目前沒有新的未處理評論需要生成改稿建議卡。",
    };
  }

  let seenResult = null;
  let notification = null;
  if (String(messageId || "").trim()) {
    const runtimePayload = {
      pathname: "/runtime/comment-suggestion/reply-preview-card",
      accountId,
      accessToken,
      messageId: String(messageId).trim(),
      content: confirmation.preview_card.content,
      replyInThread: Boolean(replyInThread),
      cardTitle: confirmation.preview_card.title,
    };
    const execution = executeMessageReplyFn === executeCanonicalLarkMessageReply
      ? await executeCanonicalLarkMessageReply({
          ...runtimePayload,
        })
      : await executeMessageReplyFn(runtimePayload);
    if (execution.ok !== true) {
      throw new Error(execution.data?.message || execution.error || "comment_suggestion_reply_failed");
    }
    notification = execution.result;
  }
  if (markSeen) {
    seenResult = await markDocumentCommentsSeenFn({
      accountId,
      documentId,
      comments: unseenComments,
    });
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
