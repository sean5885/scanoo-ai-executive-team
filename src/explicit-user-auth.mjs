import { cleanText } from "./message-intent-utils.mjs";

export const EXPLICIT_USER_AUTH_HEADERS = Object.freeze({
  accountId: "x-lobster-account-id",
  userAccessToken: "x-lobster-user-access-token",
  source: "x-lobster-auth-source",
  required: "x-lobster-explicit-user-auth",
});

const EVENT_USER_ACCESS_TOKEN_PATHS = [
  ["user_access_token"],
  ["userAccessToken"],
  ["explicit_auth", "access_token"],
  ["explicit_auth", "user_access_token"],
  ["header", "user_access_token"],
  ["header", "userAccessToken"],
  ["context", "user_access_token"],
  ["context", "userAccessToken"],
  ["context", "explicit_auth", "access_token"],
  ["context", "explicit_auth", "user_access_token"],
  ["event_context", "user_access_token"],
  ["event_context", "userAccessToken"],
  ["event_context", "explicit_auth", "access_token"],
  ["event_context", "explicit_auth", "user_access_token"],
  ["eventContext", "user_access_token"],
  ["eventContext", "userAccessToken"],
  ["eventContext", "explicit_auth", "access_token"],
  ["eventContext", "explicit_auth", "user_access_token"],
  ["authorization", "user_access_token"],
  ["authorization", "userAccessToken"],
  ["auth", "user_access_token"],
  ["auth", "userAccessToken"],
  ["message", "user_access_token"],
  ["message", "userAccessToken"],
  ["plugin_context", "explicit_auth", "access_token"],
  ["plugin_context", "explicit_auth", "user_access_token"],
  ["__lobster_plugin_dispatch", "explicit_auth", "access_token"],
  ["__lobster_plugin_dispatch", "explicit_auth", "user_access_token"],
  ["__lobster_plugin_dispatch", "plugin_context", "explicit_auth", "access_token"],
  ["__lobster_plugin_dispatch", "plugin_context", "explicit_auth", "user_access_token"],
];

const EVENT_EXPLICIT_AUTH_CONTEXT_PATHS = [
  ["explicit_auth"],
  ["context", "explicit_auth"],
  ["event_context", "explicit_auth"],
  ["eventContext", "explicit_auth"],
  ["plugin_context", "explicit_auth"],
  ["__lobster_plugin_dispatch", "explicit_auth"],
  ["__lobster_plugin_dispatch", "plugin_context", "explicit_auth"],
];

function readNestedValue(root, path = []) {
  let current = root;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = current[key];
  }
  return current;
}

function readHeaderValue(headers = {}, name = "") {
  const normalizedName = cleanText(name)?.toLowerCase();
  if (!normalizedName || !headers || typeof headers !== "object") {
    return null;
  }
  const candidates = [
    headers[normalizedName],
    headers[name],
    headers[normalizedName.replace(/-/g, "_")],
  ];
  for (const candidate of candidates) {
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    const cleaned = cleanText(value);
    if (cleaned) {
      return cleaned;
    }
  }
  return null;
}

export function normalizeExplicitUserAuthContext(input = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const accountId = cleanText(input.account_id || input.accountId || "");
  const accessToken = cleanText(input.access_token || input.accessToken || "");
  const source = cleanText(input.source || "") || null;
  if (!accountId && !accessToken) {
    return null;
  }
  return {
    account_id: accountId || null,
    access_token: accessToken || null,
    source,
  };
}

export function extractUserAccessTokenFromLarkEvent(event = null) {
  for (const path of EVENT_USER_ACCESS_TOKEN_PATHS) {
    const token = cleanText(readNestedValue(event, path));
    if (token) {
      return token;
    }
  }
  return null;
}

function extractExplicitUserAuthContextFromLarkEvent(event = null) {
  for (const path of EVENT_EXPLICIT_AUTH_CONTEXT_PATHS) {
    const auth = normalizeExplicitUserAuthContext(readNestedValue(event, path));
    if (auth?.account_id || auth?.access_token || auth?.source) {
      return auth;
    }
  }
  return null;
}

export function buildExplicitUserAuthContext({
  event = null,
  accountId = "",
  persistedAuth = null,
} = {}) {
  const normalizedPersistedAuth = normalizeExplicitUserAuthContext(persistedAuth);
  const eventAuth = extractExplicitUserAuthContextFromLarkEvent(event);
  if (eventAuth) {
    return normalizeExplicitUserAuthContext({
      account_id: eventAuth.account_id || accountId || normalizedPersistedAuth?.account_id || null,
      access_token: eventAuth.access_token || normalizedPersistedAuth?.access_token || null,
      source: eventAuth.source || normalizedPersistedAuth?.source || "event_explicit_user_auth",
    });
  }
  const eventToken = extractUserAccessTokenFromLarkEvent(event);
  if (eventToken) {
    return normalizeExplicitUserAuthContext({
      account_id: accountId || normalizedPersistedAuth?.account_id || null,
      access_token: eventToken,
      source: normalizedPersistedAuth?.source || "event_user_access_token",
    });
  }
  return normalizedPersistedAuth;
}

export function buildExplicitUserAuthHeaders(authContext = null, { required = false } = {}) {
  const normalized = normalizeExplicitUserAuthContext(authContext);
  const headers = {};
  if (required) {
    headers[EXPLICIT_USER_AUTH_HEADERS.required] = "true";
  }
  if (normalized?.account_id) {
    headers[EXPLICIT_USER_AUTH_HEADERS.accountId] = normalized.account_id;
  }
  if (normalized?.access_token) {
    headers[EXPLICIT_USER_AUTH_HEADERS.userAccessToken] = normalized.access_token;
  }
  if (normalized?.source) {
    headers[EXPLICIT_USER_AUTH_HEADERS.source] = normalized.source;
  }
  return headers;
}

export function readExplicitUserAuthContextFromRequest(headers = null) {
  if (!headers || typeof headers !== "object") {
    return null;
  }
  return normalizeExplicitUserAuthContext({
    account_id: readHeaderValue(headers, EXPLICIT_USER_AUTH_HEADERS.accountId),
    access_token: readHeaderValue(headers, EXPLICIT_USER_AUTH_HEADERS.userAccessToken),
    source: readHeaderValue(headers, EXPLICIT_USER_AUTH_HEADERS.source),
  });
}

export function requestRequiresExplicitUserAuth(headers = null) {
  return readHeaderValue(headers, EXPLICIT_USER_AUTH_HEADERS.required) === "true";
}
