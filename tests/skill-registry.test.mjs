import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultSkillRegistry,
  getSkillMetadata,
  getSkillRegistryEntry,
  normalizeSkillArgs,
} from "../src/skill-registry.mjs";

test("skill registry entries expose hardened metadata fields", () => {
  const entries = Array.from(defaultSkillRegistry.entries());
  assert.equal(entries.length > 0, true);

  for (const [name, entry] of entries) {
    assert.equal(typeof name, "string");
    assert.equal(typeof entry.capability, "string");
    assert.equal(Array.isArray(entry.required_args), true);
    assert.equal(typeof entry.arg_aliases, "object");
    assert.equal(typeof entry.auth_requirements, "object");
    assert.equal(typeof entry.health, "object");
    assert.equal(typeof entry.fallback, "object");
    assert.equal(typeof entry.read_only, "boolean");

    const metadata = getSkillMetadata(name);
    assert.equal(metadata?.capability, entry.capability);
    assert.equal(Array.isArray(metadata?.required_args), true);
    assert.equal(typeof metadata?.arg_aliases, "object");
  }
});

test("getSkillRegistryEntry returns null for unknown skill", () => {
  assert.equal(getSkillRegistryEntry("unknown_skill"), null);
  assert.equal(getSkillMetadata("unknown_skill"), null);
});

test("normalizeSkillArgs maps query aliasing between query and q for search skill", () => {
  const fromLegacyQuery = normalizeSkillArgs("search_and_summarize", {
    account_id: "acct_registry",
    query: "launch checklist",
  });
  assert.equal(fromLegacyQuery.query, "launch checklist");
  assert.equal(fromLegacyQuery.q, "launch checklist");

  const fromCanonicalQ = normalizeSkillArgs("search_and_summarize", {
    account_id: "acct_registry",
    q: "delivery review",
  });
  assert.equal(fromCanonicalQ.q, "delivery review");
  assert.equal(fromCanonicalQ.query, "delivery review");
});

test("normalizeSkillArgs applies document aliases through registry metadata", () => {
  const normalized = normalizeSkillArgs("document_summarize", {
    accountId: "acct_doc_alias",
    document_id: "doc_alias_1",
  });

  assert.equal(normalized.account_id, "acct_doc_alias");
  assert.equal(normalized.doc_id, "doc_alias_1");
});
