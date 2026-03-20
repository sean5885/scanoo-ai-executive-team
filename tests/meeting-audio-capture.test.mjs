import test from "node:test";
import assert from "node:assert/strict";

import {
  parseAvfoundationAudioDevices,
  resolveMeetingTranscribeProvider,
} from "../src/meeting-audio-capture.mjs";

test("parseAvfoundationAudioDevices extracts only microphone devices", () => {
  const devices = parseAvfoundationAudioDevices(`
[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] MacBook Air相機
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] iPhone麥克風
[AVFoundation indev @ 0x1] [1] MacBook Air的麥克風
  `);

  assert.deepEqual(devices, [
    { index: "0", name: "iPhone麥克風" },
    { index: "1", name: "MacBook Air的麥克風" },
  ]);
});

test("resolveMeetingTranscribeProvider defaults local aliases to faster_whisper", () => {
  assert.equal(resolveMeetingTranscribeProvider(), "faster_whisper");
  assert.equal(resolveMeetingTranscribeProvider("local"), "faster_whisper");
  assert.equal(resolveMeetingTranscribeProvider("faster-whisper"), "faster_whisper");
});

test("resolveMeetingTranscribeProvider keeps explicit openai-compatible mode", () => {
  assert.equal(resolveMeetingTranscribeProvider("openai-compatible"), "openai_compatible");
});
