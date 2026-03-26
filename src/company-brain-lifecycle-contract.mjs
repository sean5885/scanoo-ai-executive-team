import { cleanText } from "./message-intent-utils.mjs";
import {
  buildCompanyBrainApplyWritePolicy,
  buildCompanyBrainApprovalTransitionWritePolicy,
  buildCompanyBrainConflictWritePolicy,
  buildCompanyBrainReviewWritePolicy,
  cloneWritePolicyRecord,
} from "./write-policy-contract.mjs";

export const COMPANY_BRAIN_LIFECYCLE_STATES = Object.freeze([
  "mirror_only",
  "pending_review",
  "conflict_detected",
  "approved",
  "rejected",
  "applied",
]);

const COMPANY_BRAIN_LIFECYCLE_TRANSITIONS = Object.freeze({
  mirror_only: Object.freeze(["pending_review", "conflict_detected"]),
  pending_review: Object.freeze(["conflict_detected", "approved", "rejected"]),
  conflict_detected: Object.freeze(["pending_review", "approved", "rejected"]),
  approved: Object.freeze(["applied"]),
  rejected: Object.freeze([]),
  applied: Object.freeze(["applied"]),
});

const COMPANY_BRAIN_REVIEW_STATUS_SET = new Set([
  "pending_review",
  "conflict_detected",
  "approved",
  "rejected",
]);

const COMPANY_BRAIN_ROUTE_CONTRACT_FIXTURES = Object.freeze([
  {
    pathname: "/agent/company-brain/review",
    action: "review_company_brain_doc",
    write_policy: Object.freeze(buildCompanyBrainReviewWritePolicy({
      docId: "test-doc",
    })),
    governance: Object.freeze({
      external_write: false,
      confirm_required: false,
      review_required: "always",
      lifecycle_entry: "review",
      apply_gate: false,
      allowed_states: Object.freeze(["mirror_only", "pending_review", "conflict_detected"]),
    }),
  },
  {
    pathname: "/agent/company-brain/conflicts",
    action: "check_company_brain_conflicts",
    write_policy: Object.freeze(buildCompanyBrainConflictWritePolicy({
      docId: "test-doc",
    })),
    governance: Object.freeze({
      external_write: false,
      confirm_required: false,
      review_required: "conditional",
      lifecycle_entry: "conflict_check",
      apply_gate: false,
      allowed_states: Object.freeze(["pending_review", "conflict_detected"]),
    }),
  },
  {
    pathname: "/agent/company-brain/approval-transition",
    action: "approval_transition_company_brain_doc",
    write_policy: Object.freeze(buildCompanyBrainApprovalTransitionWritePolicy({
      docId: "test-doc",
    })),
    governance: Object.freeze({
      external_write: false,
      confirm_required: false,
      review_required: "always",
      lifecycle_entry: "approval_transition",
      apply_gate: false,
      allowed_states: Object.freeze(["pending_review", "conflict_detected", "approved", "rejected"]),
    }),
  },
  {
    pathname: "/agent/company-brain/docs/test-doc/apply",
    action: "apply_company_brain_approved_knowledge",
    write_policy: Object.freeze(buildCompanyBrainApplyWritePolicy({
      docId: "test-doc",
    })),
    governance: Object.freeze({
      external_write: false,
      confirm_required: false,
      review_required: "always",
      lifecycle_entry: "apply",
      apply_gate: true,
      allowed_states: Object.freeze(["approved", "applied"]),
      apply_requires_review_status: "approved",
      blocks_on: Object.freeze(["review_missing", "approval_missing", "conflict_unresolved", "review_rejected"]),
    }),
  },
  {
    pathname: "/agent/company-brain/approved/docs",
    action: "list_approved_company_brain_knowledge",
    governance: Object.freeze({
      external_write: false,
      confirm_required: false,
      review_required: "never",
      lifecycle_entry: "approved_read",
      apply_gate: false,
      allowed_states: Object.freeze(["applied"]),
    }),
  },
  {
    pathname: "/agent/company-brain/approved/search",
    action: "search_approved_company_brain_knowledge",
    governance: Object.freeze({
      external_write: false,
      confirm_required: false,
      review_required: "never",
      lifecycle_entry: "approved_read",
      apply_gate: false,
      allowed_states: Object.freeze(["applied"]),
    }),
  },
  {
    pathname: "/agent/company-brain/approved/docs/test-doc",
    action: "get_approved_company_brain_knowledge_detail",
    governance: Object.freeze({
      external_write: false,
      confirm_required: false,
      review_required: "never",
      lifecycle_entry: "approved_read",
      apply_gate: false,
      allowed_states: Object.freeze(["applied"]),
    }),
  },
]);

function normalizeReviewStatus(status = "") {
  const normalized = cleanText(status).toLowerCase();
  return COMPANY_BRAIN_REVIEW_STATUS_SET.has(normalized) ? normalized : null;
}

function normalizeApprovalStatus(status = "") {
  return cleanText(status).toLowerCase() === "approved" ? "approved" : null;
}

export function getCompanyBrainLifecycleContract() {
  return {
    states: COMPANY_BRAIN_LIFECYCLE_STATES,
    transitions: COMPANY_BRAIN_LIFECYCLE_TRANSITIONS,
    apply_gate: {
      allowed_states: ["approved", "applied"],
      required_review_status: "approved",
      blocked_by: [
        "review_missing",
        "review_pending",
        "conflict_unresolved",
        "review_rejected",
        "approval_missing",
      ],
    },
  };
}

export function listCompanyBrainLifecycleRouteContracts() {
  return COMPANY_BRAIN_ROUTE_CONTRACT_FIXTURES.map((entry) => ({
    pathname: entry.pathname,
    action: entry.action,
    write_policy: cloneWritePolicyRecord(entry.write_policy),
    governance: {
      ...entry.governance,
      allowed_states: Array.isArray(entry.governance?.allowed_states)
        ? [...entry.governance.allowed_states]
        : [],
      blocks_on: Array.isArray(entry.governance?.blocks_on)
        ? [...entry.governance.blocks_on]
        : [],
    },
  }));
}

export function getCompanyBrainLifecycleRouteContract(pathname = "") {
  const normalizedPathname = cleanText(pathname);
  if (!normalizedPathname) {
    return null;
  }
  const matched = COMPANY_BRAIN_ROUTE_CONTRACT_FIXTURES.find((entry) => entry.pathname === normalizedPathname)
    || (/^\/agent\/company-brain\/docs\/[^/]+\/apply$/.test(normalizedPathname)
      ? COMPANY_BRAIN_ROUTE_CONTRACT_FIXTURES.find((entry) => entry.pathname === "/agent/company-brain/docs/test-doc/apply")
      : null)
    || (/^\/agent\/company-brain\/approved\/docs\/[^/]+$/.test(normalizedPathname)
      ? COMPANY_BRAIN_ROUTE_CONTRACT_FIXTURES.find((entry) => entry.pathname === "/agent/company-brain/approved/docs/test-doc")
      : null);
  if (!matched) {
    return null;
  }
  return {
    pathname: normalizedPathname,
    action: matched.action,
    write_policy: cloneWritePolicyRecord(matched.write_policy),
    governance: {
      ...matched.governance,
      allowed_states: Array.isArray(matched.governance?.allowed_states)
        ? [...matched.governance.allowed_states]
        : [],
      blocks_on: Array.isArray(matched.governance?.blocks_on)
        ? [...matched.governance.blocks_on]
        : [],
    },
  };
}

export function isCompanyBrainLifecycleTransitionAllowed({ from = "", to = "" } = {}) {
  const normalizedFrom = cleanText(from);
  const normalizedTo = cleanText(to);
  if (!normalizedFrom || !normalizedTo) {
    return false;
  }
  return Array.isArray(COMPANY_BRAIN_LIFECYCLE_TRANSITIONS[normalizedFrom])
    && COMPANY_BRAIN_LIFECYCLE_TRANSITIONS[normalizedFrom].includes(normalizedTo);
}

export function deriveCompanyBrainLifecycleState({
  intakeBoundary = {},
  approvalState = {},
} = {}) {
  const reviewStatus =
    normalizeReviewStatus(approvalState?.review_state?.status)
    || normalizeReviewStatus(intakeBoundary?.review_status);
  const approvalStatus = normalizeApprovalStatus(approvalState?.approval?.status);

  if (approvalStatus === "approved") {
    return "applied";
  }
  if (reviewStatus === "approved") {
    return "approved";
  }
  if (reviewStatus === "rejected") {
    return "rejected";
  }
  if (reviewStatus === "conflict_detected") {
    return "conflict_detected";
  }
  if (
    reviewStatus === "pending_review"
    || intakeBoundary?.review_required === true
    || intakeBoundary?.approval_required_for_formal_source === true
    || intakeBoundary?.conflict_check_required === true
  ) {
    return "pending_review";
  }
  return "mirror_only";
}

export function evaluateCompanyBrainApplyGate({
  intakeBoundary = {},
  approvalState = {},
} = {}) {
  const lifecycleState = deriveCompanyBrainLifecycleState({
    intakeBoundary,
    approvalState,
  });
  const reviewStatus =
    normalizeReviewStatus(approvalState?.review_state?.status)
    || normalizeReviewStatus(intakeBoundary?.review_status);
  const approvalStatus = normalizeApprovalStatus(approvalState?.approval?.status);
  const blockingReasons = [];

  if (approvalStatus === "approved") {
    return {
      lifecycle_state: lifecycleState,
      can_apply: true,
      already_applied: true,
      blocking_reasons: [],
    };
  }

  if (reviewStatus === "approved") {
    return {
      lifecycle_state: lifecycleState,
      can_apply: true,
      already_applied: false,
      blocking_reasons: [],
    };
  }

  if (reviewStatus === "conflict_detected") {
    blockingReasons.push("conflict_unresolved");
  } else if (reviewStatus === "rejected") {
    blockingReasons.push("review_rejected");
  } else if (reviewStatus === "pending_review") {
    blockingReasons.push("review_pending");
  } else {
    blockingReasons.push("review_missing");
  }

  blockingReasons.push("approval_missing");

  return {
    lifecycle_state: lifecycleState,
    can_apply: false,
    already_applied: false,
    blocking_reasons: blockingReasons,
  };
}

export function runCompanyBrainLifecycleSelfCheck({ getRouteContract } = {}) {
  const routeChecks = listCompanyBrainLifecycleRouteContracts().map((expected) => {
    const actual = typeof getRouteContract === "function"
      ? getRouteContract(expected.pathname)
      : null;
    const issues = [];
    const actualMethods = Array.isArray(actual?.methods) ? actual.methods : [];
    const actualGovernance = actual?.governance || null;

    if (actualMethods.length === 0) {
      issues.push("route_missing");
    }
    if (cleanText(actual?.action) !== cleanText(expected.action)) {
      issues.push("action_mismatch");
    }
    if (cleanText(actualGovernance?.lifecycle_entry) !== cleanText(expected.governance?.lifecycle_entry)) {
      issues.push("governance_lifecycle_mismatch");
    }
    if (Boolean(actualGovernance?.apply_gate) !== Boolean(expected.governance?.apply_gate)) {
      issues.push("apply_gate_mismatch");
    }
    if (cleanText(actualGovernance?.review_required) !== cleanText(expected.governance?.review_required)) {
      issues.push("review_required_mismatch");
    }

    return {
      pathname: expected.pathname,
      action: expected.action,
      ok: issues.length === 0,
      issues,
    };
  });

  const applyGateCases = [
    {
      case_id: "missing_review",
      expected: {
        lifecycle_state: "pending_review",
        can_apply: false,
        blocking_reasons: ["review_missing", "approval_missing"],
      },
      actual: evaluateCompanyBrainApplyGate({
        intakeBoundary: {
          review_required: true,
          approval_required_for_formal_source: true,
          review_status: null,
        },
        approvalState: {
          review_state: null,
          approval: null,
        },
      }),
    },
    {
      case_id: "unresolved_conflict",
      expected: {
        lifecycle_state: "conflict_detected",
        can_apply: false,
        blocking_reasons: ["conflict_unresolved", "approval_missing"],
      },
      actual: evaluateCompanyBrainApplyGate({
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
      }),
    },
    {
      case_id: "missing_approval",
      expected: {
        lifecycle_state: "rejected",
        can_apply: false,
        blocking_reasons: ["review_rejected", "approval_missing"],
      },
      actual: evaluateCompanyBrainApplyGate({
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
      }),
    },
    {
      case_id: "approved_ready_to_apply",
      expected: {
        lifecycle_state: "approved",
        can_apply: true,
        blocking_reasons: [],
      },
      actual: evaluateCompanyBrainApplyGate({
        intakeBoundary: {
          review_required: true,
          approval_required_for_formal_source: true,
          review_status: "approved",
        },
        approvalState: {
          review_state: {
            status: "approved",
          },
          approval: null,
        },
      }),
    },
  ].map((entry) => {
    const ok =
      entry.expected.lifecycle_state === entry.actual.lifecycle_state
      && entry.expected.can_apply === entry.actual.can_apply
      && JSON.stringify(entry.expected.blocking_reasons) === JSON.stringify(entry.actual.blocking_reasons);
    return {
      case_id: entry.case_id,
      ok,
      expected: entry.expected,
      actual: entry.actual,
    };
  });

  const transitionChecks = [
    ["mirror_only", "pending_review"],
    ["pending_review", "approved"],
    ["pending_review", "rejected"],
    ["conflict_detected", "pending_review"],
    ["conflict_detected", "approved"],
    ["approved", "applied"],
  ].map(([from, to]) => ({
    from,
    to,
    ok: isCompanyBrainLifecycleTransitionAllowed({ from, to }),
  }));

  const failingRoutes = routeChecks.filter((item) => item.ok !== true);
  const failingCases = applyGateCases.filter((item) => item.ok !== true);
  const failingTransitions = transitionChecks.filter((item) => item.ok !== true);
  const ok = failingRoutes.length === 0 && failingCases.length === 0 && failingTransitions.length === 0;

  return {
    status: ok ? "pass" : "fail",
    summary: ok
      ? "company-brain lifecycle contract and apply gate are aligned"
      : "company-brain lifecycle contract coverage has gaps",
    guidance: ok
      ? "company-brain lifecycle gates are covered; keep review/conflict/approval/apply changes aligned through route contracts and self-check."
      : "先看 src/company-brain-lifecycle-contract.mjs、src/http-route-contracts.mjs 與 tests/company-brain-lifecycle-contract.test.mjs；不要改動 runtime write path。",
    route_contracts_checked: routeChecks,
    apply_gate_cases: applyGateCases,
    transition_checks: transitionChecks,
    failing_routes: failingRoutes,
    failing_cases: failingCases,
    failing_transitions: failingTransitions,
  };
}
