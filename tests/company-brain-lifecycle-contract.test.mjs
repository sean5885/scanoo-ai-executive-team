import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveCompanyBrainLifecycleState,
  evaluateCompanyBrainApplyGate,
  getCompanyBrainLifecycleRouteContract,
  isCompanyBrainLifecycleTransitionAllowed,
  runCompanyBrainLifecycleSelfCheck,
} from "../src/company-brain-lifecycle-contract.mjs";
import { getRouteContract } from "../src/http-route-contracts.mjs";

test("apply gate blocks missing review, unresolved conflict, and missing approval", () => {
  assert.deepEqual(evaluateCompanyBrainApplyGate({
    intakeBoundary: {
      review_required: true,
      approval_required_for_formal_source: true,
    },
    approvalState: {
      review_state: null,
      approval: null,
    },
  }), {
    lifecycle_state: "pending_review",
    can_apply: false,
    already_applied: false,
    blocking_reasons: ["review_missing", "approval_missing"],
  });

  assert.deepEqual(evaluateCompanyBrainApplyGate({
    intakeBoundary: {
      review_required: true,
      conflict_check_required: true,
      review_status: "conflict_detected",
    },
    approvalState: {
      review_state: {
        status: "conflict_detected",
      },
      approval: null,
    },
  }), {
    lifecycle_state: "conflict_detected",
    can_apply: false,
    already_applied: false,
    blocking_reasons: ["conflict_unresolved", "approval_missing"],
  });

  assert.deepEqual(evaluateCompanyBrainApplyGate({
    intakeBoundary: {
      review_required: true,
      approval_required_for_formal_source: true,
      review_status: "rejected",
    },
    approvalState: {
      review_state: {
        status: "rejected",
      },
      approval: null,
    },
  }), {
    lifecycle_state: "rejected",
    can_apply: false,
    already_applied: false,
    blocking_reasons: ["review_rejected", "approval_missing"],
  });
});

test("lifecycle contract only allows apply from approved or applied states", () => {
  assert.equal(isCompanyBrainLifecycleTransitionAllowed({
    from: "approved",
    to: "applied",
  }), true);
  assert.equal(isCompanyBrainLifecycleTransitionAllowed({
    from: "pending_review",
    to: "applied",
  }), false);
  assert.equal(deriveCompanyBrainLifecycleState({
    approvalState: {
      review_state: {
        status: "approved",
      },
      approval: null,
    },
  }), "approved");
  assert.equal(deriveCompanyBrainLifecycleState({
    approvalState: {
      review_state: {
        status: "approved",
      },
      approval: {
        status: "approved",
      },
    },
  }), "applied");
});

test("route contracts expose company-brain lifecycle governance for review through apply", () => {
  const reviewContract = getCompanyBrainLifecycleRouteContract("/agent/company-brain/review");
  assert.equal(reviewContract.action, "review_company_brain_doc");
  assert.equal(reviewContract.governance.lifecycle_entry, "review");

  const applyContract = getRouteContract("/agent/company-brain/docs/test-doc/apply");
  assert.equal(applyContract.action, "apply_company_brain_approved_knowledge");
  assert.equal(applyContract.governance.lifecycle_entry, "apply");
  assert.equal(applyContract.governance.apply_gate, true);
});

test("company-brain lifecycle self-check stays aligned on routes and apply gate cases", () => {
  const result = runCompanyBrainLifecycleSelfCheck({
    getRouteContract,
  });

  assert.equal(result.status, "pass");
  assert.equal(result.failing_routes.length, 0);
  assert.equal(result.failing_cases.length, 0);
  assert.equal(result.failing_transitions.length, 0);
  assert.equal(result.apply_gate_cases.find((item) => item.case_id === "missing_review")?.actual.can_apply, false);
  assert.deepEqual(
    result.apply_gate_cases.find((item) => item.case_id === "unresolved_conflict")?.actual.blocking_reasons,
    ["conflict_unresolved", "approval_missing"],
  );
});
