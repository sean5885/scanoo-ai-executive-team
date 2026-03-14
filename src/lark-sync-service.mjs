import {
  upsertSource,
  getDocumentByExternalKey,
  upsertDocument,
  replaceDocumentChunks,
  markMissingDocumentsInactive,
  createSyncJob,
  finishSyncJob,
  getSyncSummary,
  touchDocumentSeen,
} from "./rag-repository.mjs";
import { chunkText } from "./chunking.mjs";
import { fetchDocxPlainText, listAllWikiSpaces, scanDriveTree, scanWikiSpaceTree } from "./lark-connectors.mjs";
import { normalizeText, nowIso, sha256 } from "./text-utils.mjs";

function buildDocumentMeta(record, rawText) {
  return {
    source_type: record.source_type === "wiki" ? "wiki" : record.type === "docx" ? "docx" : "drive",
    title: record.title,
    url: record.url,
    file_token: record.file_token || null,
    node_id: record.node_id || null,
    updated_at: record.updated_at_remote || null,
    parent_path: record.parent_path || "/",
    type: record.type,
  };
}

function canExtractText(record) {
  return record.type === "docx";
}

async function upsertTextDocument(accountId, sourceRow, record, rawText) {
  const normalized = normalizeText(rawText);
  const indexedSourceType = record.source_type === "wiki" ? "wiki" : "docx";
  const document = upsertDocument({
    account_id: accountId,
    source_id: sourceRow.id,
    source_type: indexedSourceType,
    external_key: record.external_key,
    external_id: record.external_id,
    file_token: record.file_token,
    node_id: record.node_id,
    document_id: record.document_id || record.file_token,
    space_id: record.space_id || null,
    title: record.title,
    url: record.url,
    parent_path: record.parent_path,
    revision: record.revision,
    updated_at_remote: record.updated_at_remote,
    content_hash: sha256(normalized),
    raw_text: normalized,
    meta_json: buildDocumentMeta(record, normalized),
    active: 1,
  });

  replaceDocumentChunks(document, chunkText(normalized));
  return document;
}

async function syncScannedRecords(accountId, accessToken, records, mode, stats) {
  for (const record of records) {
    const sourceRow = upsertSource({
      account_id: accountId,
      source_type: record.source_type,
      external_key: record.external_key,
      external_id: record.external_id,
      title: record.title,
      url: record.url,
      parent_external_key: record.parent_external_key,
      parent_path: record.parent_path,
      updated_at_remote: record.updated_at_remote,
      meta_json: buildDocumentMeta(record),
    });

    stats.sources_seen += 1;

    if (!canExtractText(record)) {
      continue;
    }

    const existing = getDocumentByExternalKey(accountId, record.external_key);
    const shouldFetch =
      mode === "full" ||
      !existing ||
      existing.title !== record.title ||
      existing.updated_at_remote !== record.updated_at_remote ||
      existing.revision !== record.revision ||
      !existing.raw_text;

    if (!shouldFetch) {
      touchDocumentSeen(accountId, record.external_key, record.title, record.updated_at_remote, record.revision);
      stats.documents_skipped += 1;
      continue;
    }

    const rawText = await fetchDocxPlainText(accessToken, record.document_id || record.file_token);
    await upsertTextDocument(accountId, sourceRow, record, rawText);
    stats.documents_indexed += 1;
  }
}

export async function runSync({ account, accessToken, mode = "full" }) {
  const jobId = createSyncJob(account.id, mode, {});
  const syncStartedAt = nowIso();
  const stats = {
    mode,
    sources_seen: 0,
    documents_indexed: 0,
    documents_skipped: 0,
    spaces_seen: 0,
    inactive_marked: 0,
  };

  try {
    const driveRecords = await scanDriveTree(accessToken, undefined, [], true);
    const spaces = await listAllWikiSpaces(accessToken);
    stats.spaces_seen = spaces.length;

    const wikiRecords = [];
    for (const space of spaces) {
      upsertSource({
        account_id: account.id,
        source_type: "wiki_space",
        external_key: space.external_key,
        external_id: space.space_id,
        title: space.name,
        url: space.url,
        parent_path: `/${space.name}`,
        updated_at_remote: null,
        meta_json: {
          source_type: "wiki_space",
          space_id: space.space_id,
          space_type: space.space_type,
          visibility: space.visibility,
        },
      });
      const nodes = await scanWikiSpaceTree(accessToken, space, undefined, []);
      wikiRecords.push(...nodes);
    }

    await syncScannedRecords(account.id, accessToken, driveRecords, mode, stats);
    await syncScannedRecords(account.id, accessToken, wikiRecords, mode, stats);

    stats.inactive_marked = markMissingDocumentsInactive(account.id, syncStartedAt);
    stats.totals = getSyncSummary(account.id);

    finishSyncJob(jobId, "success", stats, null);
    return { job_id: jobId, ...stats };
  } catch (error) {
    finishSyncJob(jobId, "failed", stats, error.message);
    throw error;
  }
}
