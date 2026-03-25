import Database from "better-sqlite3";

export function createTestDb() {
  const db = new Database(":memory:");
  return {
    db,
    close: () => {
      try {
        db.close();
      } catch {}
    },
  };
}
