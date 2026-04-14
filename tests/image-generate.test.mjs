import test from "node:test";
import assert from "node:assert/strict";

import { image_generate } from "../src/skills/image-generate-skill.mjs";

test("image generate fail-closes when backend is unavailable", async () => {
  const result = await image_generate({ input: "cat" });

  assert.equal(result.ok, false);
  assert.equal(result.error, "business_error");
  assert.equal(result.details?.phase, "execution");
  assert.equal(result.details?.failure_class, "capability_gap");
  assert.equal(result.details?.reason, "image_backend_unavailable");
  assert.equal(result.details?.prompt, "cat");
});
