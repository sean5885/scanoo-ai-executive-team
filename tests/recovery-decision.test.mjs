import test from "node:test";
import assert from "node:assert/strict";

import { resolveRecoveryDecisionV1 } from "../src/recovery-decision.mjs";

test("recovery decision retries same task when retryable and budget is available", () => {
  const decision = resolveRecoveryDecisionV1({
    workflow: "meeting",
    retryable: true,
    retry_count: 1,
    max_retries: 2,
    verification: {
      pass: false,
      issues: ["missing_action_items"],
    },
  });

  assert.equal(decision.next_state, "executing");
  assert.equal(decision.next_status, "active");
  assert.equal(decision.routing_hint, "meeting_resume_same_task");
});

test("recovery decision escalates when failure class is effect_committed", () => {
  const decision = resolveRecoveryDecisionV1({
    workflow: "doc_rewrite",
    failure_class: "effect_committed",
    retryable: true,
    retry_count: 0,
    max_retries: 2,
  });

  assert.equal(decision.next_state, "escalated");
  assert.equal(decision.next_status, "escalated");
  assert.equal(decision.routing_hint, "doc_rewrite_escalated");
});

test("recovery decision escalates when retryable is false", () => {
  const decision = resolveRecoveryDecisionV1({
    workflow: "cloud_doc",
    retryable: false,
    retry_count: 0,
    max_retries: 2,
  });

  assert.equal(decision.next_state, "escalated");
  assert.equal(decision.next_status, "escalated");
  assert.equal(decision.routing_hint, "cloud_doc_escalated");
});

test("recovery decision enters waiting_user when missing slot is detected", () => {
  const decision = resolveRecoveryDecisionV1({
    workflow: "document_review",
    failure_class: "missing_slot",
    retryable: true,
    retry_count: 0,
    max_retries: 2,
  });

  assert.equal(decision.next_state, "blocked");
  assert.equal(decision.next_status, "blocked");
  assert.equal(decision.routing_hint, "document_review_waiting_user");
});

test("recovery decision fail-softs to failed when retry budget is exhausted and verifier state is failed", () => {
  const decision = resolveRecoveryDecisionV1({
    workflow: "meeting",
    retryable: true,
    retry_count: 2,
    max_retries: 2,
    verification: {
      execution_policy_state: "failed",
    },
  });

  assert.equal(decision.next_state, "failed");
  assert.equal(decision.next_status, "failed");
  assert.equal(decision.routing_hint, "meeting_failed_fail_soft");
});
