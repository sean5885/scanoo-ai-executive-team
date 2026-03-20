import crypto from "node:crypto";
import db from "./db.mjs";
import { embeddingDimensions, tokenEncryptionSecret } from "./config.mjs";
import { decryptSecretValue, encryptSecretValue } from "./secret-crypto.mjs";
import { cosineSimilarity, embedTextLocally } from "./semantic-embeddings.mjs";
import { nowIso } from "./text-utils.mjs";

function id() {
  return crypto.randomUUID();
}

export function upsertAccount(profile, scope = "") {
  const timestamp = nowIso();
  const existing = db
    .prepare("SELECT id FROM lark_accounts WHERE open_id = ?")
    .get(profile.open_id || null);
  const accountId = existing?.id || id();

  db.prepare(`
    INSERT INTO lark_accounts (
      id, open_id, user_id, union_id, tenant_key, name, email, scope, created_at, updated_at
    ) VALUES (
      @id, @open_id, @user_id, @union_id, @tenant_key, @name, @email, @scope, @created_at, @updated_at
    )
    ON CONFLICT(open_id) DO UPDATE SET
      user_id = excluded.user_id,
      union_id = excluded.union_id,
      tenant_key = excluded.tenant_key,
      name = excluded.name,
      email = excluded.email,
      scope = excluded.scope,
      updated_at = excluded.updated_at
  `).run({
    id: accountId,
    open_id: profile.open_id || null,
    user_id: profile.user_id || null,
    union_id: profile.union_id || null,
    tenant_key: profile.tenant_key || null,
    name: profile.name || profile.en_name || null,
    email: profile.email || profile.enterprise_email || null,
    scope,
    created_at: timestamp,
    updated_at: timestamp,
  });

  return getAccount(accountId);
}

export function saveToken(accountId, token) {
  const timestamp = nowIso();
  db.prepare("DELETE FROM lark_tokens WHERE account_id = ?").run(accountId);
  const tokenId = id();
  db.prepare(`
    INSERT INTO lark_tokens (
      id, account_id, access_token, refresh_token, token_type, scope,
      expires_at, refresh_expires_at, created_at, updated_at
    ) VALUES (
      @id, @account_id, @access_token, @refresh_token, @token_type, @scope,
      @expires_at, @refresh_expires_at, @created_at, @updated_at
    )
  `).run({
    id: tokenId,
    account_id: accountId,
    access_token: encryptSecretValue(token.access_token, tokenEncryptionSecret),
    refresh_token: encryptSecretValue(token.refresh_token, tokenEncryptionSecret),
    token_type: token.token_type,
    scope: token.scope,
    expires_at: token.expires_at,
    refresh_expires_at: token.refresh_expires_at,
    created_at: timestamp,
    updated_at: timestamp,
  });

  return getTokenForAccount(accountId);
}

export function getAccount(accountId) {
  return db.prepare("SELECT * FROM lark_accounts WHERE id = ?").get(accountId) || null;
}

export function getAccountByOpenId(openId) {
  if (!openId) {
    return null;
  }
  return db.prepare("SELECT * FROM lark_accounts WHERE open_id = ?").get(openId) || null;
}

export function getLatestAccount() {
  return db.prepare("SELECT * FROM lark_accounts ORDER BY updated_at DESC LIMIT 1").get() || null;
}

export function getTokenForAccount(accountId) {
  const token = db
    .prepare("SELECT * FROM lark_tokens WHERE account_id = ? ORDER BY updated_at DESC LIMIT 1")
    .get(accountId) || null;
  if (!token) {
    return null;
  }

  return {
    ...token,
    access_token: decryptSecretValue(token.access_token, tokenEncryptionSecret),
    refresh_token: decryptSecretValue(token.refresh_token, tokenEncryptionSecret),
  };
}

export function getAccountContext(accountId) {
  const account = accountId ? getAccount(accountId) : getLatestAccount();
  if (!account) {
    return null;
  }

  const token = getTokenForAccount(account.id);
  return token ? { account, token } : null;
}

export function getAccountContextByOpenId(openId) {
  const account = getAccountByOpenId(openId);
  if (!account) {
    return null;
  }
  const token = getTokenForAccount(account.id);
  return token ? { account, token } : null;
}

export function getAccountPreference(accountId, prefKey) {
  if (!accountId || !prefKey) {
    return null;
  }
  const row = db
    .prepare("SELECT pref_value FROM account_preferences WHERE account_id = ? AND pref_key = ?")
    .get(accountId, prefKey);
  return row?.pref_value ?? null;
}

export function setAccountPreference(accountId, prefKey, prefValue) {
  if (!accountId || !prefKey) {
    return null;
  }
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO account_preferences (
      account_id, pref_key, pref_value, created_at, updated_at
    ) VALUES (
      @account_id, @pref_key, @pref_value, @created_at, @updated_at
    )
    ON CONFLICT(account_id, pref_key) DO UPDATE SET
      pref_value = excluded.pref_value,
      updated_at = excluded.updated_at
  `).run({
    account_id: accountId,
    pref_key: prefKey,
    pref_value: prefValue ?? null,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return getAccountPreference(accountId, prefKey);
}

export function createSyncJob(accountId, mode, cursor = {}) {
  const timestamp = nowIso();
  const jobId = id();
  db.prepare(`
    INSERT INTO sync_jobs (
      id, account_id, mode, status, started_at, cursor_json, created_at, updated_at
    ) VALUES (
      @id, @account_id, @mode, 'running', @started_at, @cursor_json, @created_at, @updated_at
    )
  `).run({
    id: jobId,
    account_id: accountId,
    mode,
    started_at: timestamp,
    cursor_json: JSON.stringify(cursor),
    created_at: timestamp,
    updated_at: timestamp,
  });
  return jobId;
}

export function finishSyncJob(jobId, status, summary = {}, errorText = null) {
  const timestamp = nowIso();
  db.prepare(`
    UPDATE sync_jobs
    SET status = @status,
        finished_at = @finished_at,
        summary_json = @summary_json,
        error_text = @error_text,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: jobId,
    status,
    finished_at: timestamp,
    summary_json: JSON.stringify(summary),
    error_text: errorText,
    updated_at: timestamp,
  });
}

export function upsertSource(source) {
  const timestamp = nowIso();
  const existing = db
    .prepare("SELECT id FROM lark_sources WHERE account_id = ? AND external_key = ?")
    .get(source.account_id, source.external_key);
  const sourceId = existing?.id || id();

  db.prepare(`
    INSERT INTO lark_sources (
      id, account_id, source_type, external_key, external_id, title, url, parent_external_key,
      parent_path, updated_at_remote, acl_json, meta_json, active, last_synced_at, created_at, updated_at
    ) VALUES (
      @id, @account_id, @source_type, @external_key, @external_id, @title, @url, @parent_external_key,
      @parent_path, @updated_at_remote, @acl_json, @meta_json, 1, @last_synced_at, @created_at, @updated_at
    )
    ON CONFLICT(account_id, external_key) DO UPDATE SET
      source_type = excluded.source_type,
      external_id = excluded.external_id,
      title = excluded.title,
      url = excluded.url,
      parent_external_key = excluded.parent_external_key,
      parent_path = excluded.parent_path,
      updated_at_remote = excluded.updated_at_remote,
      acl_json = excluded.acl_json,
      meta_json = excluded.meta_json,
      active = 1,
      last_synced_at = excluded.last_synced_at,
      updated_at = excluded.updated_at
  `).run({
    id: sourceId,
    account_id: source.account_id,
    source_type: source.source_type,
    external_key: source.external_key,
    external_id: source.external_id || null,
    title: source.title || null,
    url: source.url || null,
    parent_external_key: source.parent_external_key || null,
    parent_path: source.parent_path || "/",
    updated_at_remote: source.updated_at_remote || null,
    acl_json: source.acl_json ? JSON.stringify(source.acl_json) : null,
    meta_json: source.meta_json ? JSON.stringify(source.meta_json) : null,
    last_synced_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  });

  return db
    .prepare("SELECT * FROM lark_sources WHERE account_id = ? AND external_key = ?")
    .get(source.account_id, source.external_key);
}

export function getDocumentByExternalKey(accountId, externalKey) {
  return db
    .prepare("SELECT * FROM lark_documents WHERE account_id = ? AND external_key = ?")
    .get(accountId, externalKey) || null;
}

export function getDocumentByDocumentId(accountId, documentId) {
  return db
    .prepare("SELECT * FROM lark_documents WHERE account_id = ? AND document_id = ?")
    .get(accountId, documentId) || null;
}

export function listDocumentsByStatus(accountId, status, limit = 50) {
  return db.prepare(`
    SELECT
      document_id,
      external_key,
      status,
      failure_reason,
      indexed_at,
      verified_at,
      created_at,
      updated_at
    FROM lark_documents
    WHERE account_id = ?
      AND status = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(accountId, status, limit);
}

export function summarizeDocumentLifecycle(accountId) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM lark_documents
    WHERE account_id = ?
      AND status IS NOT NULL
    GROUP BY status
  `).all(accountId);

  const summary = {
    created: 0,
    indexed: 0,
    verified: 0,
    create_failed: 0,
    index_failed: 0,
    verify_failed: 0,
  };

  for (const row of rows) {
    if (row?.status in summary) {
      summary[row.status] = row.count || 0;
    }
  }

  return summary;
}

export function upsertCompanyBrainDoc({ account_id, doc_id, title, source, created_at, creator }) {
  const timestamp = nowIso();
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
    account_id,
    doc_id,
    title: title || null,
    source: source || null,
    created_at: created_at || null,
    creator_json: JSON.stringify(creator || { account_id: null, open_id: null }),
    updated_at: timestamp,
  });

  return db
    .prepare("SELECT account_id, doc_id, title, source, created_at, creator_json, updated_at FROM company_brain_docs WHERE account_id = ? AND doc_id = ?")
    .get(account_id, doc_id) || null;
}

// Keep read-side field selection and query execution centralized so the
// list/detail/search routes stay aligned while Phase 1 only improves clarity.
const companyBrainDocReadFields = `
  doc_id,
  title,
  source,
  created_at,
  creator_json
`;

const companyBrainDocQueryFields = `
  cb.doc_id,
  cb.title,
  cb.source,
  cb.created_at,
  cb.creator_json,
  cb.updated_at,
  d.raw_text,
  d.url,
  d.parent_path
`;

function runCompanyBrainReadQuery({ sql, params = [], mode = "all" }) {
  const statement = db.prepare(sql);
  if (mode === "get") {
    return statement.get(...params) || null;
  }
  return statement.all(...params);
}

function buildCompanyBrainReadSelectSql(whereClause, suffix = "") {
  return `
    SELECT
      ${companyBrainDocReadFields}
    FROM company_brain_docs
    WHERE ${whereClause}
    ${suffix}
  `;
}

function buildCompanyBrainQuerySelectSql(whereClause, suffix = "") {
  return `
    SELECT
      ${companyBrainDocQueryFields}
    FROM company_brain_docs cb
    LEFT JOIN lark_documents d
      ON d.account_id = cb.account_id
      AND d.document_id = cb.doc_id
      AND d.active = 1
    WHERE ${whereClause}
    ${suffix}
  `;
}

export function listCompanyBrainDocs(accountId, limit = 50) {
  return runCompanyBrainReadQuery({
    sql: buildCompanyBrainReadSelectSql("account_id = ?", "ORDER BY updated_at DESC LIMIT ?"),
    params: [accountId, limit],
  });
}

export function getCompanyBrainDoc(accountId, docId) {
  return runCompanyBrainReadQuery({
    sql: buildCompanyBrainReadSelectSql("account_id = ? AND doc_id = ?", "LIMIT 1"),
    params: [accountId, docId],
    mode: "get",
  });
}

export function searchCompanyBrainDocs(accountId, query, limit = 50) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    return [];
  }

  const likeQuery = `%${normalizedQuery}%`;
  return runCompanyBrainReadQuery({
    sql: buildCompanyBrainReadSelectSql(
      `account_id = ?
      AND (
        doc_id = ?
        OR doc_id LIKE ?
        OR title LIKE ?
      )`,
      "ORDER BY updated_at DESC LIMIT ?",
    ),
    params: [accountId, normalizedQuery, likeQuery, likeQuery, limit],
  });
}

export function listCompanyBrainDocQueryRecords(accountId, limit = null) {
  const hasLimit = limit !== null && limit !== undefined && Number.isFinite(Number(limit));
  const suffix = hasLimit
    ? "ORDER BY cb.updated_at DESC LIMIT ?"
    : "ORDER BY cb.updated_at DESC";
  const params = hasLimit
    ? [accountId, Number(limit)]
    : [accountId];
  return runCompanyBrainReadQuery({
    sql: buildCompanyBrainQuerySelectSql("cb.account_id = ?", suffix),
    params,
  });
}

export function getCompanyBrainDocQueryRecord(accountId, docId) {
  return runCompanyBrainReadQuery({
    sql: buildCompanyBrainQuerySelectSql("cb.account_id = ? AND cb.doc_id = ?", "LIMIT 1"),
    params: [accountId, docId],
    mode: "get",
  });
}

export function upsertDocument(document) {
  const timestamp = nowIso();
  const existing = getDocumentByExternalKey(document.account_id, document.external_key);
  const documentId = existing?.id || id();

  db.prepare(`
    INSERT INTO lark_documents (
      id, account_id, source_id, source_type, external_key, external_id, file_token, node_id,
      document_id, space_id, title, url, parent_path, revision, updated_at_remote, content_hash,
      raw_text, inactive_reason, acl_json, meta_json, active, status, indexed_at, verified_at, failure_reason, synced_at, created_at, updated_at
    ) VALUES (
      @id, @account_id, @source_id, @source_type, @external_key, @external_id, @file_token, @node_id,
      @document_id, @space_id, @title, @url, @parent_path, @revision, @updated_at_remote, @content_hash,
      @raw_text, NULL, @acl_json, @meta_json, @active, @status, @indexed_at, @verified_at, @failure_reason, @synced_at, @created_at, @updated_at
    )
    ON CONFLICT(account_id, external_key) DO UPDATE SET
      source_id = excluded.source_id,
      source_type = excluded.source_type,
      external_id = excluded.external_id,
      file_token = excluded.file_token,
      node_id = excluded.node_id,
      document_id = excluded.document_id,
      space_id = excluded.space_id,
      title = excluded.title,
      url = excluded.url,
      parent_path = excluded.parent_path,
      revision = excluded.revision,
      updated_at_remote = excluded.updated_at_remote,
      content_hash = excluded.content_hash,
      raw_text = excluded.raw_text,
      inactive_reason = NULL,
      acl_json = excluded.acl_json,
      meta_json = excluded.meta_json,
      active = excluded.active,
      status = excluded.status,
      indexed_at = excluded.indexed_at,
      verified_at = excluded.verified_at,
      failure_reason = excluded.failure_reason,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at
  `).run({
    id: documentId,
    account_id: document.account_id,
    source_id: document.source_id || null,
    source_type: document.source_type,
    external_key: document.external_key,
    external_id: document.external_id || null,
    file_token: document.file_token || null,
    node_id: document.node_id || null,
    document_id: document.document_id || null,
    space_id: document.space_id || null,
    title: document.title || null,
    url: document.url || null,
    parent_path: document.parent_path || "/",
    revision: document.revision || null,
    updated_at_remote: document.updated_at_remote || null,
    content_hash: document.content_hash || null,
    raw_text: document.raw_text || null,
    acl_json: document.acl_json ? JSON.stringify(document.acl_json) : null,
    meta_json: document.meta_json ? JSON.stringify(document.meta_json) : null,
    active: document.active ?? 1,
    status: document.status || null,
    indexed_at: document.indexed_at || null,
    verified_at: document.verified_at || null,
    failure_reason: document.failure_reason || null,
    synced_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  });

  return db.prepare("SELECT * FROM lark_documents WHERE id = ?").get(documentId);
}

export function runRepositoryTransaction(callback) {
  return db.transaction(callback)();
}

export function touchDocumentSeen(accountId, externalKey, title, updatedAtRemote, revision) {
  const timestamp = nowIso();
  db.prepare(`
    UPDATE lark_documents
    SET active = 1,
        inactive_reason = NULL,
        title = COALESCE(@title, title),
        updated_at_remote = COALESCE(@updated_at_remote, updated_at_remote),
        revision = COALESCE(@revision, revision),
        synced_at = @synced_at,
        updated_at = @updated_at
    WHERE account_id = @account_id
      AND external_key = @external_key
  `).run({
    account_id: accountId,
    external_key: externalKey,
    title: title || null,
    updated_at_remote: updatedAtRemote || null,
    revision: revision || null,
    synced_at: timestamp,
    updated_at: timestamp,
  });
}

export function replaceDocumentChunks(document, chunks) {
  const timestamp = nowIso();
  const deleteFts = db.prepare("DELETE FROM lark_chunks_fts WHERE chunk_id = ?");
  const deleteEmbedding = db.prepare("DELETE FROM lark_chunk_embeddings WHERE chunk_id = ?");
  const deleteChunk = db.prepare("DELETE FROM lark_chunks WHERE document_id = ?");
  const insertChunk = db.prepare(`
    INSERT INTO lark_chunks (
      id, document_id, account_id, chunk_index, source_type, title, url, external_key,
      parent_path, updated_at, content, content_norm, char_count, chunk_hash, acl_json,
      meta_json, active, created_at, updated_at_local
    ) VALUES (
      @id, @document_id, @account_id, @chunk_index, @source_type, @title, @url, @external_key,
      @parent_path, @updated_at, @content, @content_norm, @char_count, @chunk_hash, @acl_json,
      @meta_json, 1, @created_at, @updated_at_local
    )
  `);
  const insertFts = db.prepare(`
    INSERT INTO lark_chunks_fts (chunk_id, account_id, title, content, parent_path, url)
    VALUES (@chunk_id, @account_id, @title, @content, @parent_path, @url)
  `);
  const insertEmbedding = db.prepare(`
    INSERT INTO lark_chunk_embeddings (
      chunk_id, account_id, dimensions, embedding_json, model, updated_at
    ) VALUES (
      @chunk_id, @account_id, @dimensions, @embedding_json, @model, @updated_at
    )
  `);

  const previousChunkIds = db
    .prepare("SELECT id FROM lark_chunks WHERE document_id = ?")
    .all(document.id);

  const tx = db.transaction(() => {
    for (const chunk of previousChunkIds) {
      deleteFts.run(chunk.id);
      deleteEmbedding.run(chunk.id);
    }
    deleteChunk.run(document.id);

    for (const chunk of chunks) {
      const chunkId = id();
      const embedding = embedTextLocally(chunk.content_norm, embeddingDimensions);
      insertChunk.run({
        id: chunkId,
        document_id: document.id,
        account_id: document.account_id,
        chunk_index: chunk.chunk_index,
        source_type: document.source_type,
        title: document.title,
        url: document.url,
        external_key: document.external_key,
        parent_path: document.parent_path,
        updated_at: document.updated_at_remote,
        content: chunk.content,
        content_norm: chunk.content_norm,
        char_count: chunk.char_count,
        chunk_hash: chunk.chunk_hash,
        acl_json: document.acl_json || null,
        meta_json: document.meta_json || null,
        created_at: timestamp,
        updated_at_local: timestamp,
      });
      insertFts.run({
        chunk_id: chunkId,
        account_id: document.account_id,
        title: document.title || "",
        content: chunk.content_norm,
        parent_path: document.parent_path || "/",
        url: document.url || "",
      });
      insertEmbedding.run({
        chunk_id: chunkId,
        account_id: document.account_id,
        dimensions: embeddingDimensions,
        embedding_json: JSON.stringify(embedding),
        model: "local-hash-v1",
        updated_at: timestamp,
      });
    }
  });

  tx();
}

export function markMissingDocumentsInactive(accountId, syncStartedAt) {
  const timestamp = nowIso();
  const result = db.prepare(`
    UPDATE lark_documents
    SET active = 0,
        inactive_reason = 'not_seen_in_sync',
        updated_at = @updated_at
    WHERE account_id = @account_id
      AND active = 1
      AND (synced_at IS NULL OR synced_at < @sync_started_at)
  `).run({
    updated_at: timestamp,
    account_id: accountId,
    sync_started_at: syncStartedAt,
  });

  db.prepare(`
    UPDATE lark_sources
    SET active = 0,
        updated_at = @updated_at
    WHERE account_id = @account_id
      AND active = 1
      AND (last_synced_at IS NULL OR last_synced_at < @sync_started_at)
  `).run({
    updated_at: timestamp,
    account_id: accountId,
    sync_started_at: syncStartedAt,
  });

  return result.changes;
}

export function searchChunks(accountId, matchQuery, limit) {
  if (!matchQuery) {
    return [];
  }

  return db.prepare(`
    SELECT
      c.id,
      c.document_id,
      c.chunk_index,
      c.content,
      c.source_type,
      c.title,
      c.url,
      c.parent_path,
      c.updated_at,
      c.external_key,
      d.file_token,
      d.node_id,
      bm25(lark_chunks_fts) AS rank
    FROM lark_chunks_fts
    JOIN lark_chunks c ON c.id = lark_chunks_fts.chunk_id
    JOIN lark_documents d ON d.id = c.document_id
    WHERE lark_chunks_fts.account_id = ?
      AND lark_chunks_fts MATCH ?
      AND c.active = 1
      AND d.active = 1
    ORDER BY rank
    LIMIT ?
  `).all(accountId, matchQuery, limit);
}

export function searchChunksBySubstring(accountId, rawQuery, limit) {
  const normalizedQuery = String(rawQuery || "").trim();
  if (!normalizedQuery) {
    return [];
  }

  return db.prepare(`
    SELECT
      c.id,
      c.document_id,
      c.chunk_index,
      c.content,
      c.source_type,
      c.title,
      c.url,
      c.parent_path,
      c.updated_at,
      c.external_key,
      d.file_token,
      d.node_id,
      0 AS rank
    FROM lark_chunks c
    JOIN lark_documents d ON d.id = c.document_id
    WHERE c.account_id = @account_id
      AND c.active = 1
      AND d.active = 1
      AND (
        c.title LIKE @pattern
        OR c.content LIKE @pattern
        OR c.parent_path LIKE @pattern
      )
    ORDER BY c.updated_at DESC, c.chunk_index ASC
    LIMIT @limit
  `).all({
    account_id: accountId,
    pattern: `%${normalizedQuery}%`,
    limit,
  });
}

export function searchChunksBySemantic(accountId, rawQuery, limit) {
  const normalizedQuery = String(rawQuery || "").trim();
  if (!normalizedQuery) {
    return [];
  }

  const queryEmbedding = embedTextLocally(normalizedQuery, embeddingDimensions);
  const rows = db.prepare(`
    SELECT
      c.id,
      c.document_id,
      c.chunk_index,
      c.content,
      c.source_type,
      c.title,
      c.url,
      c.parent_path,
      c.updated_at,
      c.external_key,
      d.file_token,
      d.node_id,
      e.embedding_json
    FROM lark_chunk_embeddings e
    JOIN lark_chunks c ON c.id = e.chunk_id
    JOIN lark_documents d ON d.id = c.document_id
    WHERE e.account_id = ?
      AND c.active = 1
      AND d.active = 1
  `).all(accountId);

  return rows
    .map((item) => ({
      ...item,
      rank: 1 - cosineSimilarity(queryEmbedding, JSON.parse(item.embedding_json || "[]")),
    }))
    .sort((left, right) => left.rank - right.rank)
    .slice(0, limit)
    .map(({ embedding_json, ...item }) => item);
}

export function getSyncSummary(accountId) {
  return db.prepare(`
    SELECT
      COUNT(*) AS documents,
      SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_documents
    FROM lark_documents
    WHERE account_id = ?
  `).get(accountId);
}

export function listIndexedDocumentsForOrganization(accountId, limit = 400) {
  return db.prepare(`
    SELECT
      id,
      title,
      url,
      parent_path,
      source_type,
      raw_text,
      document_id,
      file_token,
      node_id,
      space_id,
      synced_at,
      updated_at_remote
    FROM lark_documents
    WHERE account_id = ?
      AND active = 1
      AND COALESCE(TRIM(raw_text), '') <> ''
    ORDER BY
      COALESCE(updated_at_remote, synced_at, updated_at) DESC
    LIMIT ?
  `).all(accountId, limit);
}
