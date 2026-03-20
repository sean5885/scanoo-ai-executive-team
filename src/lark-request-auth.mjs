import { getValidUserTokenState } from "./lark-user-auth.mjs";

let activeRequestAuthOverrides = {};

function getRequestAuthService(name, fallback) {
  const override = activeRequestAuthOverrides?.[name];
  return typeof override === "function" ? override : fallback;
}

export function setLarkRequestAuthOverridesForTests(overrides = {}) {
  activeRequestAuthOverrides = overrides && typeof overrides === "object" ? overrides : {};
}

export class OAuthReauthRequiredError extends Error {
  constructor(message = "Stored OAuth token expired and refresh failed.") {
    super(message);
    this.name = "OAuthReauthRequiredError";
    this.code = "oauth_reauth_required";
  }
}

export function isOAuthReauthRequiredError(error) {
  return error?.code === "oauth_reauth_required" || error?.name === "OAuthReauthRequiredError";
}

function normalizeString(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function normalizeAuthInput(input) {
  if (typeof input === "string") {
    return {
      accessToken: normalizeString(input),
      accountId: null,
      tokenType: null,
    };
  }

  if (!input || typeof input !== "object") {
    return {
      accessToken: null,
      accountId: null,
      tokenType: null,
    };
  }

  return {
    accessToken: normalizeString(input.accessToken || input.access_token),
    accountId: normalizeString(input.accountId || input.account_id),
    tokenType: normalizeString(input.tokenType || input.token_type),
  };
}

export async function resolveLarkRequestAuth(input, { tokenType = "user" } = {}) {
  const normalized = normalizeAuthInput(input);
  const effectiveTokenType = normalized.tokenType || tokenType || "user";

  if (effectiveTokenType !== "user") {
    if (!normalized.accessToken) {
      throw new Error("missing_access_token");
    }
    return {
      accessToken: normalized.accessToken,
      accountId: normalized.accountId,
      tokenType: effectiveTokenType,
      refreshed: false,
      token: null,
    };
  }

  if (!normalized.accountId) {
    if (!normalized.accessToken) {
      throw new Error("missing_user_access_token");
    }
    return {
      accessToken: normalized.accessToken,
      accountId: null,
      tokenType: "user",
      refreshed: false,
      token: null,
    };
  }

  const state = await getRequestAuthService("getValidUserTokenState", getValidUserTokenState)(normalized.accountId);

  if (state?.status === "valid" && state.token?.access_token) {
    return {
      accessToken: state.token.access_token,
      accountId: state.token.account_id || normalized.accountId,
      tokenType: "user",
      refreshed: Boolean(state.refreshed),
      token: state.token,
    };
  }

  if (state?.status === "reauth_required") {
    throw new OAuthReauthRequiredError();
  }

  if (!normalized.accessToken) {
    throw new Error("missing_user_access_token");
  }

  return {
    accessToken: normalized.accessToken,
    accountId: normalized.accountId,
    tokenType: "user",
    refreshed: false,
    token: state?.token || null,
  };
}
