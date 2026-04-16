import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";
import { buildScanooDiagnoseBrief } from "../src/lane-executor.mjs";

const testDb = await createTestDbHarness();

test.after(() => {
  testDb.close();
});

test("scanoo-diagnose brief keeps the required diagnose contract headings", () => {
  const brief = buildScanooDiagnoseBrief("最近 Scanoo 門店轉化突然下滑，幫我診斷");

  assert.ok(brief.includes("【問題現象】"));
  assert.ok(brief.includes("【可能原因】"));
  assert.ok(brief.includes("【目前證據】"));
  assert.ok(brief.includes("【不確定性】"));
  assert.ok(brief.includes("【建議下一步】"));
  assert.ok(brief.includes("使用者問題："));
  assert.ok(brief.includes("最近 Scanoo 門店轉化突然下滑，幫我診斷"));
});
