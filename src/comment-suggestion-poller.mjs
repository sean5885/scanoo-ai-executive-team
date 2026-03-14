import { docCommentSuggestionPollEnabled, docCommentSuggestionPollIntervalSeconds, docCommentSuggestionWatchesPath } from "./config.mjs";
import { generateDocumentCommentSuggestionCard } from "./comment-suggestion-workflow.mjs";
import { getValidUserToken } from "./lark-user-auth.mjs";
import { readJsonFile } from "./token-store.mjs";

function normalizeWatches(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  return [];
}

async function loadWatches() {
  const payload = await readJsonFile(docCommentSuggestionWatchesPath);
  return normalizeWatches(payload)
    .map((item) => ({
      account_id: String(item?.account_id || "").trim(),
      document_id: String(item?.document_id || item?.doc_token || "").trim(),
      message_id: String(item?.message_id || "").trim(),
      reply_in_thread: item?.reply_in_thread === true,
      resolve_comments: item?.resolve_comments === true,
      mark_seen: item?.mark_seen !== false,
      enabled: item?.enabled !== false,
    }))
    .filter((item) => item.enabled && item.account_id && item.document_id);
}

export async function runCommentSuggestionPollOnce() {
  const watches = await loadWatches();
  const results = [];

  for (const watch of watches) {
    try {
      const token = await getValidUserToken(watch.account_id);
      if (!token?.access_token) {
        results.push({
          document_id: watch.document_id,
          account_id: watch.account_id,
          ok: false,
          error: "missing_valid_user_token",
        });
        continue;
      }
      const result = await generateDocumentCommentSuggestionCard({
        accessToken: token.access_token,
        accountId: watch.account_id,
        documentId: watch.document_id,
        messageId: watch.message_id,
        replyInThread: watch.reply_in_thread,
        resolveComments: watch.resolve_comments,
        markSeen: watch.mark_seen,
      });
      results.push({
        document_id: watch.document_id,
        account_id: watch.account_id,
        ok: true,
        has_new_comments: Boolean(result.has_new_comments),
        new_comment_count: Number(result.new_comment_count || 0),
        confirmation_id: result.confirmation_id || null,
      });
    } catch (error) {
      results.push({
        document_id: watch.document_id,
        account_id: watch.account_id,
        ok: false,
        error: error?.message || String(error),
      });
    }
  }

  return {
    ok: true,
    action: "comment_suggestion_poll_once",
    total: results.length,
    items: results,
  };
}

export function startCommentSuggestionPoller({ logger = console } = {}) {
  if (!docCommentSuggestionPollEnabled) {
    return { stop() {} };
  }

  let timer = null;
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const result = await runCommentSuggestionPollOnce();
      logger.info?.("comment suggestion poll completed", result);
    } catch (error) {
      logger.error?.("comment suggestion poll failed", error);
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, Math.max(30, docCommentSuggestionPollIntervalSeconds) * 1000);
  tick().catch(() => {});

  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
