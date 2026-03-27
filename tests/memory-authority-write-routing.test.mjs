import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspaceDir = process.cwd();
const sessionScopeStoreUrl = pathToFileURL(path.join(workspaceDir, "src/session-scope-store.mjs")).href;
const executiveMemoryUrl = pathToFileURL(path.join(workspaceDir, "src/executive-memory.mjs")).href;
const authorityUrl = pathToFileURL(path.join(workspaceDir, "src/company-brain-memory-authority.mjs")).href;

function runScenario(script, envOverrides = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: workspaceDir,
    encoding: "utf8",
    env: {
      ...process.env,
      LARK_APP_ID: process.env.LARK_APP_ID || "test-app-id",
      LARK_APP_SECRET: process.env.LARK_APP_SECRET || "test-app-secret",
      ...envOverrides,
    },
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `scenario exited with ${result.status}`);
  }

  return JSON.parse(result.stdout.trim());
}

test("session explicit auth writes authority first and keeps encrypted legacy mirror", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-memory-authority-"));
  const storePath = path.join(tempDir, "lark-session-scopes.json");
  const script = `
    const { setResolvedSessionExplicitAuth, getResolvedSessionExplicitAuth } = await import(${JSON.stringify(sessionScopeStoreUrl)});
    const authority = await import(${JSON.stringify(authorityUrl)});
    delete globalThis.__company_brain_memory__;

    const written = await setResolvedSessionExplicitAuth("session-test-1", {
      account_id: "acct-session-1",
      access_token: "token-session-1",
      source: "event_user_access_token",
    });
    const memory = authority.readMemory({ key: "session_explicit_auth:session-test-1" });
    const fs = await import("node:fs/promises");
    const persisted = JSON.parse(await fs.readFile(${JSON.stringify(storePath)}, "utf8"));

    delete globalThis.__company_brain_memory__;
    const fallback = await getResolvedSessionExplicitAuth("session-test-1");

    console.log(JSON.stringify({
      written,
      memory,
      persistedToken: persisted.sessions["session-test-1"]?.explicit_auth?.access_token || null,
      fallback,
    }));
  `;

  const result = runScenario(script, {
    LARK_TOKEN_ENCRYPTION_SECRET: "memory-authority-secret",
    LARK_SESSION_SCOPE_STORE: storePath,
  });

  assert.equal(result.written?.access_token, "token-session-1");
  assert.equal(result.memory?.ok, true);
  assert.equal(result.memory?.data?.value?.access_token, "token-session-1");
  assert.equal(String(result.persistedToken).startsWith("enc:v1:"), true);
  assert.equal(result.fallback?.access_token, "token-session-1");
  assert.equal(result.fallback?.source, "event_user_access_token");
});

test("session explicit auth keeps authority write even when legacy mirror persistence fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-memory-authority-fail-"));
  const blockedPath = path.join(tempDir, "blocked-store");
  await fs.mkdir(blockedPath, { recursive: true });

  const script = `
    const sessionScopeStore = await import(${JSON.stringify(sessionScopeStoreUrl)});
    const authority = await import(${JSON.stringify(authorityUrl)});
    delete globalThis.__company_brain_memory__;

    let errorCode = null;
    try {
      await sessionScopeStore.setResolvedSessionExplicitAuth("session-test-fail", {
        account_id: "acct-session-fail",
        access_token: "token-session-fail",
        source: "event_user_access_token",
      });
    } catch (error) {
      errorCode = error?.code || error?.message || "unknown_error";
    }

    console.log(JSON.stringify({
      errorCode,
      memory: authority.readMemory({ key: "session_explicit_auth:session-test-fail" }),
    }));
  `;

  const result = runScenario(script, {
    LARK_TOKEN_ENCRYPTION_SECRET: "memory-authority-secret",
    LARK_SESSION_SCOPE_STORE: blockedPath,
  });

  assert.equal(result.errorCode, "EISDIR");
  assert.equal(result.memory?.ok, true);
  assert.equal(result.memory?.data?.value?.access_token, "token-session-fail");
});

test("executive split-brain writes reach authority before legacy json mirrors", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "executive-memory-authority-fail-"));
  const blockedSessionStore = path.join(tempDir, "blocked-session-store");
  const blockedProposalStore = path.join(tempDir, "blocked-proposal-store");
  await fs.mkdir(blockedSessionStore, { recursive: true });
  await fs.mkdir(blockedProposalStore, { recursive: true });

  const script = `
    const executiveMemory = await import(${JSON.stringify(executiveMemoryUrl)});
    const authority = await import(${JSON.stringify(authorityUrl)});
    delete globalThis.__company_brain_memory__;

    let sessionErrorCode = null;
    let proposalErrorCode = null;

    try {
      await executiveMemory.appendSessionMemory({
        id: "memory-priority-1",
        account_id: "acct-exec-1",
        session_key: "session-exec-1",
        task_id: "task-exec-1",
        title: "priority memory",
        content: "authority first",
      });
    } catch (error) {
      sessionErrorCode = error?.code || error?.message || "unknown_error";
    }

    try {
      await executiveMemory.createPendingKnowledgeProposal({
        id: "proposal-priority-1",
        account_id: "acct-exec-1",
        session_key: "session-exec-1",
        task_id: "task-exec-1",
        title: "priority proposal",
        content: "authority first",
      });
    } catch (error) {
      proposalErrorCode = error?.code || error?.message || "unknown_error";
    }

    console.log(JSON.stringify({
      sessionErrorCode,
      proposalErrorCode,
      sessionRows: authority.listMemoryByPrefix({ prefix: "executive_session_memory:" }),
      proposalRows: authority.listMemoryByPrefix({ prefix: "executive_pending_proposal:" }),
    }));
  `;

  const result = runScenario(script, {
    EXECUTIVE_SESSION_MEMORY_STORE: blockedSessionStore,
    EXECUTIVE_PENDING_PROPOSAL_STORE: blockedProposalStore,
  });

  assert.equal(result.sessionErrorCode, "EISDIR");
  assert.equal(result.proposalErrorCode, "EISDIR");
  assert.equal(result.sessionRows?.ok, true);
  assert.equal(result.proposalRows?.ok, true);
  assert.equal(
    result.sessionRows?.data?.some((row) => row.key === "executive_session_memory:memory-priority-1"),
    true,
  );
  assert.equal(
    result.proposalRows?.data?.some((row) => row.key === "executive_pending_proposal:proposal-priority-1"),
    true,
  );
});
