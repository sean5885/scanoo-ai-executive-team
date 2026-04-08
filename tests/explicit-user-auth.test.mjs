import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPLICIT_USER_AUTH_HEADERS,
  buildExplicitUserAuthContext,
  extractUserAccessTokenFromLarkEvent,
  readExplicitUserAuthContextFromRequest,
  requestRequiresExplicitUserAuth,
} from "../src/explicit-user-auth.mjs";

test("extractUserAccessTokenFromLarkEvent reads user_access_token from im.message.receive_v1-style header payload", () => {
  const token = extractUserAccessTokenFromLarkEvent({
    header: {
      event_type: "im.message.receive_v1",
      user_access_token: "event-token-1",
    },
  });

  assert.equal(token, "event-token-1");
});

test("buildExplicitUserAuthContext falls back to persisted session auth after reload", () => {
  const auth = buildExplicitUserAuthContext({
    event: {
      header: {
        event_type: "im.message.receive_v1",
      },
    },
    accountId: "acct-1",
    persistedAuth: {
      account_id: "acct-1",
      access_token: "persisted-token-1",
      source: "session_user_access_token",
    },
  });

  assert.deepEqual(auth, {
    account_id: "acct-1",
    access_token: "persisted-token-1",
    source: "session_user_access_token",
  });
});

test("buildExplicitUserAuthContext prefers plugin dispatch explicit auth envelopes on lane handoff", () => {
  const auth = buildExplicitUserAuthContext({
    event: {
      __lobster_plugin_dispatch: {
        plugin_context: {
          explicit_auth: {
            account_id: "acct-plugin",
            access_token: "plugin-token-1",
            source: "plugin_dispatch_params",
          },
        },
      },
    },
    accountId: "acct-fallback",
    persistedAuth: {
      account_id: "acct-persisted",
      access_token: "persisted-token-1",
      source: "session_user_access_token",
    },
  });

  assert.deepEqual(auth, {
    account_id: "acct-plugin",
    access_token: "plugin-token-1",
    source: "plugin_dispatch_params",
  });
});

test("request explicit auth helpers read planner bridge headers", () => {
  const headers = {
    [EXPLICIT_USER_AUTH_HEADERS.accountId]: "acct-1",
    [EXPLICIT_USER_AUTH_HEADERS.userAccessToken]: "event-token-1",
    [EXPLICIT_USER_AUTH_HEADERS.source]: "event_user_access_token",
    [EXPLICIT_USER_AUTH_HEADERS.required]: "true",
  };

  assert.deepEqual(readExplicitUserAuthContextFromRequest(headers), {
    account_id: "acct-1",
    access_token: "event-token-1",
    source: "event_user_access_token",
  });
  assert.equal(requestRequiresExplicitUserAuth(headers), true);
});
