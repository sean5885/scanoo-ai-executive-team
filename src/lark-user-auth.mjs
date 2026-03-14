import crypto from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  apiBaseUrl,
  baseConfig,
  oauthAuthorizeUrl,
  oauthRedirectUri,
  oauthScopes,
} from "./config.mjs";
import { getAccountContext, getAccountContextByOpenId, saveToken, upsertAccount } from "./rag-repository.mjs";

const userClient = new Lark.Client(baseConfig);

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeTokenData(data) {
  if (!data?.access_token) {
    throw new Error("Missing user access token in OAuth response");
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: data.expires_in || 0,
    refresh_expires_in: data.refresh_expires_in || 0,
    scope: data.scope || oauthScopes,
    token_type: data.token_type || "Bearer",
    open_id: data.open_id || null,
    user_id: data.user_id || null,
    union_id: data.union_id || null,
    tenant_key: data.tenant_key || null,
    obtained_at: nowSeconds(),
    expires_at: nowSeconds() + (data.expires_in || 0),
    refresh_expires_at: data.refresh_expires_in
      ? nowSeconds() + data.refresh_expires_in
      : null,
  };
}

async function postAuthenJson(pathname, payload) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      app_id: baseConfig.appId,
      app_secret: baseConfig.appSecret,
      ...payload,
    }),
  });

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new Error(data.msg || data.message || `Lark auth request failed: ${response.status}`);
  }

  return data.data || {};
}

export function buildOAuthState() {
  return crypto.randomBytes(24).toString("hex");
}

export function buildAuthorizeUrl(state) {
  const url = new URL(oauthAuthorizeUrl);
  url.searchParams.set("app_id", baseConfig.appId);
  url.searchParams.set("redirect_uri", oauthRedirectUri);
  url.searchParams.set("scope", oauthScopes);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

export async function exchangeCodeForUserToken(code) {
  const data = await postAuthenJson("/open-apis/authen/v1/access_token", {
    grant_type: "authorization_code",
    code,
  });

  const token = normalizeTokenData(data);
  return persistUserToken(token);
}

export async function refreshUserToken(refreshToken) {
  const data = await postAuthenJson("/open-apis/authen/v1/refresh_access_token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const token = normalizeTokenData(data);
  return persistUserToken(token);
}

export async function persistUserToken(token) {
  const profile = await getUserProfile(token.access_token);
  const account = upsertAccount(
    {
      ...profile,
      open_id: profile.open_id || token.open_id,
      user_id: profile.user_id || token.user_id,
      union_id: profile.union_id || token.union_id,
      tenant_key: profile.tenant_key || token.tenant_key,
    },
    token.scope,
  );

  saveToken(account.id, token);
  return { ...token, account_id: account.id, account };
}

export async function getStoredUserToken(accountId) {
  const context = getAccountContext(accountId);
  return context?.token || null;
}

export async function getStoredAccountContext(accountId) {
  return getAccountContext(accountId);
}

export async function getStoredAccountContextByOpenId(openId) {
  return getAccountContextByOpenId(openId);
}

export async function getValidUserToken(accountId) {
  const context = getAccountContext(accountId);
  const token = context?.token;

  if (!token?.access_token) {
    return null;
  }

  if ((token.expires_at || 0) - nowSeconds() > 120) {
    return token;
  }

  if (!token.refresh_token) {
    return null;
  }

  return refreshUserToken(token.refresh_token);
}

export async function getUserProfile(accessToken) {
  const response = await userClient.authen.v1.userInfo.get(
    {},
    Lark.withUserAccessToken(accessToken),
  );

  if (response.code !== 0) {
    throw new Error(response.msg || "Failed to fetch Lark user profile");
  }

  return response.data || {};
}
