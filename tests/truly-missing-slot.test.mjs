import test from "node:test";
import assert from "node:assert/strict";

const {
  isSlotActuallyMissing,
  hasAnyTrulyMissingRequiredSlot,
} = await import("../src/truly-missing-slot.mjs");

test("isSlotActuallyMissing returns false for filled valid slot", () => {
  const missing = isSlotActuallyMissing({
    slot_key: "doc_id",
    status: "filled",
    ttl: "2099-01-01T00:00:00.000Z",
    invalid: false,
  });
  assert.equal(missing, false);
});

test("isSlotActuallyMissing treats invalid/expired/non-filled as missing", () => {
  assert.equal(isSlotActuallyMissing({ slot_key: "doc_id", status: "missing" }), true);
  assert.equal(isSlotActuallyMissing({ slot_key: "doc_id", status: "filled", ttl: "2000-01-01T00:00:00.000Z" }), true);
  assert.equal(isSlotActuallyMissing({ slot_key: "doc_id", status: "filled", invalid: true }), true);
});

test("hasAnyTrulyMissingRequiredSlot recognizes complete required slots", () => {
  const result = hasAnyTrulyMissingRequiredSlot({
    required_slots: ["doc_id"],
    unresolved_slots: ["doc_id"],
    slot_state: [
      {
        slot_key: "doc_id",
        status: "filled",
        ttl: "2099-01-01T00:00:00.000Z",
      },
    ],
  });
  assert.equal(result.has_any_truly_missing_required_slot, false);
  assert.deepEqual(result.truly_missing_slots, []);
  assert.equal(result.all_required_slots_filled, true);
});

test("hasAnyTrulyMissingRequiredSlot fails closed on malformed slot input", () => {
  const result = hasAnyTrulyMissingRequiredSlot({
    required_slots: ["doc_id"],
    slot_state: "bad-shape",
  });
  assert.equal(result.malformed_input, true);
  assert.equal(result.has_any_truly_missing_required_slot, true);
  assert.deepEqual(result.truly_missing_slots, ["doc_id"]);
});

