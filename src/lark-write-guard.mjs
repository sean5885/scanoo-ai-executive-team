function cleanText(value) {
  return String(value || "").trim();
}

function isEnvTrue(name, fallback = false) {
  const value = cleanText(process.env[name]);
  if (!value) {
    return fallback;
  }
  return value.toLowerCase() === "true";
}

function parseEnvList(name) {
  return cleanText(process.env[name])
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const DEMO_LIKE_TITLE_PATTERN = /\b(test|demo|verify|verification|smoke|e2e)\b/i;
const WRITE_BLOCKED_MESSAGE = "Lark write blocked (ALLOW_LARK_WRITES not enabled)";
const WRITE_PRODUCTION_BLOCKED_MESSAGE = "Lark write disabled in production";
const CONDITIONAL_REVIEW_REQUIRED = "conditional";

function isProductionEnvironment() {
  return cleanText(process.env.NODE_ENV).toLowerCase() === "production";
}

function buildWriteBlockedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function assertLarkWriteAllowed() {
  if (isProductionEnvironment()) {
    throw buildWriteBlockedError(WRITE_PRODUCTION_BLOCKED_MESSAGE, "lark_write_disabled_in_production");
  }
  if (process.env.ALLOW_LARK_WRITES !== "true") {
    throw buildWriteBlockedError(WRITE_BLOCKED_MESSAGE, "lark_write_disabled");
  }
}

export function getLarkWriteGuardPolicy() {
  const productionLocked = isProductionEnvironment();
  return {
    allowWrites: !productionLocked && process.env.ALLOW_LARK_WRITES === "true",
    allowCreateProbes: isEnvTrue("ALLOW_LARK_WRITE_PROBES", false),
    requireCreateConfirmation: isEnvTrue("LARK_WRITE_REQUIRE_CONFIRM", true),
    allowRootFallback: isEnvTrue("ALLOW_LARK_CREATE_ROOT_FALLBACK", false),
    sandboxFolderToken: cleanText(process.env.LARK_WRITE_SANDBOX_FOLDER_TOKEN),
    allowedTenantKeys: parseEnvList("LARK_WRITE_ALLOWED_TENANT_KEYS"),
    sandboxTenantKeys: parseEnvList("LARK_WRITE_SANDBOX_TENANT_KEYS"),
    productionLocked,
  };
}

export function getDocumentCreateGovernanceContract() {
  return {
    external_write: true,
    confirm_required: true,
    review_required: CONDITIONAL_REVIEW_REQUIRED,
  };
}

export function classifyDocumentCreateRequest({ title = "", source = "" } = {}) {
  const normalizedTitle = cleanText(title);
  const normalizedSource = cleanText(source);
  const demoLike =
    DEMO_LIKE_TITLE_PATTERN.test(normalizedTitle)
    || DEMO_LIKE_TITLE_PATTERN.test(normalizedSource);

  return {
    title: normalizedTitle,
    source: normalizedSource,
    demo_like: demoLike,
  };
}

function buildGuardFailure({
  error,
  message,
  statusCode = 403,
  classification,
  policy,
  requestedFolderToken = "",
  resolvedFolderToken = "",
} = {}) {
  return {
    ok: false,
    error,
    message,
    statusCode,
    classification,
    policy: {
      allow_writes: policy.allowWrites,
      require_create_confirmation: policy.requireCreateConfirmation,
      allow_root_fallback: policy.allowRootFallback,
      sandbox_folder_configured: Boolean(policy.sandboxFolderToken),
      allowed_tenant_keys: policy.allowedTenantKeys,
      sandbox_tenant_keys: policy.sandboxTenantKeys,
    },
    requested_folder_token: cleanText(requestedFolderToken) || null,
    resolved_folder_token: cleanText(resolvedFolderToken) || null,
  };
}

export function planDocumentCreateGuard({
  title = "",
  source = "",
  requestedFolderToken = "",
  account = null,
  requireConfirmation = false,
  confirmed = false,
} = {}) {
  const policy = getLarkWriteGuardPolicy();
  const classification = classifyDocumentCreateRequest({ title, source });
  const tenantKey = cleanText(account?.tenant_key);

  if (!policy.allowWrites) {
    return buildGuardFailure({
      error: "lark_writes_disabled",
      message: policy.productionLocked
        ? WRITE_PRODUCTION_BLOCKED_MESSAGE
        : "Real Lark document creation is disabled by default. Set ALLOW_LARK_WRITES=true before writing.",
      classification,
      policy,
      requestedFolderToken,
    });
  }

  if (requireConfirmation && policy.requireCreateConfirmation && confirmed !== true) {
    return buildGuardFailure({
      error: "lark_write_confirmation_required",
      message: "Document creation requires explicit confirmation. Re-submit with confirm=true after operator approval.",
      statusCode: 409,
      classification,
      policy,
      requestedFolderToken,
    });
  }

  if (policy.allowedTenantKeys.length > 0 && !policy.allowedTenantKeys.includes(tenantKey)) {
    return buildGuardFailure({
      error: "lark_write_tenant_not_allowed",
      message: "This account tenant is not allow-listed for live Lark writes.",
      classification,
      policy,
      requestedFolderToken,
    });
  }

  let resolvedFolderToken = cleanText(requestedFolderToken);
  if (classification.demo_like) {
    if (!policy.sandboxFolderToken) {
      return buildGuardFailure({
        error: "lark_write_sandbox_required",
        message: "Test/demo/verify document creation is blocked unless LARK_WRITE_SANDBOX_FOLDER_TOKEN is configured.",
        classification,
        policy,
        requestedFolderToken,
      });
    }

    if (policy.sandboxTenantKeys.length > 0 && !policy.sandboxTenantKeys.includes(tenantKey)) {
      return buildGuardFailure({
        error: "lark_write_sandbox_tenant_required",
        message: "Test/demo/verify document creation is allowed only in sandbox tenants.",
        classification,
        policy,
        requestedFolderToken,
        resolvedFolderToken: policy.sandboxFolderToken,
      });
    }

    resolvedFolderToken = policy.sandboxFolderToken;
  }

  return {
    ok: true,
    classification,
    policy: {
      allow_writes: policy.allowWrites,
      require_create_confirmation: policy.requireCreateConfirmation,
      allow_root_fallback: policy.allowRootFallback,
    },
    requested_folder_token: cleanText(requestedFolderToken) || null,
    resolved_folder_token: resolvedFolderToken || null,
  };
}

export function assertDocumentCreateAllowed({
  title = "",
  source = "",
  requestedFolderToken = "",
} = {}) {
  assertLarkWriteAllowed();
  const plan = planDocumentCreateGuard({
    title,
    source,
    requestedFolderToken,
    requireConfirmation: false,
    confirmed: true,
  });
  if (!plan.ok) {
    const error = new Error(plan.message);
    error.code = plan.error;
    error.statusCode = plan.statusCode;
    error.guard = plan;
    throw error;
  }
  return plan;
}

export function shouldAllowCreateRootFallback({ title = "", source = "" } = {}) {
  const policy = getLarkWriteGuardPolicy();
  const classification = classifyDocumentCreateRequest({ title, source });
  return policy.allowWrites && policy.allowRootFallback && classification.demo_like !== true;
}

export function assertDocumentCreateProbeAllowed({ title = "", source = "", requestedFolderToken = "" } = {}) {
  assertLarkWriteAllowed();
  const policy = getLarkWriteGuardPolicy();
  if (!policy.allowCreateProbes) {
    const error = new Error(
      "Document create probes are disabled because they create real Lark documents. Set ALLOW_LARK_WRITES=true and ALLOW_LARK_WRITE_PROBES=true to opt in.",
    );
    error.code = "lark_write_probe_disabled";
    error.statusCode = 403;
    error.guard = buildGuardFailure({
      error: "lark_write_probe_disabled",
      message: error.message,
      classification: classifyDocumentCreateRequest({ title, source }),
      policy,
      requestedFolderToken,
    });
    throw error;
  }
}
