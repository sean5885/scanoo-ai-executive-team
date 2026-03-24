import test from "node:test";
import assert from "node:assert/strict";

import { decideWriteGuard } from "../src/write-guard.mjs";

test("unconfirmed external write is denied", () => {
  const result = decideWriteGuard({
    externalWrite: true,
    confirmed: false,
    verifierCompleted: true,
  });

  assert.equal(result.allow, false);
  assert.equal(result.external_write, true);
  assert.equal(result.require_confirmation, true);
  assert.equal(result.reason, "confirmation_required");
});

test("preview external write is denied", () => {
  const result = decideWriteGuard({
    externalWrite: true,
    confirmed: true,
    preview: true,
    verifierCompleted: true,
  });

  assert.equal(result.allow, false);
  assert.equal(result.external_write, true);
  assert.equal(result.require_confirmation, false);
  assert.equal(result.reason, "preview_write_blocked");
});

test("verified confirmed external write is allowed", () => {
  const result = decideWriteGuard({
    externalWrite: true,
    confirmed: true,
    verifierCompleted: true,
  });

  assert.equal(result.allow, true);
  assert.equal(result.external_write, true);
  assert.equal(result.require_confirmation, false);
  assert.equal(result.reason, "allowed");
});

test("verifier-incomplete external write is denied", () => {
  const result = decideWriteGuard({
    externalWrite: true,
    confirmed: true,
    verifierCompleted: false,
  });

  assert.equal(result.allow, false);
  assert.equal(result.external_write, true);
  assert.equal(result.require_confirmation, false);
  assert.equal(result.reason, "verifier_incomplete");
});

test("internal write is always allowed", () => {
  const result = decideWriteGuard({
    externalWrite: false,
    confirmed: false,
    preview: true,
    verifierCompleted: false,
  });

  assert.equal(result.allow, true);
  assert.equal(result.external_write, false);
  assert.equal(result.require_confirmation, false);
  assert.equal(result.reason, "internal_write");
});
