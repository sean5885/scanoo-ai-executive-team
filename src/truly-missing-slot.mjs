import { cleanText } from "./message-intent-utils.mjs";

function toObject(value = null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function toArray(value = null) {
  return Array.isArray(value)
    ? value
    : [];
}

function uniqueStrings(values = []) {
  return Array.from(new Set(
    toArray(values)
      .map((value) => cleanText(value))
      .filter(Boolean),
  ));
}

function hasSlotInvalidMarker(slot = null) {
  const normalized = toObject(slot);
  if (!normalized) {
    return false;
  }
  if (
    normalized.invalid === true
    || normalized.is_invalid === true
    || normalized.invalidated === true
    || normalized.is_invalidated === true
  ) {
    return true;
  }
  const status = cleanText(normalized.status || "");
  if (status === "invalid") {
    return true;
  }
  const validityStatus = cleanText(normalized.validity_status || normalized.validity || "");
  return validityStatus === "invalid" || validityStatus === "invalidated";
}

function isSlotTtlExpired(ttl = "", nowMs = Date.now()) {
  const normalized = cleanText(ttl || "");
  if (!normalized) {
    return false;
  }
  const expiresAt = Date.parse(normalized);
  if (!Number.isFinite(expiresAt)) {
    return true;
  }
  return expiresAt <= nowMs;
}

export function isSlotActuallyMissing(slot = null, {
  now_ms = Date.now(),
} = {}) {
  const normalized = toObject(slot);
  if (!normalized) {
    return true;
  }
  const status = cleanText(normalized.status || "");
  if (status !== "filled") {
    return true;
  }
  if (hasSlotInvalidMarker(normalized)) {
    return true;
  }
  if (isSlotTtlExpired(normalized.ttl || "", now_ms)) {
    return true;
  }
  return false;
}

function normalizeRequiredSlotKeys(requiredSlots = null) {
  if (requiredSlots === null || requiredSlots === undefined) {
    return {
      slots: [],
      malformed: false,
    };
  }
  if (!Array.isArray(requiredSlots)) {
    return {
      slots: [],
      malformed: true,
    };
  }
  const normalizedSlots = [];
  let malformed = false;
  for (const slot of requiredSlots) {
    const slotKey = typeof slot === "string"
      ? cleanText(slot)
      : cleanText(slot?.slot_key || "");
    if (!slotKey) {
      malformed = true;
      continue;
    }
    normalizedSlots.push(slotKey);
  }
  return {
    slots: uniqueStrings(normalizedSlots),
    malformed,
  };
}

function buildSlotStateMap(slotState = null) {
  if (slotState === null || slotState === undefined) {
    return {
      map: new Map(),
      malformed: false,
    };
  }
  if (!Array.isArray(slotState)) {
    return {
      map: new Map(),
      malformed: true,
    };
  }
  const map = new Map();
  let malformed = false;
  for (const slot of slotState) {
    const slotObject = toObject(slot);
    if (!slotObject) {
      malformed = true;
      continue;
    }
    const slotKey = cleanText(slotObject.slot_key || "");
    if (!slotKey) {
      malformed = true;
      continue;
    }
    map.set(slotKey, slotObject);
  }
  return {
    map,
    malformed,
  };
}

export function hasAnyTrulyMissingRequiredSlot({
  required_slots = [],
  slot_state = [],
  unresolved_slots = [],
  now_ms = Date.now(),
} = {}) {
  const requiredSlotsResult = normalizeRequiredSlotKeys(required_slots);
  const unresolvedSlotsResult = normalizeRequiredSlotKeys(unresolved_slots);
  const slotStateResult = buildSlotStateMap(slot_state);
  const requiredSlotKeys = uniqueStrings([
    ...requiredSlotsResult.slots,
    ...unresolvedSlotsResult.slots,
  ]);
  const trulyMissingSlots = [];
  const filledSlotKeys = [];
  for (const slotKey of requiredSlotKeys) {
    const slotEntry = slotStateResult.map.get(slotKey) || null;
    if (isSlotActuallyMissing(slotEntry, { now_ms })) {
      trulyMissingSlots.push(slotKey);
    } else {
      filledSlotKeys.push(slotKey);
    }
  }
  const malformedInput = requiredSlotsResult.malformed
    || unresolvedSlotsResult.malformed
    || slotStateResult.malformed;
  return {
    required_slots: requiredSlotKeys,
    truly_missing_slots: trulyMissingSlots,
    filled_slot_keys: filledSlotKeys,
    has_any_truly_missing_required_slot: trulyMissingSlots.length > 0,
    all_required_slots_filled: requiredSlotKeys.length > 0 && trulyMissingSlots.length === 0,
    malformed_input: malformedInput,
  };
}

