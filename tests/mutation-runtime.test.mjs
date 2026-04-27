import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

import { runMutation } from "../src/mutation-runtime.mjs";
import {
  buildCompanyBrainApplyCanonicalRequest,
  buildCompanyBrainConflictCanonicalRequest,
  buildDriveOrganizeApplyCanonicalRequest,
  buildIngestLearningDocCanonicalRequest,
  buildMeetingConfirmWriteCanonicalRequest,
  buildUpdateLearningStateCanonicalRequest,
} from "../src/mutation-admission.mjs";

const testDb = await createTestDbHarness();

test.after(() => {
  testDb.close();
});

function buildExpectedExecutionEnvelope({
  ok = false,
  action = null,
  data = null,
  meta = null,
  error = null,
} = {}) {
  return {
    ok,
    action,
    data,
    meta,
    error,
  };
}

function findScopedIdempotencyEntry(rawKey = "") {
  const store = globalThis.__mutation_idempotency_store__;
  if (!(store instanceof Map)) {
    return null;
  }
  const prefix = `${rawKey}::`;
  const matchedKey = Array.from(store.keys()).find((key) => String(key).startsWith(prefix));
  if (!matchedKey) {
    return null;
  }
  return {
    key: matchedKey,
    entry: store.get(matchedKey),
  };
}

test("runMutation returns a stable error when no execute callback is provided", async () => {
  const result = await runMutation({
    action: "create_doc",
    payload: { title: "demo" },
    context: { pathname: "/api/doc/create" },
  });

  assert.deepEqual(result, buildExpectedExecutionEnvelope({
    ok: false,
    action: "create_doc",
    error: "missing_execute",
  }));
});

test("runMutation rejects a non-function executor with a stable contract error", async () => {
  const result = await runMutation({
    action: "create_doc",
    payload: { title: "demo" },
    context: { pathname: "/api/doc/create" },
    execute: "not-a-function",
  });

  assert.deepEqual(result, buildExpectedExecutionEnvelope({
    ok: false,
    action: "create_doc",
    data: {
      message: "execute must be a function",
    },
    error: "invalid_executor",
  }));
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
    assert.deepEqual(result, buildExpectedExecutionEnvelope({
      ok: true,
      action: "create_doc",
      data: {
        ok: true,
        action: "create_doc",
        passthrough: true,
      },
      meta: {
        execution_mode: "passthrough",
        duration_ms: 42,
        journal: {
          action: "create_doc",
          status: "success",
          started_at: 1000,
        },
        write_policy: null,
        authority: null,
      },
      error: null,
    }));
  } finally {
    Date.now = originalNow;
  }
});

test("runMutation marks controlled execution input when execution_mode is controlled", async () => {
  const payload = { title: "demo" };
  const context = {
    pathname: "/api/doc/create",
    execution_mode: "controlled",
  };
  const calls = [];
  const originalNow = Date.now;
  const times = [3000, 3017];

  Date.now = () => times.shift() ?? 3017;

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
          controlled: input.controlled === true,
        };
      },
    });

    assert.deepEqual(calls, [{
      action: "create_doc",
      payload,
      context,
      controlled: true,
    }]);
    assert.deepEqual(result, buildExpectedExecutionEnvelope({
      ok: true,
      action: "create_doc",
      data: {
        ok: true,
        action: "create_doc",
        controlled: true,
      },
      meta: {
        execution_mode: "controlled",
        duration_ms: 17,
        journal: {
          action: "create_doc",
          status: "success",
          started_at: 3000,
        },
        write_policy: null,
        authority: null,
      },
      error: null,
    }));
  } finally {
    Date.now = originalNow;
  }
});

test("runMutation blocks execute when context write_policy.allowed_actions excludes the action", async () => {
  let called = false;

  const result = await runMutation({
    action: "create_doc",
    payload: { title: "demo" },
    context: {
      write_policy: {
        allowed_actions: ["update_doc"],
        source: "test_policy",
      },
    },
    async execute() {
      called = true;
      return { ok: true };
    },
  });

  assert.equal(called, false);
  assert.deepEqual(result, buildExpectedExecutionEnvelope({
    ok: false,
    action: "create_doc",
    data: {
      message: 'action "create_doc" is not allowed',
    },
    meta: {
      execution_mode: "passthrough",
      duration_ms: 0,
      journal: {
        action: "create_doc",
        status: "blocked",
        started_at: result.meta.journal.started_at,
        error: "write_policy_violation",
      },
      write_policy: {
        allowed_actions: ["update_doc"],
        source: "test_policy",
      },
    },
    error: "write_policy_violation",
  }));
  assert.equal(typeof result.meta?.journal?.started_at, "number");
});

test("runMutation exposes context write_policy in success meta", async () => {
  const writePolicy = {
    allowed_actions: ["create_doc"],
    source: "test_policy",
  };

  const result = await runMutation({
    action: "create_doc",
    payload: { title: "demo" },
    context: {
      write_policy: writePolicy,
    },
    async execute() {
      return { ok: true, created: true };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.meta?.write_policy, writePolicy);
});

test("runMutation blocks execute when context authority does not match write_policy authority", async () => {
  let called = false;

  const result = await runMutation({
    action: "create_doc",
    payload: { title: "demo" },
    context: {
      authority: "mirror",
      write_policy: {
        allowed_actions: ["create_doc"],
        authority: "derived",
        source: "test_policy",
      },
    },
    async execute() {
      called = true;
      return { ok: true };
    },
  });

  assert.equal(called, false);
  assert.deepEqual(result, buildExpectedExecutionEnvelope({
    ok: false,
    action: "create_doc",
    data: {
      message: 'requires authority "derived" but got "mirror"',
    },
    meta: {
      execution_mode: "passthrough",
      duration_ms: 0,
      journal: {
        action: "create_doc",
        status: "blocked",
        started_at: result.meta.journal.started_at,
        error: "authority_mismatch",
      },
      write_policy: {
        allowed_actions: ["create_doc"],
        authority: "derived",
        source: "test_policy",
      },
      authority: "mirror",
    },
    error: "authority_mismatch",
  }));
  assert.equal(typeof result.meta?.journal?.started_at, "number");
});

test("runMutation exposes context authority in success meta", async () => {
  const result = await runMutation({
    action: "create_doc",
    payload: { title: "demo" },
    context: {
      authority: "derived",
      write_policy: {
        allowed_actions: ["create_doc"],
        authority: "derived",
        source: "test_policy",
      },
    },
    async execute() {
      return { ok: true, created: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.meta?.authority, "derived");
});

test("runMutation replays the first successful response when context idempotency_key repeats", async () => {
  const payload = { title: "demo" };
  const context = {
    pathname: "/api/doc/create",
    idempotency_key: "mutation-runtime-idem-test",
  };
  const calls = [];
  const originalNow = Date.now;
  const times = [6000, 6025, 7000, 7040];

  Date.now = () => times.shift() ?? 7040;

  try {
    delete globalThis.__mutation_idempotency_store__;

    const firstResult = await runMutation({
      action: "create_doc",
      payload,
      context,
      async execute(input) {
        calls.push(input);
        return {
          ok: true,
          created: true,
        };
      },
    });

    const secondResult = await runMutation({
      action: "create_doc",
      payload,
      context,
      async execute(input) {
        calls.push(input);
        return {
          ok: true,
          created: false,
        };
      },
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(firstResult, buildExpectedExecutionEnvelope({
      ok: true,
      action: "create_doc",
      data: {
        ok: true,
        created: true,
      },
      meta: {
        execution_mode: "passthrough",
        duration_ms: 25,
        journal: {
          action: "create_doc",
          status: "success",
          started_at: 6000,
        },
        write_policy: null,
        authority: null,
      },
      error: null,
    }));
    assert.deepEqual(secondResult, firstResult);
  } finally {
    Date.now = originalNow;
    delete globalThis.__mutation_idempotency_store__;
  }
});

test("runMutation scopes idempotency by account/action/path so shared keys across flows do not collide", async () => {
  const idempotencyKey = "mutation-runtime-shared-key";
  const calls = [];

  delete globalThis.__mutation_idempotency_store__;

  const reviewResult = await runMutation({
    action: "review_company_brain_doc",
    payload: { doc_id: "doc-1" },
    context: {
      account_id: "acct-1",
      pathname: "/agent/company-brain/review",
      idempotency_key: idempotencyKey,
    },
    async execute() {
      calls.push("review");
      return {
        ok: true,
        path: "review",
      };
    },
  });

  const approvalResult = await runMutation({
    action: "approval_transition_company_brain_doc",
    payload: { doc_id: "doc-1", decision: "approve" },
    context: {
      account_id: "acct-1",
      pathname: "/agent/company-brain/approval-transition",
      idempotency_key: idempotencyKey,
    },
    async execute() {
      calls.push("approval_transition");
      return {
        ok: true,
        path: "approval_transition",
      };
    },
  });

  assert.equal(reviewResult.ok, true);
  assert.equal(approvalResult.ok, true);
  assert.deepEqual(calls, ["review", "approval_transition"]);
  assert.equal(
    Array.from(globalThis.__mutation_idempotency_store__.keys())
      .filter((key) => String(key).startsWith(`${idempotencyKey}::`))
      .length,
    2,
  );

  delete globalThis.__mutation_idempotency_store__;
});

test("runMutation returns idempotency_in_progress while the same context idempotency_key is still executing", async () => {
  const payload = { title: "demo" };
  const context = {
    pathname: "/api/doc/create",
    idempotency_key: "mutation-runtime-pending-test",
  };
  let releaseExecution;

  delete globalThis.__mutation_idempotency_store__;

  const firstRun = runMutation({
    action: "create_doc",
    payload,
    context,
    async execute() {
      await new Promise((resolve) => {
        releaseExecution = resolve;
      });
      return {
        ok: true,
        created: true,
      };
    },
  });

  const secondResult = await runMutation({
    action: "create_doc",
    payload,
    context,
    async execute() {
      return {
        ok: true,
        created: false,
      };
    },
  });

  assert.deepEqual(secondResult, buildExpectedExecutionEnvelope({
    ok: false,
    action: "create_doc",
    error: "idempotency_in_progress",
  }));

  releaseExecution();
  const firstResult = await firstRun;

  assert.equal(firstResult.ok, true);
  assert.equal(findScopedIdempotencyEntry(context.idempotency_key)?.entry?.__status, "done");

  delete globalThis.__mutation_idempotency_store__;
});

test("runMutation clears pending idempotency state after execution failure", async () => {
  const payload = { title: "demo" };
  const context = {
    pathname: "/api/doc/create",
    idempotency_key: "mutation-runtime-failure-test",
  };

  delete globalThis.__mutation_idempotency_store__;

  const failedResult = await runMutation({
    action: "create_doc",
    payload,
    context,
    async execute() {
      throw new Error("boom");
    },
  });

  assert.equal(failedResult.ok, false);
  assert.equal(failedResult.error, "execution_failed");
  assert.equal(findScopedIdempotencyEntry(context.idempotency_key), null);

  const retriedResult = await runMutation({
    action: "create_doc",
    payload,
    context,
    async execute() {
      return {
        ok: true,
        created: true,
      };
    },
  });

  assert.equal(retriedResult.ok, true);

  delete globalThis.__mutation_idempotency_store__;
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

    assert.deepEqual(result, buildExpectedExecutionEnvelope({
      ok: false,
      action: "create_doc",
      meta: {
        execution_mode: "controlled",
        duration_ms: 35,
        journal: {
          action: "create_doc",
          status: "failed",
          started_at: 2000,
          error: "boom",
          rollback: {
            status: "pending",
          },
        },
      },
      error: "execution_failed",
    }));
  } finally {
    Date.now = originalNow;
  }
});

test("runMutation executes rollback hook and records success when execute throws", async () => {
  const calls = [];
  const originalNow = Date.now;
  const times = [4000, 4031];

  Date.now = () => times.shift() ?? 4031;

  try {
    const result = await runMutation({
      action: "create_doc",
      payload: { title: "demo" },
      context: {
        execution_mode: "controlled",
        rollback(input) {
          calls.push(input);
        },
      },
      async execute() {
        throw new Error("boom");
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "create_doc");
    assert.equal(calls[0].payload.title, "demo");
    assert.equal(calls[0].context.execution_mode, "controlled");
    assert.equal(calls[0].error?.message, "boom");
    assert.deepEqual(result, buildExpectedExecutionEnvelope({
      ok: false,
      action: "create_doc",
      meta: {
        execution_mode: "controlled",
        duration_ms: 31,
        journal: {
          action: "create_doc",
          status: "failed",
          started_at: 4000,
          error: "boom",
          rollback: {
            status: "success",
          },
        },
      },
      error: "execution_failed",
    }));
  } finally {
    Date.now = originalNow;
  }
});

test("runMutation keeps execution failure shape when rollback hook also fails", async () => {
  const originalNow = Date.now;
  const times = [5000, 5044];

  Date.now = () => times.shift() ?? 5044;

  try {
    const result = await runMutation({
      action: "create_doc",
      payload: { title: "demo" },
      context: {
        execution_mode: "controlled",
        async rollback() {
          throw new Error("rollback_boom");
        },
      },
      async execute() {
        throw new Error("boom");
      },
    });

    assert.deepEqual(result, buildExpectedExecutionEnvelope({
      ok: false,
      action: "create_doc",
      meta: {
        execution_mode: "controlled",
        duration_ms: 44,
        journal: {
          action: "create_doc",
          status: "failed",
          started_at: 5000,
          error: "boom",
          rollback: {
            status: "failed",
            error: "rollback_boom",
          },
        },
      },
      error: "execution_failed",
    }));
  } finally {
    Date.now = originalNow;
  }
});

test("runMutation records nested mutation audit and rollback details", async () => {
  const audit = {
    boundary: "meeting_confirm_write",
    nested_mutations: [],
  };

  const result = await runMutation({
    action: "meeting_confirm_write",
    payload: {
      confirmation_id: "confirm-1",
    },
    context: {
      audit,
      rollback() {
        audit.nested_mutations.push({
          phase: "rollback",
          action: "delete_document",
          target_id: "doc-1",
        });
        return {
          cleanup: "deleted_created_document",
          target_id: "doc-1",
        };
      },
    },
    async execute() {
      audit.nested_mutations.push({
        phase: "execute",
        action: "create_document",
        target_id: "doc-1",
      });
      throw new Error("boom");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "execution_failed");
  assert.deepEqual(result.meta?.journal?.audit, {
    boundary: "meeting_confirm_write",
    nested_mutations: [
      {
        phase: "execute",
        action: "create_document",
        target_id: "doc-1",
      },
      {
        phase: "rollback",
        action: "delete_document",
        target_id: "doc-1",
      },
    ],
  });
  assert.deepEqual(result.meta?.journal?.rollback, {
    status: "success",
    details: {
      cleanup: "deleted_created_document",
      target_id: "doc-1",
    },
  });
});

test("runMutation denies execute when canonical mutation admission blocks the write", async () => {
  const canonicalRequest = buildMeetingConfirmWriteCanonicalRequest({
    pathname: "/api/meeting/confirm",
    targetDocumentId: "doc-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: false,
      verifierCompleted: true,
    },
  });
  let called = false;

  const result = await runMutation({
    action: "meeting_confirm_write",
    payload: {
      confirmation_id: "confirm-1",
    },
    context: {
      account_id: "acct-1",
      pathname: "/api/meeting/confirm",
      canonical_request: canonicalRequest,
    },
    async execute() {
      called = true;
      return { ok: true };
    },
  });

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.action, "meeting_confirm_write");
  assert.equal(result.error, "write_guard_denied");
  assert.equal(result.data?.write_guard?.reason, "confirmation_required");
  assert.equal(result.data?.admission?.allowed, false);
  assert.equal(result.data?.message, "External write requires explicit confirmation before apply.");
});

test("runMutation blocks cloud-doc apply before execute when preview evidence is missing", async () => {
  const canonicalRequest = buildDriveOrganizeApplyCanonicalRequest({
    pathname: "/api/drive/organize/apply",
    folderToken: "fld-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
  });
  let called = false;

  const result = await runMutation({
    action: "drive_organize_apply",
    payload: {
      folder_token: "fld-1",
    },
    context: {
      account_id: "acct-1",
      pathname: "/api/drive/organize/apply",
      canonical_request: canonicalRequest,
      verifier_profile: "cloud_doc_v1",
      verifier_input: {
        scope_key: "drive:fld-1",
      },
    },
    async execute() {
      called = true;
      return { ok: true, result: { moved: 1 } };
    },
  });

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, "mutation_verifier_blocked");
  assert.equal(result.data?.verifier?.phase, "pre");
  assert.equal(result.data?.verifier?.reason, "missing_preview_plan");
});

test("runMutation blocks cloud-doc apply after execute when apply evidence is missing", async () => {
  const canonicalRequest = buildDriveOrganizeApplyCanonicalRequest({
    pathname: "/api/drive/organize/apply",
    folderToken: "fld-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
  });

  const result = await runMutation({
    action: "drive_organize_apply",
    payload: {
      folder_token: "fld-1",
    },
    context: {
      account_id: "acct-1",
      pathname: "/api/drive/organize/apply",
      canonical_request: canonicalRequest,
      verifier_profile: "cloud_doc_v1",
      verifier_input: {
        scope_key: "drive:fld-1",
        scope_type: "drive_folder",
        preview_plan: {
          target_folders: [{ name: "Ops" }],
          moves: [{ file_token: "doc-1", target_folder_name: "Ops" }],
        },
        evidence: [],
      },
    },
    async execute() {
      return {
        ok: true,
        result: {
          moved: 1,
          preview_plan: {
            target_folders: [{ name: "Ops" }],
            moves: [{ file_token: "doc-1", target_folder_name: "Ops" }],
          },
          moves: [{ file_token: "doc-1", status: "moved" }],
        },
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "mutation_verifier_blocked");
  assert.equal(result.data?.verifier?.phase, "post");
  assert.equal(result.data?.verifier?.reason, "insufficient_evidence");
});

test("runMutation blocks company-brain apply before execute when lifecycle gate is not satisfied", async () => {
  const canonicalRequest = buildCompanyBrainApplyCanonicalRequest({
    pathname: "/agent/company-brain/docs/:doc_id/apply",
    docId: "doc-apply-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      externalWrite: false,
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
  });
  let called = false;

  const result = await runMutation({
    action: "apply_company_brain_approved_knowledge",
    payload: {
      doc_id: "doc-apply-1",
    },
    context: {
      account_id: "acct-1",
      pathname: "/agent/company-brain/docs/:doc_id/apply",
      canonical_request: canonicalRequest,
      verifier_profile: "knowledge_write_v1",
      verifier_input: {
        account_id: "acct-1",
        doc_id: "doc-apply-1",
        expected_write: "approved_knowledge",
      },
    },
    async execute() {
      called = true;
      return { success: true, data: { doc_id: "doc-apply-1" }, error: null };
    },
  });

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.error, "mutation_verifier_blocked");
  assert.equal(result.data?.verifier?.phase, "pre");
});

test("runMutation blocks knowledge write after execute when durable db evidence is missing", async () => {
  const canonicalRequest = buildIngestLearningDocCanonicalRequest({
    docId: "doc-learning-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
    },
  });

  const result = await runMutation({
    action: "ingest_learning_doc",
    payload: {
      doc_id: "doc-learning-1",
    },
    context: {
      account_id: "acct-1",
      pathname: "/agent/company-brain/learning/ingest",
      canonical_request: canonicalRequest,
      verifier_profile: "knowledge_write_v1",
      verifier_input: {
        account_id: "acct-1",
        doc_id: "doc-learning-1",
        expected_write: "learning_state",
      },
    },
    async execute() {
      return {
        success: true,
        data: {
          doc: {
            doc_id: "doc-learning-1",
          },
          learning_state: {
            status: "learned",
          },
        },
        error: null,
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "mutation_verifier_blocked");
  assert.equal(result.data?.verifier?.phase, "post");
  assert.equal(result.data?.verifier?.reason, "db_write_missing");
});

test("runMutation allows optional company-brain conflict verification to skip when no review-state mutation is needed", async () => {
  const canonicalRequest = buildCompanyBrainConflictCanonicalRequest({
    docId: "doc-conflict-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
      reviewRequiredActive: true,
    },
  });

  const result = await runMutation({
    action: "check_company_brain_conflicts",
    payload: {
      doc_id: "doc-conflict-1",
    },
    context: {
      account_id: "acct-1",
      pathname: "/agent/company-brain/conflicts",
      canonical_request: canonicalRequest,
      verifier_profile: "knowledge_write_v1",
      verifier_input: {
        account_id: "acct-1",
        doc_id: "doc-conflict-1",
        expected_write: "review_state_optional",
      },
    },
    async execute() {
      return {
        success: true,
        data: {
          doc_id: "doc-conflict-1",
          conflict_state: "none",
          review_state: null,
        },
        error: null,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.meta?.verification?.post?.pass, true);
  assert.equal(result.meta?.verification?.post?.skipped, true);
  assert.equal(result.meta?.verification?.post?.reason, "no_mutation_required");
});

test("runMutation blocks learning-state update when durable db evidence is missing after execute", async () => {
  const canonicalRequest = buildUpdateLearningStateCanonicalRequest({
    docId: "doc-learning-update-1",
    actor: {
      accountId: "acct-1",
    },
    context: {
      confirmed: true,
      verifierCompleted: true,
    },
  });

  const result = await runMutation({
    action: "update_learning_state",
    payload: {
      doc_id: "doc-learning-update-1",
      status: "learned",
    },
    context: {
      account_id: "acct-1",
      pathname: "/agent/company-brain/learning/state",
      canonical_request: canonicalRequest,
      verifier_profile: "knowledge_write_v1",
      verifier_input: {
        account_id: "acct-1",
        doc_id: "doc-learning-update-1",
        expected_write: "learning_state",
      },
    },
    async execute() {
      return {
        success: true,
        data: {
          doc: {
            doc_id: "doc-learning-update-1",
          },
          learning_state: {
            status: "learned",
          },
        },
        error: null,
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "mutation_verifier_blocked");
  assert.equal(result.data?.verifier?.phase, "post");
  assert.equal(result.data?.verifier?.reason, "db_write_missing");
});
