import test from "node:test";
import assert from "node:assert/strict";

import { classifyInputModality, extractPdfInputs } from "../src/modality-router.mjs";

test("extractPdfInputs picks PDF file token from attachment payload", () => {
  const refs = extractPdfInputs({
    message: {
      msg_type: "file",
      content: JSON.stringify({
        attachments: [
          {
            file_token: "file_token_pdf_1",
            name: "ops-checklist.pdf",
            mime_type: "application/pdf",
            ext: "pdf",
          },
        ],
      }),
    },
  });

  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, "lark_file_token");
  assert.equal(refs[0].value, "file_token_pdf_1");
});

test("classifyInputModality returns pdf for pure PDF input", () => {
  const result = classifyInputModality({
    message: {
      msg_type: "file",
      content: JSON.stringify({
        attachments: [
          {
            file_token: "file_token_pdf_2",
            name: "design-review.pdf",
            mime_type: "application/pdf",
            ext: "pdf",
          },
        ],
      }),
    },
  });

  assert.equal(result.modality, "pdf");
  assert.equal(result.pdfInputs.length, 1);
});

test("classifyInputModality returns pdf_multimodal when PDF and text coexist", () => {
  const result = classifyInputModality({
    text: "幫我整理這份 PDF 的重點",
    message: {
      msg_type: "file",
      content: JSON.stringify({
        attachments: [
          {
            file_key: "file_key_pdf_3",
            name: "handover.pdf",
            mime_type: "application/pdf",
            ext: "pdf",
          },
        ],
      }),
    },
  });

  assert.equal(result.modality, "pdf_multimodal");
  assert.equal(result.pdfInputs.length, 1);
  assert.equal(result.imageInputs.length, 0);
});

