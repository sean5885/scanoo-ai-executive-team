import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateMutationVerifierCoverage,
  getRequiredMutationVerifierProfile,
  runMutationVerification,
} from "../src/mutation-verifier.mjs";

test("mutation verifier coverage declares required profile for high-risk knowledge writes", () => {
  const required = getRequiredMutationVerifierProfile({
    action_type: "company_brain_apply",
  });
  const notRequired = getRequiredMutationVerifierProfile({
    action_type: "meeting_confirm_write",
  });

  assert.equal(required, "knowledge_write_v1");
  assert.equal(notRequired, null);
});

test("mutation verifier coverage blocks missing profile on required actions", () => {
  const coverage = evaluateMutationVerifierCoverage({
    phase: "pre",
    profile: "",
    canonicalRequest: {
      action_type: "ingest_learning_doc",
    },
  });

  assert.equal(coverage?.pass, false);
  assert.equal(coverage?.reason, "verifier_profile_required");
  assert.match((coverage?.issues || []).join(" "), /missing_verifier_profile/);
});

test("mutation verifier coverage blocks profile mismatch on required actions", () => {
  const coverage = runMutationVerification({
    phase: "pre",
    profile: "cloud_doc_v1",
    canonicalRequest: {
      action_type: "company_brain_apply",
    },
    verifierInput: {
      account_id: "acct-1",
      doc_id: "doc-1",
      expected_write: "approved_knowledge",
    },
  });

  assert.equal(coverage?.pass, false);
  assert.equal(coverage?.reason, "verifier_profile_mismatch");
});

test("mutation verifier keeps non-required actions profile-optional", () => {
  const coverage = runMutationVerification({
    phase: "pre",
    profile: "",
    canonicalRequest: {
      action_type: "meeting_confirm_write",
    },
  });

  assert.equal(coverage, null);
});
