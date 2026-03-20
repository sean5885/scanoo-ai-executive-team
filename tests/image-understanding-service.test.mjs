import test from "node:test";
import assert from "node:assert/strict";

import { analyzeImageTask, buildStructuredImageContext } from "../src/image-understanding-service.mjs";

test("buildStructuredImageContext compacts structured image result", () => {
  const context = buildStructuredImageContext({
    scene_summary: "白板上有本週 OKR 與數個待辦。",
    visible_text: "KR1 KR2 TODO",
    detected_objects: ["whiteboard", "sticky notes", "people"],
    key_entities: ["OKR", "KR1", "KR2"],
    extracted_notes: ["本週完成付款頁修復", "下週跟進轉化率"],
    confidence: 0.92,
  });

  assert.match(context, /scene_summary/);
  assert.match(context, /visible_text/);
  assert.match(context, /detected_objects/);
  assert.match(context, /confidence: 0.92/);
});

test("analyzeImageTask uses Gemini generateContent payload for nano banana", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://example.com/test.png") {
      return new Response(Buffer.from("fake-image"), {
        status: 200,
        headers: {
          "content-type": "image/png",
        },
      });
    }

    assert.match(String(url), /models\/.+:generateContent$/);
    assert.equal(options.headers["x-goog-api-key"].length > 0, true);
    const body = JSON.parse(options.body);
    assert.equal(Array.isArray(body.contents), true);
    assert.equal(body.generationConfig.temperature, 0.1);
    assert.equal(body.generationConfig.topP, 0.7);
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, "image/png");

    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    detected_objects: ["whiteboard"],
                    scene_summary: "白板與會議截圖",
                    visible_text: "OKR",
                    key_entities: ["OKR"],
                    confidence: 0.9,
                    extracted_notes: ["本週例會"],
                  }),
                },
              ],
            },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  };

  try {
    const result = await analyzeImageTask({
      task: "請辨識這張圖",
      imageInputs: [{ kind: "url", value: "https://example.com/test.png" }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider, "nano_banana");
    assert.equal(result.scene_summary, "白板與會議截圖");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
