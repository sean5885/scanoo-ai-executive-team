import test from "node:test";
import assert from "node:assert/strict";

import { applyHeadingTargetedInsert, DocumentTargetingError } from "../src/doc-targeting.mjs";

test("applyHeadingTargetedInsert appends into the matched heading section", () => {
  const document = [
    "# 第一部分",
    "Alpha",
    "",
    "# 第二部分",
    "Beta",
    "",
    "## 第二部分子節",
    "Nested",
    "",
    "# 第三部分",
    "Gamma",
  ].join("\n");

  const result = applyHeadingTargetedInsert(document, "New line", {
    heading: "第二部分",
  });

  assert.equal(result.targeting.type, "heading");
  assert.equal(result.targeting.matched_heading, "第二部分");
  assert.equal(
    result.content,
    [
      "# 第一部分",
      "Alpha",
      "",
      "# 第二部分",
      "Beta",
      "",
      "## 第二部分子節",
      "Nested",
      "",
      "New line",
      "",
      "# 第三部分",
      "Gamma",
    ].join("\n"),
  );
});

test("applyHeadingTargetedInsert can insert immediately after the matched heading", () => {
  const document = [
    "# 第一部分",
    "Alpha",
    "",
    "# 第二部分",
    "Beta",
  ].join("\n");

  const result = applyHeadingTargetedInsert(document, "Intro", {
    heading: "第二部分",
    position: "after_heading",
  });

  assert.equal(
    result.content,
    [
      "# 第一部分",
      "Alpha",
      "",
      "# 第二部分",
      "",
      "Intro",
      "",
      "Beta",
    ].join("\n"),
  );
});

test("applyHeadingTargetedInsert fails when the heading is ambiguous", () => {
  assert.throws(
    () => applyHeadingTargetedInsert("# 第二部分\nA\n\n# 第二部分\nB", "New line", { heading: "第二部分" }),
    (error) => {
      assert.equal(error instanceof DocumentTargetingError, true);
      assert.equal(error.code, "target_heading_ambiguous");
      assert.equal(Array.isArray(error.details?.matches), true);
      return true;
    },
  );
});
