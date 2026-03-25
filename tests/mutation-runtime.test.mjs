import test from "node:test";
import assert from "node:assert/strict";

import { runMutation } from "../src/mutation-runtime.mjs";

test("runMutation keeps skeleton response when no execute callback is provided", async () => {
  const result = await runMutation({
    action: "create_doc",
    payload: { title: "demo" },
    context: { pathname: "/api/doc/create" },
  });

  assert.deepEqual(result, {
    ok: true,
    action: "create_doc",
    note: "mutation runtime skeleton",
  });
});

test("runMutation passes through to execute without changing create_doc inputs", async () => {
  const payload = {
    title: "demo",
    folder_token: "fld_123",
  };
  const context = {
    pathname: "/api/doc/create",
    account_id: "acct-1",
  };
  const calls = [];

  const result = await runMutation({
    action: "create_doc",
    payload,
    context,
    async execute(input) {
      calls.push(input);
      return {
        ok: true,
        action: input.action,
        passthrough: true,
      };
    },
  });

  assert.deepEqual(calls, [{
    action: "create_doc",
    payload,
    context,
  }]);
  assert.deepEqual(result, {
    ok: true,
    action: "create_doc",
    passthrough: true,
  });
});
