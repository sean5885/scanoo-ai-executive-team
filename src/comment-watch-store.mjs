import crypto from "node:crypto";
import { docCommentWatchStorePath } from "./config.mjs";
import { readJsonFile, writeJsonFile } from "./token-store.mjs";

function normalizeStore(payload) {
  if (!payload || typeof payload !== "object" || !payload.items || typeof payload.items !== "object") {
    return { items: {} };
  }
  return {
    items: { ...payload.items },
  };
}

function scopeKey(accountId, documentId) {
  return `${accountId || "default"}::${documentId}`;
}

export function fingerprintDocumentComment(comment) {
  const payload = [
    String(comment?.comment_id || ""),
    String(comment?.update_time || ""),
    String(comment?.latest_reply_text || ""),
    String(comment?.is_solved || false),
  ].join("::");
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

async function loadStore() {
  return normalizeStore(await readJsonFile(docCommentWatchStorePath));
}

export async function listUnseenDocumentComments({ accountId, documentId, comments = [] }) {
  const store = await loadStore();
  const key = scopeKey(accountId, documentId);
  const bucket = store.items[key]?.fingerprints || {};

  return comments.filter((comment) => !bucket[fingerprintDocumentComment(comment)]);
}

export async function markDocumentCommentsSeen({ accountId, documentId, comments = [] }) {
  const store = await loadStore();
  const key = scopeKey(accountId, documentId);
  const bucket = { ...(store.items[key]?.fingerprints || {}) };
  const seenAt = new Date().toISOString();

  for (const comment of comments) {
    bucket[fingerprintDocumentComment(comment)] = seenAt;
  }

  store.items[key] = {
    fingerprints: bucket,
    updated_at: seenAt,
  };

  await writeJsonFile(docCommentWatchStorePath, store);

  return {
    scope_key: key,
    seen_count: comments.length,
    updated_at: seenAt,
  };
}
