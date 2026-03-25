import test from "node:test";
import assert from "node:assert/strict";

import { runMutation } from "../src/mutation-runtime.mjs";

test("runMutation returns a stable error when no execute callback is provided", async () => {
  const result = await runMutation({
    action: "create_doc",
    payload: { title: "demo" },
    context: { pathname: "/api/doc/create" },
  });

  assert.deepEqual(result, {
    ok: false,
    error: "missing_execute",
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
  const originalNow = Date.now;
  const times = [1000, 1042];

  Date.now = () => times.shift() ?? 1042;

  try {
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
      result: {
        ok: true,
        action: "create_doc",
        passthrough: true,
      },
      meta: {
        execution_mode: "passthrough",
        duration_ms: 42,
      },
    });
  } finally {
    Date.now = originalNow;
  }
});

test("runMutation returns a stable execution_failed boundary with timing when execute throws", async () => {
  const originalNow = Date.now;
  const times = [2000, 2035];

  Date.now = () => times.shift() ?? 2035;

  try {
    const result = await runMutation({
      action: "create_doc",
      payload: { title: "demo" },
      context: { execution_mode: "controlled" },
      async execute() {
        throw new Error("boom");
      },
    });

    assert.deepEqual(result, {
      ok: false,
      action: "create_doc",
      error: "execution_failed",
      meta: {
        execution_mode: "controlled",
        duration_ms: 35,
      },
    });
  } finally {
    Date.now = originalNow;
  }
});
