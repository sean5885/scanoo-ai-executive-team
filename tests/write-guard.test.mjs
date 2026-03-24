import test from "node:test";
import assert from "node:assert/strict";

import { createRuntimeLogger, createTraceId } from "../src/runtime-observability.mjs";
import { decideWriteGuard } from "../src/write-guard.mjs";
import { buildMeetingConfirmWritePolicy } from "../src/write-policy-contract.mjs";

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
  assert.equal(result.decision, "deny");
  assert.equal(result.error_code, "write_guard_confirmation_required");
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
  assert.equal(result.error_code, "write_guard_preview_blocked");
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
  assert.equal(result.decision, "allow");
  assert.equal(result.error_code, null);
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
  assert.equal(result.error_code, "write_guard_verifier_incomplete");
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
  assert.equal(result.error_code, null);
});

test("write guard emits structured observability logs with owner workflow and deny code", () => {
  const calls = [];
  const traceId = createTraceId("writeguard");
  const logger = createRuntimeLogger({
    logger: {
      warn(...args) {
        calls.push(args);
      },
    },
    component: "test_write_guard",
    baseFields: { trace_id: traceId },
  });

  const result = decideWriteGuard({
    externalWrite: true,
    confirmed: false,
    verifierCompleted: true,
    logger,
    owner: "meeting_agent",
    workflow: "meeting",
    operation: "meeting_confirm_write",
    details: {
      account_id: "acct-1",
      confirmation_id: "confirmation-1",
      write_policy: buildMeetingConfirmWritePolicy({
        confirmationId: "confirmation-1",
      }),
    },
  });

  assert.equal(result.error_code, "write_guard_confirmation_required");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "lobster_runtime");
  assert.equal(calls[0][1].event, "write_guard_decision");
  assert.equal(calls[0][1].action, "meeting_confirm_write");
  assert.equal(calls[0][1].status, "deny");
  assert.equal(calls[0][1].owner, "meeting_agent");
  assert.equal(calls[0][1].workflow, "meeting");
  assert.equal(calls[0][1].allow, false);
  assert.equal(calls[0][1].deny, true);
  assert.equal(calls[0][1].reason, "confirmation_required");
  assert.equal(calls[0][1].error_code, "write_guard_confirmation_required");
  assert.equal(calls[0][1].trace_id, traceId);
  assert.deepEqual(calls[0][1].write_policy, {
    policy_version: "write_policy_v1",
    source: "meeting_confirm",
    owner: "meeting_agent",
    intent: "meeting_writeback",
    action_type: "writeback",
    external_write: true,
    confirm_required: true,
    review_required: "never",
    scope_key: "meeting-confirm:confirmation-1",
    idempotency_key: null,
  });
});
