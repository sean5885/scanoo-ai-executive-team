import test from "node:test";
import assert from "node:assert/strict";

import { classifyInputModality, extractImageInputs, looksLikeImageTask } from "../src/modality-router.mjs";

test("extractImageInputs picks image urls from structured payload", () => {
  const refs = extractImageInputs({
    message: {
      content: JSON.stringify({
        image_url: "https://example.com/board.png",
        text: "幫我看這張白板",
      }),
    },
  });

  assert.deepEqual(refs, [{ kind: "url", value: "https://example.com/board.png" }]);
});

test("classifyInputModality returns image for pure image input", () => {
  const result = classifyInputModality({
    message: {
      msg_type: "image",
      content: JSON.stringify({
        image_url: "https://example.com/photo.jpg",
      }),
    },
  });

  assert.equal(result.modality, "image");
  assert.equal(result.imageInputs.length, 1);
});

test("classifyInputModality returns multimodal when image and text coexist", () => {
  const result = classifyInputModality({
    text: "請幫我看這張截圖在講什麼",
    message: {
      content: JSON.stringify({
        image_url: "https://example.com/screenshot.png",
      }),
    },
  });

  assert.equal(result.modality, "multimodal");
  assert.equal(looksLikeImageTask(result.text), true);
});
