import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const [
  {
    DOCUMENT_FETCH_ERROR_TYPES,
    fetchDocumentPlainText,
    normalizeDocumentFetchFailure,
    resolveDocumentFetchInput,
  },
  {
    planUserInputAction,
    runPlannerMultiStep,
  },
] = await Promise.all([
  import("../src/skills/document-fetch.mjs"),
  import("../src/executive-planner.mjs"),
]);

test.after(() => {
  testDb.close();
});

test("resolveDocumentFetchInput prefers explicit document_id and falls back to raw card extraction", () => {
  assert.deepEqual(resolveDocumentFetchInput({
    document_id: "doccnExplicit123",
    raw_card: {
      document_id: "doccnCard456",
    },
  }), {
    document_id: "doccnExplicit123",
    auth: null,
    raw_card: {
      document_id: "doccnCard456",
    },
  });

  assert.deepEqual(resolveDocumentFetchInput({
    raw_card: "{\"document_id\":\"doccnCardOnly789\"}",
  }), {
    document_id: "doccnCardOnly789",
    auth: null,
    raw_card: "{\"document_id\":\"doccnCardOnly789\"}",
  });
});

test("fetchDocumentPlainText returns plain text content for a valid document_id", async () => {
  const authCalls = [];
  const fetchCalls = [];
  const result = await fetchDocumentPlainText({
    document_id: "doccnFetchSkill123",
    auth: {
      access_token: "token_123",
    },
  }, {
    async resolveAuth(auth) {
      authCalls.push(auth);
      return {
        accessToken: auth.access_token,
      };
    },
    async fetchPlainText(accessToken, documentId) {
      fetchCalls.push({ accessToken, documentId });
      return "hello plain text";
    },
  });

  assert.deepEqual(authCalls, [{
    access_token: "token_123",
  }]);
  assert.deepEqual(fetchCalls, [{
    accessToken: "token_123",
    documentId: "doccnFetchSkill123",
  }]);
  assert.deepEqual(result, {
    ok: true,
    document_id: "doccnFetchSkill123",
    content: "hello plain text",
  });
});

test("valid document loads content through fetch_document executor step", async () => {
  const result = await runPlannerMultiStep({
    steps: [
      {
        action: "fetch_document",
        params: {
          doc_id: "doccnValidCase123",
        },
      },
    ],
    logger: console,
    requestText: "請讀這個 document_id: doccnValidCase123",
    async documentFetcher(input) {
      return fetchDocumentPlainText(input, {
        async resolveAuth() {
          return {
            accessToken: "token_for_test",
          };
        },
        async fetchPlainText() {
          return "loaded content";
        },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.execution_context, {
    document: {
      document_id: "doccnValidCase123",
      title: "",
      content: "loaded content",
      fetched: true,
    },
  });
  assert.deepEqual(result.results[0], {
    ok: true,
    action: "fetch_document",
    data: {
      document_id: "doccnValidCase123",
      title: "",
      content: "loaded content",
      fetched: true,
    },
    trace_id: null,
  });
});

test("fetchDocumentPlainText extracts document_id from raw card", async () => {
  const result = await fetchDocumentPlainText({
    raw_card: {
      message_type: "doc",
      metadata: {
        document_id: "doccnFromCard123",
      },
    },
    auth: "token_from_card",
  }, {
    async resolveAuth(auth) {
      return {
        accessToken: auth,
      };
    },
    async fetchPlainText() {
      return "card content";
    },
  });

  assert.deepEqual(result, {
    ok: true,
    document_id: "doccnFromCard123",
    content: "card content",
  });
});

test("fetchDocumentPlainText returns not_found for invalid document_id", async () => {
  const result = await fetchDocumentPlainText({
    document_id: "bad",
  }, {
    async resolveAuth() {
      throw new Error("should_not_be_called");
    },
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      type: DOCUMENT_FETCH_ERROR_TYPES.NOT_FOUND,
      document_id: "bad",
      message: "invalid_document_id",
    },
  });
});

test("fetchDocumentPlainText returns missing_access_token when auth is missing", async () => {
  const result = await fetchDocumentPlainText({
    document_id: "doccnNoToken123",
  }, {
    async resolveAuth() {
      throw new Error("missing_access_token");
    },
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      type: DOCUMENT_FETCH_ERROR_TYPES.MISSING_ACCESS_TOKEN,
      document_id: "doccnNoToken123",
      message: "missing_access_token",
    },
  });
});

test("invalid document_id fail_closes fetch_document execution", async () => {
  const result = await runPlannerMultiStep({
    steps: [
      {
        action: "fetch_document",
        params: {
          doc_id: "bad",
        },
      },
    ],
    logger: console,
    requestText: "請讀這個 document_id: bad",
    async documentFetcher(input) {
      return fetchDocumentPlainText(input, {
        async resolveAuth() {
          throw new Error("should_not_be_called");
        },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "fail_closed");
  assert.equal(result.stopped, true);
  assert.equal(result.last_error?.error, "fail_closed");
  assert.equal(result.last_error?.data?.reason, "not_found");
  assert.equal(result.last_error?.data?.failure_mode, "fail_closed");
});

test("missing token fail_closes fetch_document execution", async () => {
  const result = await runPlannerMultiStep({
    steps: [
      {
        action: "fetch_document",
        params: {
          doc_id: "doccnMissingToken456",
        },
      },
    ],
    logger: console,
    requestText: "請讀這個 document_id: doccnMissingToken456",
    async documentFetcher(input) {
      return fetchDocumentPlainText(input, {
        async resolveAuth() {
          throw new Error("missing_access_token");
        },
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "fail_closed");
  assert.equal(result.stopped, true);
  assert.equal(result.last_error?.error, "fail_closed");
  assert.equal(result.last_error?.data?.reason, "missing_access_token");
  assert.equal(result.last_error?.data?.failure_mode, "fail_closed");
});

test("fetchDocumentPlainText returns permission_denied when upstream read is forbidden", async () => {
  const result = await fetchDocumentPlainText({
    document_id: "doccnForbidden123",
    auth: "token_forbidden",
  }, {
    async resolveAuth(auth) {
      return {
        accessToken: auth,
      };
    },
    async fetchPlainText() {
      const error = new Error("permission denied");
      error.status = 403;
      throw error;
    },
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      type: DOCUMENT_FETCH_ERROR_TYPES.PERMISSION_DENIED,
      document_id: "doccnForbidden123",
      message: "permission denied",
    },
  });
});

test("normalizeDocumentFetchFailure maps missing and not-found failures into bounded types", () => {
  assert.deepEqual(
    normalizeDocumentFetchFailure(new Error("missing_user_access_token"), {
      documentId: "doccnType123",
    }),
    {
      ok: false,
      error: {
        type: DOCUMENT_FETCH_ERROR_TYPES.MISSING_ACCESS_TOKEN,
        document_id: "doccnType123",
        message: "missing_user_access_token",
      },
    },
  );

  const notFoundError = new Error("document not found");
  notFoundError.status = 404;
  assert.deepEqual(
    normalizeDocumentFetchFailure(notFoundError, {
      documentId: "doccnType456",
    }),
    {
      ok: false,
      error: {
        type: DOCUMENT_FETCH_ERROR_TYPES.NOT_FOUND,
        document_id: "doccnType456",
        message: "document not found",
      },
    },
  );
});

test("planner inserts fetch_document step before referenced document detail", async () => {
  const decision = await planUserInputAction({
    text: "請直接讀這個 document_id: doccnPlannerInsert123",
    async requester() {
      return JSON.stringify({
        action: "get_company_brain_doc_detail",
        params: {},
      });
    },
  });

  assert.deepEqual(decision.steps, [
    {
      action: "fetch_document",
      intent: "retrieve document content before reasoning",
      required: true,
    },
    {
      action: "get_company_brain_doc_detail",
      params: {
        doc_id: "doccnPlannerInsert123",
      },
    },
  ]);
});
