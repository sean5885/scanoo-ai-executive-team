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
