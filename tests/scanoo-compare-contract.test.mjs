import test from "node:test";
import assert from "node:assert/strict";
import { buildScanooCompareBrief } from "../src/lane-executor.mjs";

test("scanoo-compare brief keeps the required compare contract headings", () => {
  const brief = buildScanooCompareBrief("比較 A 店和 B 店的表現");

  assert.ok(brief.includes("【比較對象】"));
  assert.ok(brief.includes("【比較維度】"));
  assert.ok(brief.includes("【核心差異】"));
  assert.ok(brief.includes("【原因假設】"));
  assert.ok(brief.includes("【證據 / 不確定性】"));
  assert.ok(brief.includes("【建議行動】"));
  assert.ok(brief.includes("使用者問題："));
  assert.ok(brief.includes("比較 A 店和 B 店的表現"));
});
