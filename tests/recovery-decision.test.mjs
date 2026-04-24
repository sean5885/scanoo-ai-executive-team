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

test("recovery decision prefers search candidate selection before retry", () => {
  const decision = resolveRecoveryDecisionV1({
    workflow: "meeting",
    retryable: true,
    retry_count: 0,
    max_retries: 2,
    failure_class: "tool_error",
    recovery_candidates: [
      {
        id: "route-search",
        kind: "route",
        action: "search_company_brain_docs",
        score: 0.92,
        reason: "route variant outperforms retry",
      },
    ],
  });

  assert.equal(decision.next_state, "executing");
  assert.equal(decision.next_status, "active");
  assert.equal(decision.routing_hint, "meeting_search_candidate");
  assert.equal(decision.reason, "recovery_decision_v1_search_candidate_selected");
  assert.equal(decision.recovery_mode, "search_candidate");
  assert.equal(decision.decision_basis?.why_retry, "retry_deferred_because_search_candidate_available");
  assert.equal(decision.candidate_selection?.selected_candidate?.id, "route-search");
});

test("recovery decision records retry_without_candidate when no candidates are generated", () => {
  const decision = resolveRecoveryDecisionV1({
    workflow: "doc_rewrite",
    retryable: true,
    retry_count: 0,
    max_retries: 3,
    failure_class: "runtime_exception",
    recovery_candidates: [],
  });

  assert.equal(decision.reason, "recovery_decision_v1_retrying");
  assert.equal(decision.recovery_mode, "retry");
  assert.equal(decision.decision_basis?.why_retry, "no_recovery_candidates_available");
});

test("recovery decision deterministic fixtures cover multiple failure classes for search-vs-retry split", () => {
  const fixtures = [
    {
      id: "tool-error-search",
      input: {
        workflow: "meeting",
        retryable: true,
        retry_count: 0,
        max_retries: 2,
        failure_class: "tool_error",
        recovery_candidates: [
          { id: "c1", kind: "route", action: "search_company_brain_docs", score: 0.9 },
          { id: "c2", kind: "prompt", action: "search_and_summarize", score: 0.6 },
        ],
      },
      expectedReason: "recovery_decision_v1_search_candidate_selected",
    },
    {
      id: "runtime-exception-retry",
      input: {
        workflow: "meeting",
        retryable: true,
        retry_count: 0,
        max_retries: 2,
        failure_class: "runtime_exception",
        recovery_candidates: [],
      },
      expectedReason: "recovery_decision_v1_retrying",
    },
    {
      id: "permission-denied-escalated",
      input: {
        workflow: "meeting",
        retryable: true,
        retry_count: 0,
        max_retries: 2,
        failure_class: "permission_denied",
        recovery_candidates: [
          { id: "c3", kind: "route", action: "search_company_brain_docs", score: 1 },
        ],
      },
      expectedReason: "recovery_decision_v1_permission_denied",
    },
  ];

  for (const fixture of fixtures) {
    const decision = resolveRecoveryDecisionV1(fixture.input);
    assert.equal(decision.reason, fixture.expectedReason, fixture.id);
  }
});
