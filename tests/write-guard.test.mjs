import test from "node:test";
import assert from "node:assert/strict";

import { createRuntimeLogger, createTraceId } from "../src/runtime-observability.mjs";
import { decideWriteGuard } from "../src/write-guard.mjs";
import {
  buildDriveOrganizeApplyWritePolicy,
  buildMeetingConfirmWritePolicy,
} from "../src/write-policy-contract.mjs";

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
    writePolicy: buildMeetingConfirmWritePolicy({
      confirmationId: "confirmation-1",
    }),
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
  const decisionLog = calls.find((entry) => entry[1]?.event === "write_guard_decision");
  assert.ok(decisionLog);
  assert.equal(decisionLog[0], "lobster_runtime");
  assert.equal(decisionLog[1].action, "meeting_confirm_write");
  assert.equal(decisionLog[1].status, "deny");
  assert.equal(decisionLog[1].owner, "meeting_agent");
  assert.equal(decisionLog[1].workflow, "meeting");
  assert.equal(decisionLog[1].allow, false);
  assert.equal(decisionLog[1].deny, true);
  assert.equal(decisionLog[1].reason, "confirmation_required");
  assert.equal(decisionLog[1].error_code, "write_guard_confirmation_required");
  assert.equal(decisionLog[1].trace_id, traceId);
  assert.deepEqual(decisionLog[1].write_policy, {
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
  assert.equal(decisionLog[1].policy_enforcement.mode, "warn");
  assert.deepEqual(decisionLog[1].policy_enforcement.violation_types, ["confirm_required"]);
  assert.equal(calls.some((entry) => entry[1]?.event === "write_policy_enforcement_warning"), true);
});

test("write guard observe mode keeps write allowed and logs observed policy violations", () => {
  const calls = [];
  const logger = createRuntimeLogger({
    logger: {
      info(...args) {
        calls.push(args);
      },
      warn(...args) {
        calls.push(args);
      },
    },
    component: "test_write_guard_observe",
  });

  const result = decideWriteGuard({
    externalWrite: true,
    confirmed: true,
    verifierCompleted: true,
    pathname: "/api/drive/organize/apply",
    writePolicy: buildDriveOrganizeApplyWritePolicy({
      scopeKey: "drive:fld_ops",
    }),
    scopeKey: "drive:fld_ops",
    logger,
    owner: "cloud_doc_workflow",
    workflow: "cloud_doc",
    operation: "drive_organize_apply",
  });

  assert.equal(result.allow, true);
  assert.equal(result.policy_enforcement.status, "observe");
  assert.deepEqual(result.policy_enforcement.violation_types, ["missing_idempotency_key"]);
  assert.equal(calls.some((entry) => entry[1]?.event === "write_policy_enforcement_observed"), true);
});

test("write guard enforce mode blocks when policy enforcement fails after base guard passes", () => {
  const result = decideWriteGuard({
    externalWrite: true,
    confirmed: true,
    verifierCompleted: true,
    pathname: "/api/doc/create",
    writePolicy: {
      policy_version: "write_policy_v1",
      source: "create_doc",
      owner: "document_http_route",
      intent: "create_doc",
      action_type: "create",
      external_write: true,
      confirm_required: true,
      review_required: "conditional",
      scope_key: null,
      idempotency_key: null,
    },
    operation: "create_doc",
  });

  assert.equal(result.allow, false);
  assert.equal(result.reason, "policy_enforcement_blocked");
  assert.equal(result.error_code, "write_policy_enforcement_blocked");
  assert.equal(result.policy_enforcement.mode, "enforce");
  assert.deepEqual(result.policy_enforcement.violation_types, ["missing_scope_key"]);
});
