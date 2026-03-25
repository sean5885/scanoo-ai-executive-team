import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

export function createTestDb() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "playground-test-db-"));
  const dbPath = path.join(tempDir, "test.sqlite");
  const db = new Database(dbPath);
  return {
    db,
    dbPath,
    close: () => {
      try { db.close(); } catch {}
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    },
  };
}

export async function createTestDbHarness() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "playground-test-db-"));
  const dbPath = path.join(tempDir, "test.sqlite");
  process.env.RAG_SQLITE_PATH = dbPath;

  const dbModule = await import("../../src/db.mjs");

  return {
    db: dbModule.default,
    dbPath,
    env: {
      ...process.env,
      RAG_SQLITE_PATH: dbPath,
    },
    closeRuntimeDb: () => {
      dbModule.closeDbForTests();
    },
    close: () => {
      dbModule.closeDbForTests();
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
      delete process.env.RAG_SQLITE_PATH;
    },
  };
}
