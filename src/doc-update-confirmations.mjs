import crypto from "node:crypto";
import { docUpdateConfirmationStorePath } from "./config.mjs";
import {
  buildCommentRewritePreviewCard,
  buildDocumentReplacePreviewCard,
} from "./doc-preview-cards.mjs";
import { readJsonFile, writeJsonFile } from "./token-store.mjs";

const CONFIRMATION_TTL_MS = 15 * 60 * 1000;

function normalizeStore(payload) {
  if (!payload || typeof payload !== "object" || !payload.items || typeof payload.items !== "object") {
    return { items: {} };
  }
  return {
    items: { ...payload.items },
  };
}

function hashContent(content) {
  return crypto.createHash("sha256").update(String(content || ""), "utf8").digest("hex");
}

function buildExcerpt(content, limit = 600) {
  const normalized = String(content || "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
}

async function loadStore() {
  const existing = await readJsonFile(docUpdateConfirmationStorePath);
  const store = normalizeStore(existing);
  const now = Date.now();
  let changed = false;

  for (const [id, item] of Object.entries(store.items)) {
    const expiresAt = Date.parse(item?.expires_at || "");
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      delete store.items[id];
      changed = true;
    }
  }

  if (changed) {
    await writeJsonFile(docUpdateConfirmationStorePath, store);
  }

  return store;
}

export async function createDocumentReplaceConfirmation({
  accountId,
  documentId,
  title,
  currentRevisionId,
  currentContent,
  proposedContent,
}) {
  const store = await loadStore();
  const confirmationId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString();

  store.items[confirmationId] = {
    account_id: accountId || null,
    document_id: documentId,
    title: title || null,
    current_revision_id: currentRevisionId || null,
    content_hash: hashContent(proposedContent),
    created_at: createdAt,
    expires_at: expiresAt,
  };

  await writeJsonFile(docUpdateConfirmationStorePath, store);

  return {
    confirmation_id: confirmationId,
    confirmation_type: "document_replace",
    created_at: createdAt,
    expires_at: expiresAt,
    preview: {
      document_id: documentId,
      title: title || null,
      current_revision_id: currentRevisionId || null,
      current_length: String(currentContent || "").length,
      proposed_length: String(proposedContent || "").length,
      current_excerpt: buildExcerpt(currentContent),
      proposed_excerpt: buildExcerpt(proposedContent),
    },
    preview_card: buildDocumentReplacePreviewCard({
      title,
      currentLength: String(currentContent || "").length,
      proposedLength: String(proposedContent || "").length,
      currentExcerpt: buildExcerpt(currentContent),
      proposedExcerpt: buildExcerpt(proposedContent),
    }),
  };
}

export async function consumeDocumentReplaceConfirmation({
  confirmationId,
  accountId,
  documentId,
  proposedContent,
}) {
  const store = await loadStore();
  const entry = store.items[confirmationId];
  if (!entry) {
    return null;
  }

  if ((entry.account_id || null) !== (accountId || null)) {
    return null;
  }
  if (entry.document_id !== documentId) {
    return null;
  }
  if (entry.content_hash !== hashContent(proposedContent)) {
    return null;
  }

  delete store.items[confirmationId];
  await writeJsonFile(docUpdateConfirmationStorePath, store);
  return entry;
}

export async function createCommentRewriteConfirmation({
  accountId,
  documentId,
  title,
  currentRevisionId,
  currentContent,
  rewrittenContent,
  patchPlan = [],
  changeSummary = [],
  commentIds = [],
  comments = [],
  resolveComments = false,
}) {
  const store = await loadStore();
  const confirmationId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString();

  store.items[confirmationId] = {
    kind: "comment_rewrite",
    account_id: accountId || null,
    document_id: documentId,
    title: title || null,
    current_revision_id: currentRevisionId || null,
    rewritten_content: String(rewrittenContent || ""),
    patch_plan: Array.isArray(patchPlan) ? patchPlan : [],
    change_summary: Array.isArray(changeSummary) ? changeSummary : [],
    comment_ids: Array.isArray(commentIds) ? commentIds.filter(Boolean) : [],
    resolve_comments: Boolean(resolveComments),
    created_at: createdAt,
    expires_at: expiresAt,
  };

  await writeJsonFile(docUpdateConfirmationStorePath, store);

  return {
    confirmation_id: confirmationId,
    confirmation_type: "comment_rewrite",
    created_at: createdAt,
    expires_at: expiresAt,
    preview: {
      document_id: documentId,
      title: title || null,
      current_revision_id: currentRevisionId || null,
      current_length: String(currentContent || "").length,
      proposed_length: String(rewrittenContent || "").length,
      current_excerpt: buildExcerpt(currentContent),
      proposed_excerpt: buildExcerpt(rewrittenContent),
      patch_count: Array.isArray(patchPlan) ? patchPlan.length : 0,
      change_summary: Array.isArray(changeSummary) ? changeSummary : [],
      comment_count: Array.isArray(commentIds) ? commentIds.filter(Boolean).length : 0,
      resolve_comments: Boolean(resolveComments),
    },
    preview_card: buildCommentRewritePreviewCard({
      title,
      commentCount: Array.isArray(commentIds) ? commentIds.filter(Boolean).length : 0,
      changeSummary,
      comments,
      currentExcerpt: buildExcerpt(currentContent),
      proposedExcerpt: buildExcerpt(rewrittenContent),
      confirmationId,
    }),
  };
}

export async function consumeCommentRewriteConfirmation({
  confirmationId,
  accountId,
  documentId,
}) {
  const store = await loadStore();
  const entry = store.items[confirmationId];
  if (!entry || entry.kind !== "comment_rewrite") {
    return null;
  }
  if ((entry.account_id || null) !== (accountId || null)) {
    return null;
  }
  if (entry.document_id !== documentId) {
    return null;
  }

  delete store.items[confirmationId];
  await writeJsonFile(docUpdateConfirmationStorePath, store);
  return entry;
}
