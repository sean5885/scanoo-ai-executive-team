import test from "node:test";
import assert from "node:assert/strict";

import { readPdfInputs } from "../src/pdf-read-service.mjs";

test("readPdfInputs ignores unsupported file_name kind and returns input_missing when no readable refs", async () => {
  let resolveCalls = 0;
  const result = await readPdfInputs({
    pdfInputs: [
      {
        kind: "file_name",
        value: "Scanoo_珍煮丹_KA_升級版簡報.pdf",
      },
    ],
    resolvePdfBufferFromInputFn: async () => {
      resolveCalls += 1;
      return { buffer: Buffer.from(""), source: {} };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "pdf_input_missing");
  assert.equal(resolveCalls, 0);
});

test("readPdfInputs prioritizes message file_key ahead of file_token/url when maxFiles is bounded", async () => {
  const calledKinds = [];
  const result = await readPdfInputs({
    maxFiles: 1,
    pdfInputs: [
      { kind: "file_name", value: "Scanoo_珍煮丹_KA_升級版簡報.pdf" },
      { kind: "url", value: "https://example.com/404.pdf" },
      { kind: "lark_file_token", value: "file_v3_token_ok", name: "Scanoo_珍煮丹_KA_升級版簡報.pdf" },
      { kind: "lark_file_key", value: "file_v3_key_ok", name: "Scanoo_珍煮丹_KA_升級版簡報.pdf" },
    ],
    resolvePdfBufferFromInputFn: async (input) => {
      calledKinds.push(input.kind);
      return {
        buffer: Buffer.from("dummy pdf bytes"),
        source: {
          source_type: "lark_drive",
          source_id: input.value,
          source_label: input.name || input.value,
        },
      };
    },
    extractPdfTextFromBufferFn: async () => ({
      text: "第一重點。第二重點。第三重點。",
      page_count: 3,
      metadata: null,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(calledKinds.length, 1);
  assert.equal(calledKinds[0], "lark_file_key");
  assert.equal(result.files.length, 1);
});

test("readPdfInputs passes messageId to resolver for file_key style inputs", async () => {
  const resolverCalls = [];
  const result = await readPdfInputs({
    maxFiles: 1,
    messageId: "om_test_message_001",
    pdfInputs: [
      { kind: "file_key", value: "file_v3_test_key", name: "demo.pdf" },
    ],
    resolvePdfBufferFromInputFn: async (input, options) => {
      resolverCalls.push({ input, options });
      return {
        buffer: Buffer.from("dummy pdf bytes"),
        source: {
          source_type: "lark_message_resource",
          source_id: input.value,
          source_label: input.name || input.value,
        },
      };
    },
    extractPdfTextFromBufferFn: async () => ({
      text: "測試重點一。測試重點二。",
      page_count: 2,
      metadata: null,
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].options.messageId, "om_test_message_001");
});

test("readPdfInputs converts 234009 permission chain into bounded scope guidance", async () => {
  const result = await readPdfInputs({
    maxFiles: 1,
    messageId: "om_test_message_234009",
    pdfInputs: [
      { kind: "file_key", value: "file_v3_need_scope", name: "scope-check.pdf" },
    ],
    resolvePdfBufferFromInputFn: async () => {
      throw new Error("message_file_resource_fetch_failed:status=400:code=234009:msg=Lack of necessary permissions, need scope im:message.p2p_msg:get_as_user");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "pdf_read_failed");
  assert.match(result.limitations[0], /缺少訊息附件讀取權限/);
  assert.doesNotMatch(result.limitations[0], /tenant_status=/);
});

test("readPdfInputs converts oversized download error into size-limit guidance", async () => {
  const result = await readPdfInputs({
    maxFiles: 1,
    maxBytes: 10 * 1024 * 1024,
    pdfInputs: [
      { kind: "url", value: "https://example.com/oversized.pdf", name: "oversized.pdf" },
    ],
    resolvePdfBufferFromInputFn: async () => {
      throw new Error("download_stream_too_large");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "pdf_read_failed");
  assert.match(result.limitations[0], /PDF 讀取上限/);
});

test("readPdfInputs converts message-resource 502 into upstream guidance", async () => {
  const result = await readPdfInputs({
    maxFiles: 1,
    messageId: "om_test_message_502",
    pdfInputs: [
      { kind: "file_key", value: "file_v3_upstream_502", name: "large-proposal.pdf" },
    ],
    resolvePdfBufferFromInputFn: async () => {
      throw new Error("message_file_resource_fetch_failed:status=502:attempt=3/3:msg=upstream connect error or disconnect/reset before headers");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "pdf_read_failed");
  assert.match(result.limitations[0], /回傳 502|upstream/);
});
