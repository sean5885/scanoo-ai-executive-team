import test from "node:test";
import assert from "node:assert/strict";

import { readOfficeInputs, readOfficeTaskAndBuildReply } from "../src/office-file-read-service.mjs";

test("readOfficeInputs ignores unsupported file_name kind and returns input_missing when no readable refs", async () => {
  let resolveCalls = 0;
  const result = await readOfficeInputs({
    officeInputs: [
      {
        kind: "file_name",
        value: "Scanoo_珍煮丹_KA_升級版簡報.pptx",
      },
    ],
    resolveOfficeBufferFromInputFn: async () => {
      resolveCalls += 1;
      return { buffer: Buffer.from(""), source: {} };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "office_input_missing");
  assert.equal(resolveCalls, 0);
});

test("readOfficeInputs prioritizes message file_key ahead of file_token/url when maxFiles is bounded", async () => {
  const calledKinds = [];
  const result = await readOfficeInputs({
    maxFiles: 1,
    officeInputs: [
      { kind: "url", value: "https://example.com/ops-deck.pptx", name: "ops-deck.pptx", ext: "pptx", fileKind: "presentation" },
      { kind: "lark_file_token", value: "file_v3_token_ok", name: "ops-deck.pptx", ext: "pptx", fileKind: "presentation" },
      { kind: "lark_file_key", value: "file_v3_key_ok", name: "ops-deck.pptx", ext: "pptx", fileKind: "presentation" },
    ],
    resolveOfficeBufferFromInputFn: async (input) => {
      calledKinds.push(input.kind);
      return {
        buffer: Buffer.from("dummy office bytes"),
        source: {
          source_type: "lark_drive",
          source_id: input.value,
          source_label: input.name || input.value,
        },
      };
    },
    extractOfficeFileFromBufferFn: async (_buffer, options) => ({
      text: `第 1 頁：營運簡報重點。 (${options.fileKind})`,
      metadata: { file_kind: options.fileKind },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(calledKinds.length, 1);
  assert.equal(calledKinds[0], "lark_file_key");
  assert.equal(result.files.length, 1);
});

test("readOfficeInputs passes messageId to resolver for file_key style inputs", async () => {
  const resolverCalls = [];
  const result = await readOfficeInputs({
    maxFiles: 1,
    messageId: "om_test_message_001",
    officeInputs: [
      { kind: "file_key", value: "file_v3_test_key", name: "ops-sheet.xlsx", ext: "xlsx", fileKind: "spreadsheet" },
    ],
    resolveOfficeBufferFromInputFn: async (input, options) => {
      resolverCalls.push({ input, options });
      return {
        buffer: Buffer.from("dummy office bytes"),
        source: {
          source_type: "lark_message_resource",
          source_id: input.value,
          source_label: input.name || input.value,
        },
      };
    },
    extractOfficeFileFromBufferFn: async () => ({
      text: "工作表：Pricing\n方案 | 金額",
      metadata: { file_kind: "spreadsheet" },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].options.messageId, "om_test_message_001");
});

test("readOfficeInputs converts 234009 permission chain into bounded scope guidance", async () => {
  const result = await readOfficeInputs({
    maxFiles: 1,
    messageId: "om_test_message_234009",
    officeInputs: [
      { kind: "file_key", value: "file_v3_need_scope", name: "scope-check.docx", ext: "docx", fileKind: "document" },
    ],
    resolveOfficeBufferFromInputFn: async () => {
      throw new Error("message_file_resource_fetch_failed:status=400:code=234009:msg=Lack of necessary permissions, need scope im:message.p2p_msg:get_as_user");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "office_read_failed");
  assert.match(result.limitations[0], /缺少訊息附件讀取權限/);
});

test("readOfficeTaskAndBuildReply uses model-backed interpretation when question and model are available", async () => {
  let generateCalls = 0;
  const result = await readOfficeTaskAndBuildReply({
    officeInputs: [
      { kind: "local_path", value: "/tmp/demo.xlsx", name: "媒體聯播價格表.xlsx", ext: "xlsx", fileKind: "spreadsheet" },
    ],
    question: "告訴我這是什麼",
    allowModelInterpretation: true,
    resolveOfficeBufferFromInputFn: async (input) => ({
      buffer: Buffer.from("dummy office bytes"),
      source: {
        source_type: "local_path",
        source_id: input.value,
        source_label: input.name,
      },
    }),
    extractOfficeFileFromBufferFn: async () => ({
      text: "工作表：Pricing\n方案 | 單價 | 備註\n聯播方案 | 20000 | 含 banner",
      metadata: { file_kind: "spreadsheet" },
    }),
    generateTextFn: async () => {
      generateCalls += 1;
      return JSON.stringify({
        answer: "依目前已抽取片段，這是一份媒體聯播價格表，主要列出方案、單價與備註。",
        limitations: ["目前解讀仍只覆蓋已抽取文本，還不是逐工作表核對。"],
      });
    },
  });

  assert.equal(generateCalls, 1);
  assert.equal(result.model_interpretation.status, "used_model");
  assert.match(result.answer, /媒體聯播價格表/);
  assert.equal(result.sources.length, 1);
});

test("readOfficeTaskAndBuildReply falls back honestly when model interpretation fails", async () => {
  const result = await readOfficeTaskAndBuildReply({
    officeInputs: [
      { kind: "local_path", value: "/tmp/demo.docx", name: "訪談摘要.docx", ext: "docx", fileKind: "document" },
    ],
    question: "幫我整理重點",
    allowModelInterpretation: true,
    resolveOfficeBufferFromInputFn: async (input) => ({
      buffer: Buffer.from("dummy office bytes"),
      source: {
        source_type: "local_path",
        source_id: input.value,
        source_label: input.name,
      },
    }),
    extractOfficeFileFromBufferFn: async () => ({
      text: "本文件為訪談摘要，涵蓋客戶痛點與下一步建議。",
      metadata: { file_kind: "document" },
    }),
    generateTextFn: async () => {
      throw new Error("provider_quota_exhausted");
    },
  });

  assert.equal(result.model_interpretation.status, "model_failed");
  assert.match(result.answer, /我已先讀取 1 份 Word 文件/);
  assert.match(result.limitations.join("\n"), /主模型解讀未完成/);
});

test("readOfficeTaskAndBuildReply guides validation questions toward extracted-text consistency instead of market truth", async () => {
  let capturedPrompt = "";
  const result = await readOfficeTaskAndBuildReply({
    officeInputs: [
      { kind: "local_path", value: "/tmp/demo.xlsx", name: "媒體聯播價格表.xlsx", ext: "xlsx", fileKind: "spreadsheet" },
    ],
    question: "幫我看一下這個內容是對的嗎",
    allowModelInterpretation: true,
    resolveOfficeBufferFromInputFn: async (input) => ({
      buffer: Buffer.from("dummy office bytes"),
      source: {
        source_type: "local_path",
        source_id: input.value,
        source_label: input.name,
      },
    }),
    extractOfficeFileFromBufferFn: async () => ({
      text: "工作表：Pricing\n方案 | 單價 | 備註\n聯播方案 | 20000 | 含 banner",
      metadata: { file_kind: "spreadsheet" },
    }),
    generateTextFn: async ({ prompt }) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        answer: "依目前已抽取片段，你前面整理成『媒體聯播價格表，列出方案、單價與備註』這個理解方向是對的。",
        limitations: ["仍只核對到目前抽取片段，還不是整份工作簿逐表覆核。"],
      });
    },
  });

  assert.match(capturedPrompt, /優先判斷.*與已抽取文本一致/);
  assert.match(result.answer, /理解方向是對的/);
  assert.equal(result.model_interpretation.status, "used_model");
});
