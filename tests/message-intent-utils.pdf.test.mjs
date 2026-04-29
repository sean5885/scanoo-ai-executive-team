import test from "node:test";
import assert from "node:assert/strict";

import { extractAttachmentObjects } from "../src/message-intent-utils.mjs";

test("extractAttachmentObjects extracts file_key/file_token/name/mime/ext from structured attachments", () => {
  const event = {
    message: {
      content: JSON.stringify({
        attachments: [
          {
            file_key: "file_key_pdf_1",
            file_token: "file_token_pdf_1",
            name: "spec-v1.pdf",
            mime_type: "application/pdf",
            ext: "pdf",
          },
        ],
      }),
    },
  };

  assert.deepEqual(extractAttachmentObjects(event), [
    {
      file_key: "file_key_pdf_1",
      file_token: "file_token_pdf_1",
      name: "spec-v1.pdf",
      mime: "application/pdf",
      ext: "pdf",
    },
  ]);
});

