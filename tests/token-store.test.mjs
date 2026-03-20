import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "../src/token-store.mjs";

test("readJsonFile returns null for malformed json state files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lobster-token-store-"));
  const filePath = path.join(tempDir, "broken.json");
  await fs.writeFile(filePath, '{"broken":', "utf8");

  const value = await readJsonFile(filePath);
  assert.equal(value, null);
});
