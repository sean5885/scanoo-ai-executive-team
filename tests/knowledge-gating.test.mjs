import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createImprovementProposal, stageImprovementProposal } from "../src/executive-improvement.mjs";
import { approve, listPendingProposals, reject } from "../src/knowledge/approve.mjs";

async function createKnowledgeDirs() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "playground-knowledge-gating-"));
  const pendingDir = path.join(rootDir, "pending");
  const approvedDir = path.join(rootDir, "approved");
  await fs.mkdir(pendingDir, { recursive: true });
  await fs.mkdir(approvedDir, { recursive: true });
  return { rootDir, pendingDir, approvedDir };
}

test("knowledge gating writes improvement proposals into pending", async () => {
  const { pendingDir } = await createKnowledgeDirs();
  const reflection = {
    what_went_wrong: ["missing_info"],
    missing_elements: ["verified owner"],
    verification_result: {
      pass: false,
      issues: ["insufficient_evidence"],
    },
    error_type: "business_error",
  };

  const proposal = createImprovementProposal(reflection);
  const staged = await stageImprovementProposal({
    improvement_proposal: proposal,
    reflection_result: reflection,
    pending_dir: pendingDir,
  });

  assert.equal(typeof staged?.id, "string");
  assert.equal(staged.type, "knowledge_gap");
  assert.equal(staged.summary, proposal.summary);
  assert.equal(staged.action_suggestion, proposal.action_suggestion);
  assert.equal(typeof staged.created_at, "string");
  assert.equal(Number.isFinite(staged.confidence), true);

  const pendingFiles = await fs.readdir(pendingDir);
  assert.deepEqual(pendingFiles, [`${staged.id}.json`]);

  const stored = JSON.parse(await fs.readFile(path.join(pendingDir, pendingFiles[0]), "utf8"));
  assert.deepEqual(stored, staged);

  const pendingList = await listPendingProposals({ pending_dir: pendingDir });
  assert.equal(pendingList.length, 1);
  assert.deepEqual(pendingList[0], staged);
});

test("knowledge gating approve moves proposal file into approved", async () => {
  const { pendingDir, approvedDir } = await createKnowledgeDirs();
  const staged = await stageImprovementProposal({
    improvement_proposal: {
      type: "prompt_fix",
      summary: "Tighten response contract.",
      action_suggestion: "Keep the reply grounded and contract-safe.",
    },
    reflection_result: {
      what_went_wrong: ["overclaim"],
      verification_result: { pass: false, issues: ["overclaim"] },
      error_type: "contract_violation",
    },
    pending_dir: pendingDir,
  });

  const pendingPath = path.join(pendingDir, `${staged.id}.json`);
  const approvedPath = path.join(approvedDir, `${staged.id}.json`);

  const result = await approve(staged.id, {
    pending_dir: pendingDir,
    approved_dir: approvedDir,
  });

  assert.equal(result.ok, true);
  assert.equal(result.id, staged.id);
  assert.deepEqual(result.proposal, staged);
  assert.equal(await fs.access(pendingPath).then(() => true).catch(() => false), false);
  assert.equal(await fs.access(approvedPath).then(() => true).catch(() => false), true);

  const storedApproved = JSON.parse(await fs.readFile(approvedPath, "utf8"));
  assert.deepEqual(storedApproved, staged);
});

test("knowledge gating reject removes pending proposal file", async () => {
  const { pendingDir, approvedDir } = await createKnowledgeDirs();
  const staged = await stageImprovementProposal({
    improvement_proposal: {
      type: "retry_strategy",
      summary: "Add a bounded retry path.",
      action_suggestion: "Retry the failing dependency with explicit stop conditions.",
    },
    reflection_result: {
      what_went_wrong: ["tool_failure"],
      verification_result: { pass: false, issues: ["tool_failure"] },
      error_type: "tool_error",
    },
    pending_dir: pendingDir,
  });

  const pendingPath = path.join(pendingDir, `${staged.id}.json`);
  const approvedPath = path.join(approvedDir, `${staged.id}.json`);

  const result = await reject(staged.id, {
    pending_dir: pendingDir,
  });

  assert.equal(result.ok, true);
  assert.equal(result.id, staged.id);
  assert.deepEqual(result.proposal, staged);
  assert.equal(await fs.access(pendingPath).then(() => true).catch(() => false), false);
  assert.equal(await fs.access(approvedPath).then(() => true).catch(() => false), false);
  assert.deepEqual(await listPendingProposals({ pending_dir: pendingDir }), []);
});
