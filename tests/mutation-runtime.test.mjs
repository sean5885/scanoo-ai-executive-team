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
        journal: {
          action: "create_doc",
          status: "success",
          started_at: 1000,
        },
      },
    });
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
    assert.deepEqual(result, {
      ok: true,
      action: "create_doc",
      result: {
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
      },
    });
  } finally {
    Date.now = originalNow;
  }
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
    assert.deepEqual(firstResult, {
      ok: true,
      action: "create_doc",
      result: {
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
      },
    });
    assert.deepEqual(secondResult, firstResult);
  } finally {
    Date.now = originalNow;
    delete globalThis.__mutation_idempotency_store__;
  }
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

  assert.deepEqual(secondResult, {
    ok: false,
    error: "idempotency_in_progress",
  });

  releaseExecution();
  const firstResult = await firstRun;

  assert.equal(firstResult.ok, true);
  assert.equal(
    globalThis.__mutation_idempotency_store__.get(context.idempotency_key).__status,
    "done",
  );

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
  assert.equal(
    globalThis.__mutation_idempotency_store__?.has(context.idempotency_key),
    false,
  );

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

    assert.deepEqual(result, {
      ok: false,
      action: "create_doc",
      error: "execution_failed",
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
    });
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
    assert.deepEqual(result, {
      ok: false,
      action: "create_doc",
      error: "execution_failed",
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
    });
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

    assert.deepEqual(result, {
      ok: false,
      action: "create_doc",
      error: "execution_failed",
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
    });
  } finally {
    Date.now = originalNow;
  }
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
  assert.equal(result.write_guard?.reason, "confirmation_required");
  assert.equal(result.admission?.allowed, false);
  assert.equal(result.message, "External write requires explicit confirmation before apply.");
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
  assert.equal(result.verifier?.phase, "pre");
  assert.equal(result.verifier?.reason, "missing_preview_plan");
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
  assert.equal(result.verifier?.phase, "post");
  assert.equal(result.verifier?.reason, "insufficient_evidence");
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
  assert.equal(result.verifier?.phase, "pre");
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
  assert.equal(result.verifier?.phase, "post");
  assert.equal(result.verifier?.reason, "db_write_missing");
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
  assert.equal(result.verifier?.phase, "post");
  assert.equal(result.verifier?.reason, "db_write_missing");
});
