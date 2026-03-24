import test from "node:test";
import assert from "node:assert/strict";

import {
  assertLarkWriteAllowed,
  getDocumentCreateGovernanceContract,
  planDocumentCreateGuard,
  shouldAllowCreateRootFallback,
  validateDocumentCreateEntryGovernance,
} from "../src/lark-write-guard.mjs";

function withEnv(t, values = {}) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  t.after(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test("planDocumentCreateGuard blocks live writes by default", (t) => {
  withEnv(t, {
    ALLOW_LARK_WRITES: null,
    LARK_WRITE_SANDBOX_FOLDER_TOKEN: null,
  });

  const result = planDocumentCreateGuard({
    title: "Ops Runbook",
    confirmed: true,
    requireConfirmation: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "lark_writes_disabled");
});

test("planDocumentCreateGuard requires confirm=true when configured", (t) => {
  withEnv(t, {
    ALLOW_LARK_WRITES: "true",
    LARK_WRITE_REQUIRE_CONFIRM: "true",
  });

  const result = planDocumentCreateGuard({
    title: "Ops Runbook",
    confirmed: false,
    requireConfirmation: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "lark_write_confirmation_required");
});

test("planDocumentCreateGuard redirects demo titles into sandbox folder", (t) => {
  withEnv(t, {
    ALLOW_LARK_WRITES: "true",
    LARK_WRITE_SANDBOX_FOLDER_TOKEN: "sandbox-folder",
  });

  const result = planDocumentCreateGuard({
    title: "Planner Tool Success Verify",
    requestedFolderToken: "prod-folder",
    confirmed: true,
    requireConfirmation: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.classification.demo_like, true);
  assert.equal(result.resolved_folder_token, "sandbox-folder");
});

test("shouldAllowCreateRootFallback stays off by default", (t) => {
  withEnv(t, {
    ALLOW_LARK_WRITES: "true",
    ALLOW_LARK_CREATE_ROOT_FALLBACK: null,
  });

  assert.equal(shouldAllowCreateRootFallback({ title: "Ops Runbook" }), false);
});

test("assertLarkWriteAllowed blocks production even when env is enabled", (t) => {
  withEnv(t, {
    NODE_ENV: "production",
    ALLOW_LARK_WRITES: "true",
  });

  assert.throws(
    () => assertLarkWriteAllowed(),
    /Lark write disabled in production/,
  );
});

test("document create governance contract includes required entry fields", () => {
  const contract = getDocumentCreateGovernanceContract();

  assert.deepEqual(contract.required_entry_fields, ["source", "owner", "intent", "type"]);
});

test("validateDocumentCreateEntryGovernance blocks missing entry metadata", () => {
  const result = validateDocumentCreateEntryGovernance({
    source: "api_doc_create",
    owner: "",
    intent: "create_doc",
    type: "",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "entry_governance_required");
  assert.deepEqual(result.missing_fields, ["owner", "type"]);
});
