import { getDocument, listDocumentComments, replyMessage } from "./lark-content.mjs";
import { rewriteDocumentFromComments } from "./doc-comment-rewrite.mjs";
import { listUnseenDocumentComments, markDocumentCommentsSeen } from "./comment-watch-store.mjs";
import { createCommentRewriteConfirmation } from "./doc-update-confirmations.mjs";

async function listAllUnresolvedDocumentComments(accessToken, documentId) {
  const items = [];
  let pageToken = undefined;

  while (true) {
    const page = await listDocumentComments(accessToken, documentId, {
      fileType: "docx",
      isSolved: false,
      pageToken,
    });
    items.push(...(Array.isArray(page.items) ? page.items : []));
    if (!page.has_more || !page.page_token) {
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

  const current = await getDocument(accessToken, documentId);
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
    notification = await replyMessage(
      accessToken,
      String(messageId).trim(),
      confirmation.preview_card.content,
      {
        replyInThread: Boolean(replyInThread),
        cardTitle: confirmation.preview_card.title,
      },
    );
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
