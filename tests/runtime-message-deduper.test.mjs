import test from "node:test";
import assert from "node:assert/strict";

import { createMessageEventDeduper } from "../src/runtime-message-deduper.mjs";

test("deduper accepts first message id and rejects duplicate within window", () => {
  const deduper = createMessageEventDeduper({ windowMs: 1000 });

  assert.equal(deduper.shouldProcess("om_123", 100), true);
  assert.equal(deduper.shouldProcess("om_123", 500), false);
});

test("deduper accepts same message id again after window expires", () => {
  const deduper = createMessageEventDeduper({ windowMs: 1000 });

  assert.equal(deduper.shouldProcess("om_123", 100), true);
  assert.equal(deduper.shouldProcess("om_123", 1200), true);
});

test("deduper does not block messages without ids", () => {
  const deduper = createMessageEventDeduper({ windowMs: 1000 });

  assert.equal(deduper.shouldProcess("", 100), true);
  assert.equal(deduper.shouldProcess("", 200), true);
});
