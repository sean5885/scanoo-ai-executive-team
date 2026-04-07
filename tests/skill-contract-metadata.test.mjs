import test from "node:test";
import assert from "node:assert/strict";

import { SKILL_CONTRACT as documentFetchContract } from "../src/skills/document-fetch.mjs";
import { SKILL_CONTRACT as documentSummarizeContract } from "../src/skills/document-summarize-skill.mjs";
import { SKILL_CONTRACT as searchAndSummarizeContract } from "../src/skills/search-and-summarize-skill.mjs";

function assertSkillContractShape(contract, {
  intentIncludes = "",
  successIncludes = "",
  failureIncludes = "",
} = {}) {
  assert.deepEqual(Object.keys(contract).sort(), [
    "failure_criteria",
    "intent",
    "success_criteria",
  ]);
  assert.equal(typeof contract.intent, "string");
  assert.equal(typeof contract.success_criteria, "string");
  assert.equal(typeof contract.failure_criteria, "string");
  assert.notEqual(contract.intent, "define intent");
  assert.notEqual(contract.success_criteria, "define success");
  assert.notEqual(contract.failure_criteria, "define failure");
  assert.match(contract.intent, new RegExp(intentIncludes, "i"));
  assert.match(contract.success_criteria, new RegExp(successIncludes, "i"));
  assert.match(contract.failure_criteria, new RegExp(failureIncludes, "i"));
}

test("checked-in skill modules export descriptive SKILL_CONTRACT metadata", () => {
  assertSkillContractShape(documentFetchContract, {
    intentIncludes: "document_id|raw Lark card",
    successIncludes: "document_id|content",
    failureIncludes: "missing_access_token|permission_denied|not_found",
  });

  assertSkillContractShape(documentSummarizeContract, {
    intentIncludes: "company-brain document detail",
    successIncludes: "doc_id|summary|sources",
    failureIncludes: "contract_violation|read-runtime",
  });

  assertSkillContractShape(searchAndSummarizeContract, {
    intentIncludes: "search company-brain knowledge|one query",
    successIncludes: "query|summary|sources",
    failureIncludes: "contract_violation|read-runtime search",
  });
});
