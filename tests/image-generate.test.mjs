import test from "node:test";
import assert from "node:assert/strict";

import { image_generate } from "../src/skills/image-generate-skill.mjs";

test("image generate returns url", async () => {
  const result = await image_generate({ input: "cat" });

  assert.equal(result.ok, true);
  assert.equal(result.output.prompt, "cat");
  assert.equal(result.output.url, "https://dummyimage.com/512x512/000/fff.png&text=cat");
});
