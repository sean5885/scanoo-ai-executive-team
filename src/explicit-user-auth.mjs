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
  ["header", "user_access_token"],
  ["header", "userAccessToken"],
  ["context", "user_access_token"],
  ["context", "userAccessToken"],
  ["event_context", "user_access_token"],
  ["event_context", "userAccessToken"],
  ["eventContext", "user_access_token"],
  ["eventContext", "userAccessToken"],
  ["authorization", "user_access_token"],
  ["authorization", "userAccessToken"],
  ["auth", "user_access_token"],
  ["auth", "userAccessToken"],
  ["message", "user_access_token"],
  ["message", "userAccessToken"],
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

export function buildExplicitUserAuthContext({
  event = null,
  accountId = "",
  persistedAuth = null,
} = {}) {
  const eventToken = extractUserAccessTokenFromLarkEvent(event);
  if (eventToken) {
    return normalizeExplicitUserAuthContext({
      account_id: accountId || persistedAuth?.account_id || null,
      access_token: eventToken,
      source: "event_user_access_token",
    });
  }
  return normalizeExplicitUserAuthContext(persistedAuth);
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
