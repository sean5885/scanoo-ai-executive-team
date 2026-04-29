import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const [
  { extract },
  {
    replaceDocumentChunks,
    saveToken,
    upsertAccount,
    upsertDocument,
    upsertSource,
  },
  { searchKnowledgeBaseByIndexAuthority },
  { chunkText },
  { nowIso, normalizeText, sha256 },
  { buildCanonicalAnswerSources },
] = await Promise.all([
  import("../src/pdf-extractor.mjs"),
  import("../src/rag-repository.mjs"),
  import("../src/index-read-authority.mjs"),
  import("../src/chunking.mjs"),
  import("../src/text-utils.mjs"),
  import("../src/answer-source-mapper.mjs"),
]);

test.after(() => {
  testDb.close();
});

function escapePdfText(text = "") {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function buildSyntheticPdfBytes(fixture = {}) {
  const pages = Number.isInteger(fixture?.pages) && fixture.pages > 0 ? fixture.pages : 1;
  const pageMarks = Array.from({ length: pages }).map((_, index) => `${index + 1} 0 obj << /Type /Page >> endobj`).join("\n");
  const text = String(fixture?.text || "");

  let streamBody = "";
  if (fixture?.template === "text_operator") {
    streamBody = `BT /F1 12 Tf 72 712 Td (${escapePdfText(text)}) Tj ET`;
  } else if (fixture?.template === "array_operator") {
    const words = text.split(/\s+/).filter(Boolean);
    const left = words.slice(0, Math.ceil(words.length / 2)).join(" ");
    const right = words.slice(Math.ceil(words.length / 2)).join(" ");
    streamBody = `BT /F1 12 Tf 72 712 Td [(${escapePdfText(left)}) 140 (${escapePdfText(right)})] TJ ET`;
  } else {
    streamBody = "";
  }

  const content = [
    "%PDF-1.4",
    pageMarks,
    "5 0 obj << /Length 2048 >> stream",
    streamBody,
    "endstream endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");

  return Buffer.from(content, "latin1");
}

function loadFixtures() {
  const fixturesDir = path.join(process.cwd(), "tests", "fixtures", "pdf-cases");
  const files = fs.readdirSync(fixturesDir).filter((file) => file.endsWith(".json")).sort();
  return files.map((file) => {
    const fullPath = path.join(fixturesDir, file);
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  });
}

test("pdf e2e corpus meets extraction/retrieval/citation threshold", async () => {
  const fixtures = loadFixtures();
  assert.ok(fixtures.length >= 50);

  const account = upsertAccount({
    open_id: "pdf-e2e-open-id",
    user_id: "pdf-e2e-user-id",
    union_id: "pdf-e2e-union-id",
    tenant_key: "pdf-e2e-tenant",
    name: "PDF E2E",
    email: "pdf-e2e@example.com",
  }, "docs:read");

  saveToken(account.id, {
    access_token: "pdf-e2e-access-token",
    refresh_token: "pdf-e2e-refresh-token",
    token_type: "Bearer",
    scope: "docs:read",
    expires_at: "2099-01-01T00:00:00.000Z",
    refresh_expires_at: "2099-01-01T00:00:00.000Z",
  });

  let passCount = 0;
  let extractPassCount = 0;
  let retrievalPassCount = 0;
  let citationPassCount = 0;

  for (const fixture of fixtures) {
    const bytes = buildSyntheticPdfBytes(fixture);
    const extraction = await extract({
      bytes,
      fileName: fixture.file_name,
      mimeType: fixture.mime_type,
    });

    const expectedSuccess = fixture.expect_extract_success === true;
    const extractedText = normalizeText(extraction?.text || "");
    const extractionPass = expectedSuccess
      ? Boolean(extractedText && extractedText.includes(normalizeText(fixture.expected_phrase || "")))
      : extractedText.length === 0;

    if (extractionPass) {
      extractPassCount += 1;
    }

    let retrievalPass = false;
    let citationPass = false;

    if (expectedSuccess && extractionPass) {
      const now = nowIso();
      const externalKey = `drive:${fixture.id}`;
      const source = upsertSource({
        account_id: account.id,
        source_type: "drive",
        external_key: externalKey,
        external_id: fixture.id,
        title: fixture.file_name,
        url: `https://example.invalid/${fixture.file_name}`,
        parent_external_key: null,
        parent_path: "/pdf-e2e",
        updated_at_remote: now,
        meta_json: {
          source_type: "pdf",
        },
      });

      const document = upsertDocument({
        account_id: account.id,
        source_id: source.id,
        source_type: "pdf",
        external_key: externalKey,
        external_id: fixture.id,
        file_token: fixture.id,
        node_id: null,
        document_id: fixture.id,
        space_id: null,
        title: fixture.file_name,
        url: `https://example.invalid/${fixture.file_name}`,
        parent_path: "/pdf-e2e",
        revision: now,
        updated_at_remote: now,
        content_hash: sha256(extractedText),
        raw_text: extractedText,
        meta_json: {
          source_type: "pdf",
          extractor_version: extraction?.extractor_version || "pdf-min-v1",
          page_count: Number.isInteger(extraction?.page_count) ? extraction.page_count : null,
        },
        active: 1,
        status: "indexed",
        indexed_at: now,
      });

      replaceDocumentChunks(document, chunkText(extractedText));

      const readResult = searchKnowledgeBaseByIndexAuthority(account.id, fixture.query, 5);
      const items = Array.isArray(readResult?.items) ? readResult.items : [];
      retrievalPass = items.some((item) => normalizeText(item?.snippet || "").includes(normalizeText(fixture.expected_phrase || "")));
      if (retrievalPass) {
        retrievalPassCount += 1;
      }

      const canonicalSources = buildCanonicalAnswerSources(items, { query: fixture.query });
      const itemIds = new Set(items.map((item) => item.id));
      citationPass = canonicalSources.some((sourceItem) => (
        itemIds.has(sourceItem.id)
        && normalizeText(sourceItem?.snippet || "").includes(normalizeText(fixture.expected_phrase || ""))
      ));
      if (citationPass) {
        citationPassCount += 1;
      }
    }

    if ((expectedSuccess && extractionPass && retrievalPass && citationPass) || (!expectedSuccess && extractionPass)) {
      passCount += 1;
    }
  }

  const total = fixtures.length;
  const passRate = Number((passCount / total).toFixed(4));

  assert.ok(total >= 50);
  assert.ok(passCount >= 45, `expected >=45 pass cases, got ${passCount}/${total}`);
  assert.ok(passRate >= 0.9, `expected >=0.9 pass rate, got ${passRate}`);
  assert.ok(extractPassCount >= 45, `expected extraction pass >=45, got ${extractPassCount}`);
  assert.ok(retrievalPassCount >= 45, `expected retrieval pass >=45, got ${retrievalPassCount}`);
  assert.ok(citationPassCount >= 45, `expected citation pass >=45, got ${citationPassCount}`);
});
