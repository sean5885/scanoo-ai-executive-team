import test from "node:test";
import assert from "node:assert/strict";
import { createTestDbHarness } from "./utils/test-db-factory.mjs";

const testDb = await createTestDbHarness();
const { analyzeImageTask, buildStructuredImageContext } = await import("../src/image-understanding-service.mjs");

test.after(() => {
  testDb.close();
});

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

    if (String(url).includes("/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: "這是一張白板與會議截圖，主題是 OKR。",
                  limitations: ["依目前已抽取的結構化結果整理。"],
                }),
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
    assert.equal(calls[0].url, "https://example.com/test.png");
    assert.match(calls[1].url, /models\/.+:generateContent$/);
    if (calls[2]) {
      assert.match(calls[2].url, /\/chat\/completions$/);
      assert.equal(result.text_summary, "這是一張白板與會議截圖，主題是 OKR。");
      assert.deepEqual(result.synthesis_limitations, ["依目前已抽取的結構化結果整理。"]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analyzeImageTask fails soft when image input cannot be fetched", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    if (String(url) === "https://example.com/missing.png") {
      return new Response("not found", { status: 404 });
    }
    throw new Error("unexpected_call");
  };

  try {
    const result = await analyzeImageTask({
      task: "請辨識這張圖",
      imageInputs: [{ kind: "url", value: "https://example.com/missing.png" }],
    });

    assert.equal(result.ok, false);
    assert.match(result.reason || "", /image_input_unavailable:image_fetch_failed:404/);
    assert.equal(result.image_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analyzeImageTask downloads Lark message images through message resource when messageId is available", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/open-apis/im/v1/messages/om_test_image_1/resources/img_v3_test_key?type=image")) {
      return new Response(Buffer.from("fake-image"), {
        status: 200,
        headers: {
          "content-type": "image/png",
        },
      });
    }

    assert.match(String(url), /models\/.+:generateContent$/);
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    detected_objects: ["slide"],
                    scene_summary: "簡報截圖",
                    visible_text: "Growth",
                    key_entities: ["Growth"],
                    confidence: 0.88,
                    extracted_notes: ["主要講成長路徑"],
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
      task: "幫我看一下主要講的是什麼",
      imageInputs: [{ kind: "lark_image_key", value: "img_v3_test_key" }],
      accessToken: "u_test_access_token",
      tokenType: "user",
      messageId: "om_test_image_1",
    });

    assert.equal(result.ok, true);
    assert.equal(result.scene_summary, "簡報截圖");
    assert.match(calls[0].url, /\/messages\/om_test_image_1\/resources\/img_v3_test_key\?type=image$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
