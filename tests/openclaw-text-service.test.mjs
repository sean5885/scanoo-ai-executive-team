import test from "node:test";
import assert from "node:assert/strict";

import { normalizeAbortSignal, parseOpenClawJson } from "../src/openclaw-text-service.mjs";

test("parseOpenClawJson accepts plugin noise before trailing JSON", () => {
  const parsed = parseOpenClawJson([
    "[plugins] feishu_doc: Registered feishu_app_scopes",
    "[plugins] feishu_chat: Registered feishu_chat tool",
    '{"payloads":[{"text":"ok"}],"meta":{"durationMs":123}}',
  ].join("\n"));

  assert.equal(parsed.payloads[0].text, "ok");
});

test("normalizeAbortSignal drops nullish and keeps real AbortSignal", () => {
  const controller = new AbortController();

  assert.equal(normalizeAbortSignal(null), undefined);
  assert.equal(normalizeAbortSignal(undefined), undefined);
  assert.equal(normalizeAbortSignal({ aborted: false }), undefined);
  assert.equal(normalizeAbortSignal(controller.signal), controller.signal);
});
