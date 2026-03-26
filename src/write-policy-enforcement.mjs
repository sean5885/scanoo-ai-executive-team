import { cleanText } from "./message-intent-utils.mjs";

export const WRITE_POLICY_ENFORCEMENT_VERSION = "write_policy_enforcement_v1";
export const WRITE_POLICY_ENFORCEMENT_MODES = Object.freeze([
  "observe",
  "warn",
  "enforce",
]);
export const DEFAULT_WRITE_POLICY_ENFORCEMENT_MODE = "observe";
export const WRITE_POLICY_VIOLATION_TYPES = Object.freeze([
  "missing_scope_key",
  "missing_idempotency_key",
  "confirm_required",
  "review_required",
]);
export const WRITE_POLICY_VIOLATION_REASONS = Object.freeze([
  "scope_key_unset",
  "idempotency_key_unset",
  "missing_confirmation",
  "missing_review_evidence",
]);

function normalizeMode(value = "") {
  const normalized = cleanText(value).toLowerCase();
  return WRITE_POLICY_ENFORCEMENT_MODES.includes(normalized)
    ? normalized
    : DEFAULT_WRITE_POLICY_ENFORCEMENT_MODE;
}

function cloneChecks(checks = {}) {
  return Object.freeze({
    scope_key: checks?.scope_key === true,
    idempotency_key: checks?.idempotency_key === true,
    confirm_required: checks?.confirm_required !== false,
    review_required: checks?.review_required !== false,
  });
}

function buildEnforcementRecord({
  action = "",
  pathname = "",
  mode = DEFAULT_WRITE_POLICY_ENFORCEMENT_MODE,
  checks = {},
} = {}) {
  return Object.freeze({
    enforcement_version: WRITE_POLICY_ENFORCEMENT_VERSION,
    action: cleanText(action) || null,
    pathname: cleanText(pathname) || null,
    mode: normalizeMode(mode),
    checks: cloneChecks(checks),
  });
}

const PHASE2_ROUTE_WRITE_POLICY_ENFORCEMENT = Object.freeze([
  buildEnforcementRecord({
    action: "create_doc",
    pathname: "/api/doc/create",
    mode: "enforce",
    checks: {
      scope_key: true,
      idempotency_key: false,
      confirm_required: true,
      review_required: true,
    },
  }),
  buildEnforcementRecord({
    action: "create_doc",
    pathname: "/agent/docs/create",
    mode: "enforce",
    checks: {
      scope_key: true,
      idempotency_key: false,
      confirm_required: true,
      review_required: true,
    },
  }),
  buildEnforcementRecord({
    action: "update_doc",
    pathname: "/api/doc/update",
    mode: "warn",
    checks: {
      scope_key: true,
      idempotency_key: false,
      confirm_required: true,
      review_required: true,
    },
  }),
  buildEnforcementRecord({
    action: "drive_organize_apply",
    pathname: "/api/drive/organize/apply",
    mode: "observe",
    checks: {
      scope_key: true,
      idempotency_key: true,
      confirm_required: true,
      review_required: true,
    },
  }),
  buildEnforcementRecord({
    action: "wiki_organize_apply",
    pathname: "/api/wiki/organize/apply",
    mode: "observe",
    checks: {
      scope_key: true,
      idempotency_key: true,
      confirm_required: true,
      review_required: true,
    },
  }),
  buildEnforcementRecord({
    action: "document_comment_rewrite_apply",
    pathname: "/api/doc/rewrite-from-comments",
    mode: "warn",
    checks: {
      scope_key: true,
      idempotency_key: false,
      confirm_required: true,
      review_required: true,
    },
  }),
  buildEnforcementRecord({
    action: "meeting_confirm_write",
    pathname: "/api/meeting/confirm",
    mode: "warn",
    checks: {
      scope_key: true,
      idempotency_key: false,
      confirm_required: true,
      review_required: true,
    },
  }),
  buildEnforcementRecord({
    action: "meeting_confirm_write",
    pathname: "/meeting/confirm",
    mode: "warn",
    checks: {
      scope_key: true,
      idempotency_key: false,
      confirm_required: true,
      review_required: true,
    },
  }),
]);

function cloneEnforcementRecord(record = null) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return null;
  }
  return buildEnforcementRecord({
    action: record.action,
    pathname: record.pathname,
    mode: record.mode,
    checks: record.checks,
  });
}

export function listWritePolicyEnforcementFixtures() {
  return PHASE2_ROUTE_WRITE_POLICY_ENFORCEMENT.map((record) => cloneEnforcementRecord(record));
}

export function getWritePolicyEnforcementFixture(pathname = "") {
  const normalizedPathname = cleanText(pathname);
  if (!normalizedPathname) {
    return null;
  }
  const matched = PHASE2_ROUTE_WRITE_POLICY_ENFORCEMENT.find((record) => record.pathname === normalizedPathname);
  return cloneEnforcementRecord(matched || null);
}

export function getWritePolicyEnforcementProfile({
  action = "",
  pathname = "",
} = {}) {
  const normalizedPathname = cleanText(pathname);
  const normalizedAction = cleanText(action);

  if (normalizedPathname) {
    const matchedPath = PHASE2_ROUTE_WRITE_POLICY_ENFORCEMENT.find((record) => record.pathname === normalizedPathname);
    if (matchedPath) {
      return cloneEnforcementRecord(matchedPath);
    }
  }

  if (!normalizedAction) {
    return null;
  }

  const matchedAction = PHASE2_ROUTE_WRITE_POLICY_ENFORCEMENT.find((record) => record.action === normalizedAction);
  return cloneEnforcementRecord(matchedAction || null);
}

function buildViolation({
  type = "",
  field = "",
  message = "",
  reason = "",
  check = "",
} = {}) {
  return {
    type: cleanText(type) || "policy_violation",
    field: cleanText(field) || null,
    message: cleanText(message) || null,
    reason: cleanText(reason) || null,
    check: cleanText(check) || null,
  };
}

function buildViolationMessage(violations = []) {
  const parts = violations
    .map((item) => cleanText(item?.type))
    .filter(Boolean);
  return parts.length > 0
    ? `Write policy violation: ${parts.join(", ")}`
    : "Write policy violation.";
}

function normalizeReviewRequired(value = "") {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === "never" || normalized === "conditional" || normalized === "always") {
    return normalized;
  }
  return "never";
}

export function evaluateWritePolicyEnforcement({
  action = "",
  pathname = "",
  writePolicy = null,
  confirmed = false,
  reviewCompleted = false,
  reviewRequirementActive = false,
  scopeKey = null,
  idempotencyKey = null,
} = {}) {
  const profile = getWritePolicyEnforcementProfile({ action, pathname });
  const mode = profile?.mode || DEFAULT_WRITE_POLICY_ENFORCEMENT_MODE;
  const checks = cloneChecks(profile?.checks);
  const violations = [];
  const resolvedScopeKey = cleanText(scopeKey) || cleanText(writePolicy?.scope_key);
  const resolvedIdempotencyKey = cleanText(idempotencyKey) || cleanText(writePolicy?.idempotency_key);
  const reviewRequired = normalizeReviewRequired(writePolicy?.review_required);
  const requiresReview = reviewRequired === "always"
    || (reviewRequired === "conditional" && reviewRequirementActive === true);
  const signals = {
    scope_key_present: Boolean(resolvedScopeKey),
    idempotency_key_present: Boolean(resolvedIdempotencyKey),
    confirmation_present: confirmed === true,
    review_completed: reviewCompleted === true,
    review_required_active: requiresReview,
  };

  if (checks.scope_key && !resolvedScopeKey) {
    violations.push(buildViolation({
      type: "missing_scope_key",
      field: "scope_key",
      message: "Write policy requires a stable scope_key before apply.",
      reason: "scope_key_unset",
      check: "scope_key",
    }));
  }

  if (checks.idempotency_key && !resolvedIdempotencyKey) {
    violations.push(buildViolation({
      type: "missing_idempotency_key",
      field: "idempotency_key",
      message: "Write policy requires idempotency_key for this write route.",
      reason: "idempotency_key_unset",
      check: "idempotency_key",
    }));
  }

  if (checks.confirm_required && writePolicy?.confirm_required === true && confirmed !== true) {
    violations.push(buildViolation({
      type: "confirm_required",
      field: "confirm_required",
      message: "Write policy requires explicit confirmation before apply.",
      reason: "missing_confirmation",
      check: "confirm_required",
    }));
  }

  if (checks.review_required && requiresReview && reviewCompleted !== true) {
    violations.push(buildViolation({
      type: "review_required",
      field: "review_required",
      message: "Write policy requires review/verification evidence before apply.",
      reason: "missing_review_evidence",
      check: "review_required",
    }));
  }

  const status = violations.length === 0
    ? "pass"
    : mode === "enforce"
      ? "block"
      : mode === "warn"
        ? "warn"
        : "observe";

  return {
    enforcement_version: WRITE_POLICY_ENFORCEMENT_VERSION,
    action: cleanText(action) || profile?.action || null,
    pathname: cleanText(pathname) || profile?.pathname || null,
    mode,
    status,
    checks,
    signals,
    violation_count: violations.length,
    violation_types: violations.map((item) => item.type),
    violation_reasons: violations.map((item) => item.reason).filter(Boolean),
    violations,
    should_block: status === "block",
    should_warn: status === "warn",
    should_observe: status === "observe",
    message: violations.length > 0 ? buildViolationMessage(violations) : null,
  };
}
