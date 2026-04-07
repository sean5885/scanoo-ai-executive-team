import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanText } from "../message-intent-utils.mjs";

const KNOWLEDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const KNOWLEDGE_PENDING_DIR = path.join(KNOWLEDGE_DIR, "pending");
const KNOWLEDGE_APPROVED_DIR = path.join(KNOWLEDGE_DIR, "approved");

function isJsonFile(fileName = "") {
  return typeof fileName === "string" && fileName.endsWith(".json");
}

function proposalIdFromFileName(fileName = "") {
  return cleanText(String(fileName).replace(/\.json$/i, ""));
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readProposalFile(filePath = "") {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object") {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function normalizeProposalRecord(payload = null, fileName = "") {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const fallbackId = proposalIdFromFileName(fileName);
  return {
    id: cleanText(payload.id) || fallbackId,
    type: cleanText(payload.type),
    summary: cleanText(payload.summary),
    action_suggestion: cleanText(payload.action_suggestion),
    confidence: Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : null,
    created_at: cleanText(payload.created_at) || null,
  };
}

async function listProposalFiles(dirPath) {
  await ensureDir(dirPath);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isJsonFile(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function buildProposalPath(dirPath, id = "") {
  const normalizedId = cleanText(id);
  if (!normalizedId) {
    return "";
  }
  return path.join(dirPath, `${normalizedId}.json`);
}

export async function listPendingProposals({
  pending_dir = KNOWLEDGE_PENDING_DIR,
} = {}) {
  const fileNames = await listProposalFiles(pending_dir);
  const result = [];

  for (const fileName of fileNames) {
    const payload = await readProposalFile(path.join(pending_dir, fileName));
    const normalized = normalizeProposalRecord(payload, fileName);
    if (normalized?.id) {
      result.push(normalized);
    }
  }

  return result;
}

export async function approve(id, {
  pending_dir = KNOWLEDGE_PENDING_DIR,
  approved_dir = KNOWLEDGE_APPROVED_DIR,
} = {}) {
  const normalizedId = cleanText(id);
  if (!normalizedId) {
    return { ok: false, error: "invalid_id" };
  }

  await ensureDir(pending_dir);
  await ensureDir(approved_dir);

  const sourcePath = buildProposalPath(pending_dir, normalizedId);
  const destinationPath = buildProposalPath(approved_dir, normalizedId);

  try {
    await fs.access(destinationPath);
    return { ok: false, error: "already_approved", id: normalizedId };
  } catch {}

  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, error: "not_found", id: normalizedId };
    }
    return { ok: false, error: "move_failed", id: normalizedId };
  }

  const payload = await readProposalFile(destinationPath);
  return {
    ok: true,
    id: normalizedId,
    proposal: normalizeProposalRecord(payload, `${normalizedId}.json`),
  };
}

export async function reject(id, {
  pending_dir = KNOWLEDGE_PENDING_DIR,
} = {}) {
  const normalizedId = cleanText(id);
  if (!normalizedId) {
    return { ok: false, error: "invalid_id" };
  }

  await ensureDir(pending_dir);
  const filePath = buildProposalPath(pending_dir, normalizedId);

  try {
    const payload = await readProposalFile(filePath);
    await fs.unlink(filePath);
    return {
      ok: true,
      id: normalizedId,
      proposal: normalizeProposalRecord(payload, `${normalizedId}.json`),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ok: false, error: "not_found", id: normalizedId };
    }
    return { ok: false, error: "delete_failed", id: normalizedId };
  }
}
