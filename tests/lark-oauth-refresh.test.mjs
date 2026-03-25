import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import db, { closeDbForTests } from "../src/db.mjs";
import { startHttpServer } from "../src/http-server.mjs";
import {
  exchangeCodeForUserToken,
  setLarkAuthServiceOverridesForTests,
} from "../src/lark-user-auth.mjs";
import { resolveLarkRequestAuth } from "../src/lark-request-auth.mjs";
import { getTokenForAccount, saveToken, upsertAccount } from "../src/rag-repository.mjs";

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function cleanupAccount(accountId) {
  if (!accountId) {
    return;
  }
  db.prepare("DELETE FROM lark_accounts WHERE id = ?").run(accountId);
}

function createTestAccount() {
  return upsertAccount({
    open_id: `ou_test_${crypto.randomUUID()}`,
    name: "OAuth Refresh Test",
  }, "offline_access");
}

test("oauth callback persists access_token, refresh_token, and expires_at", async (t) => {
  let accountId = null;
  const openId = `ou_test_${crypto.randomUUID()}`;

  setLarkAuthServiceOverridesForTests({
    postAuthenJson: async (pathname) => {
      assert.equal(pathname, "/open-apis/authen/v1/access_token");
      return {
        access_token: "access-callback-1",
        refresh_token: "refresh-callback-1",
        expires_in: 3600,
        refresh_expires_in: 7200,
        scope: "offline_access",
        open_id: openId,
      };
    },
    getUserProfile: async () => ({
      open_id: openId,
      name: "OAuth Callback User",
    }),
  });
  t.after(() => {
    setLarkAuthServiceOverridesForTests({});
    cleanupAccount(accountId);
  });

  const token = await exchangeCodeForUserToken("code-1");
  accountId = token.account_id;
  const stored = getTokenForAccount(accountId);

  assert.equal(stored.access_token, "access-callback-1");
  assert.equal(stored.refresh_token, "refresh-callback-1");
  assert.ok(Number.isFinite(stored.expires_at));
  assert.ok(stored.expires_at > nowSeconds());
});

test("request auth uses a valid stored token without refreshing", async (t) => {
  const account = createTestAccount();
  t.after(() => cleanupAccount(account.id));

  saveToken(account.id, {
    access_token: "access-still-valid",
    refresh_token: "refresh-still-valid",
    token_type: "Bearer",
    scope: "offline_access",
    expires_at: nowSeconds() + 1800,
    refresh_expires_at: nowSeconds() + 7200,
  });

  const auth = await resolveLarkRequestAuth({ account_id: account.id });

  assert.equal(auth.accessToken, "access-still-valid");
  assert.equal(auth.accountId, account.id);
  assert.equal(auth.refreshed, false);
});

test("request auth automatically refreshes an expired token and persists the replacement", async (t) => {
  const account = createTestAccount();
  let refreshCalls = 0;

  saveToken(account.id, {
    access_token: "access-expired",
    refresh_token: "refresh-expired",
    token_type: "Bearer",
    scope: "offline_access",
    expires_at: nowSeconds() - 30,
    refresh_expires_at: nowSeconds() + 7200,
  });

  setLarkAuthServiceOverridesForTests({
    postAuthenJson: async (pathname, payload) => {
      refreshCalls += 1;
      assert.equal(pathname, "/open-apis/authen/v1/refresh_access_token");
      assert.equal(payload.refresh_token, "refresh-expired");
      return {
        access_token: "access-refreshed",
        refresh_token: "refresh-refreshed",
        expires_in: 3600,
        refresh_expires_in: 7200,
        scope: "offline_access",
        open_id: account.open_id,
      };
    },
    getUserProfile: async () => ({
      open_id: account.open_id,
      name: "Refreshed User",
    }),
  });
  t.after(() => {
    setLarkAuthServiceOverridesForTests({});
    cleanupAccount(account.id);
  });

  const auth = await resolveLarkRequestAuth({ account_id: account.id });
  const stored = getTokenForAccount(account.id);

  assert.equal(refreshCalls, 1);
  assert.equal(auth.accessToken, "access-refreshed");
  assert.equal(auth.refreshed, true);
  assert.equal(stored.access_token, "access-refreshed");
  assert.equal(stored.refresh_token, "refresh-refreshed");
});

test("request auth still refreshes persisted oauth after db reopen", async (t) => {
  const account = createTestAccount();
  let refreshCalls = 0;

  saveToken(account.id, {
    access_token: "access-before-restart",
    refresh_token: "refresh-before-restart",
    token_type: "Bearer",
    scope: "offline_access",
    expires_at: nowSeconds() - 30,
    refresh_expires_at: nowSeconds() + 7200,
  });

  closeDbForTests();

  setLarkAuthServiceOverridesForTests({
    postAuthenJson: async (pathname, payload) => {
      refreshCalls += 1;
      assert.equal(pathname, "/open-apis/authen/v1/refresh_access_token");
      assert.equal(payload.refresh_token, "refresh-before-restart");
      return {
        access_token: "access-after-restart",
        refresh_token: "refresh-after-restart",
        expires_in: 3600,
        refresh_expires_in: 7200,
        scope: "offline_access",
        open_id: account.open_id,
      };
    },
    getUserProfile: async () => ({
      open_id: account.open_id,
      name: "Restarted OAuth User",
    }),
  });
  t.after(() => {
    setLarkAuthServiceOverridesForTests({});
    cleanupAccount(account.id);
    closeDbForTests();
  });

  const auth = await resolveLarkRequestAuth({ account_id: account.id });
  const stored = getTokenForAccount(account.id);

  assert.equal(refreshCalls, 1);
  assert.equal(auth.accessToken, "access-after-restart");
  assert.equal(auth.refreshed, true);
  assert.equal(stored.access_token, "access-after-restart");
  assert.equal(stored.refresh_token, "refresh-after-restart");
});

test("http route returns oauth_reauth_required only when refresh cannot recover", async (t) => {
  const server = startHttpServer({
    listen: false,
    serviceOverrides: {
      getValidUserTokenState: async () => ({
        status: "reauth_required",
        account: { id: "acct-reauth" },
        token: {
          access_token: "expired-token",
          refresh_token: "bad-refresh",
        },
        refreshed: false,
        error: new Error("refresh failed"),
      }),
      getStoredAccountContext: async () => ({
        account: { id: "acct-reauth" },
      }),
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/drive/list`);
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.error, "oauth_reauth_required");
});
