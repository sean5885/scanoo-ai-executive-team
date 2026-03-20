import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCb, spawn } from "node:child_process";
import {
  meetingAudioCaptureDir,
  meetingAudioCaptureEnabled,
  meetingAudioFfmpegBin,
  meetingAudioInputDeviceIndex,
  meetingTranscribeApiKey,
  meetingTranscribeBaseUrl,
  meetingTranscribeFasterWhisperCacheDir,
  meetingTranscribeFasterWhisperComputeType,
  meetingTranscribeFasterWhisperDevice,
  meetingTranscribeFasterWhisperModel,
  meetingTranscribeFasterWhisperPython,
  meetingTranscribeFasterWhisperScript,
  meetingTranscribeLanguage,
  meetingTranscribeModel,
  meetingTranscribeProvider,
} from "./config.mjs";
import { nowIso, normalizeText } from "./text-utils.mjs";

const execFile = promisify(execFileCb);
const activeRecordings = new Map();

function ensureCaptureDir() {
  fs.mkdirSync(meetingAudioCaptureDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Recording device discovery
// ---------------------------------------------------------------------------

export function parseAvfoundationAudioDevices(stderr = "") {
  return String(stderr || "")
    .split("\n")
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^\[AVFoundation indev @ [^\]]+\]\s+\[(\d+)\]\s+(.+)$/);
      if (!match) {
        return null;
      }
      return {
        index: match[1],
        name: match[2],
      };
    })
    .filter(Boolean)
    .filter((item) => /麥克風|microphone/i.test(item.name));
}

function rankAudioDevice(device) {
  const name = String(device?.name || "");
  if (/MacBook|Built-in|內建|built-in/i.test(name) && /麥克風|microphone/i.test(name)) {
    return 0;
  }
  if (/麥克風|microphone/i.test(name) && !/iPhone/i.test(name)) {
    return 1;
  }
  if (/iPhone/i.test(name)) {
    return 2;
  }
  return 3;
}

export async function detectPreferredAudioInput() {
  let stderr = "";
  try {
    const result = await execFile(meetingAudioFfmpegBin, [
      "-hide_banner",
      "-f",
      "avfoundation",
      "-list_devices",
      "true",
      "-i",
      "",
    ]);
    stderr = result.stderr || "";
  } catch (error) {
    stderr = error?.stderr || error?.stdout || error?.message || "";
  }
  const devices = parseAvfoundationAudioDevices(stderr);
  if (!devices.length) {
    return null;
  }
  if (meetingAudioInputDeviceIndex) {
    return devices.find((device) => device.index === meetingAudioInputDeviceIndex) || null;
  }
  return devices.sort((left, right) => rankAudioDevice(left) - rankAudioDevice(right))[0] || null;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

// ---------------------------------------------------------------------------
// Recording runtime and health-state shaping
// ---------------------------------------------------------------------------

function buildMeetingRecordingMeta({ device = null, filePath = "", pid = null, startedAt = "" } = {}) {
  return {
    device_index: String(device?.index || "").trim(),
    device_name: String(device?.name || "").trim(),
    file_path: String(filePath || "").trim(),
    started_at: startedAt || nowIso(),
    pid: pid || null,
  };
}

function buildMeetingRecordingFailure(reason) {
  return {
    started: false,
    reason: normalizeText(reason) || "unknown_reason",
  };
}

function buildMeetingRecordingResult({ meta = {}, reused = false } = {}) {
  return {
    started: true,
    ...(reused ? { reused: true } : {}),
    ...meta,
  };
}

function buildMeetingRecordingStatus({ active = false, source = "none", meta = {} } = {}) {
  return {
    active,
    source,
    ...meta,
  };
}

export async function startMeetingAudioCapture(sessionId) {
  if (!meetingAudioCaptureEnabled || !sessionId) {
    return buildMeetingRecordingFailure("disabled");
  }
  const existing = activeRecordings.get(sessionId);
  if (existing) {
    return buildMeetingRecordingResult({ meta: existing.meta, reused: true });
  }

  const device = await detectPreferredAudioInput();
  if (!device) {
    return buildMeetingRecordingFailure("missing_audio_device");
  }

  ensureCaptureDir();
  const filePath = path.join(meetingAudioCaptureDir, `${sessionId}-${Date.now()}.m4a`);
  const args = [
    "-y",
    "-f",
    "avfoundation",
    "-i",
    `:${device.index}`,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "aac",
    filePath,
  ];
  const child = spawn(meetingAudioFfmpegBin, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const meta = buildMeetingRecordingMeta({
    device,
    filePath,
    pid: child.pid || null,
  });
  activeRecordings.set(sessionId, { child, meta, stderrRef: () => stderr });

  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (child.exitCode != null) {
    activeRecordings.delete(sessionId);
    return buildMeetingRecordingFailure(normalizeText(stderr) || "ffmpeg_exited_early");
  }

  return buildMeetingRecordingResult({ meta });
}

export async function stopMeetingAudioCapture(sessionId) {
  const active = activeRecordings.get(sessionId);
  if (!active) {
    return null;
  }

  active.child.kill("SIGINT");
  await waitForExit(active.child);
  activeRecordings.delete(sessionId);
  return {
    ...active.meta,
    stderr: normalizeText(active.stderrRef()),
  };
}

export function isMeetingAudioCaptureActive(sessionId) {
  return Boolean(sessionId) && activeRecordings.has(sessionId);
}

function isPidAlive(pid) {
  const numeric = Number.parseInt(String(pid || ""), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return false;
  }
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

export function getMeetingAudioCaptureStatus(sessionId, persisted = null) {
  const active = sessionId ? activeRecordings.get(sessionId) : null;
  if (active) {
    return buildMeetingRecordingStatus({
      active: true,
      source: "memory",
      meta: active.meta,
    });
  }

  if (!persisted) {
    return buildMeetingRecordingStatus({
      active: false,
      source: "none",
    });
  }

  const pid = Number.parseInt(String(persisted.audio_pid || ""), 10);
  const activeByPid = isPidAlive(pid);
  return buildMeetingRecordingStatus({
    active: activeByPid,
    source: activeByPid ? "persisted_pid" : "none",
    meta: {
      pid: Number.isFinite(pid) ? pid : null,
      file_path: normalizeText(persisted.audio_file_path || ""),
      device_name: normalizeText(persisted.audio_device_name || ""),
      started_at: normalizeText(persisted.audio_started_at || ""),
    },
  });
}

export async function stopMeetingAudioCaptureByMetadata(sessionId, persisted = null) {
  const active = activeRecordings.get(sessionId);
  if (active) {
    return stopMeetingAudioCapture(sessionId);
  }

  const pid = Number.parseInt(String(persisted?.audio_pid || ""), 10);
  if (!Number.isFinite(pid) || pid <= 0 || !isPidAlive(pid)) {
    return persisted?.audio_file_path
      ? {
          file_path: normalizeText(persisted.audio_file_path || ""),
          device_name: normalizeText(persisted.audio_device_name || ""),
          pid: Number.isFinite(pid) ? pid : null,
          started_at: normalizeText(persisted.audio_started_at || ""),
          stderr: "",
        }
      : null;
  }

  process.kill(pid, "SIGINT");
  return {
    file_path: normalizeText(persisted.audio_file_path || ""),
    device_name: normalizeText(persisted.audio_device_name || ""),
    pid,
    started_at: normalizeText(persisted.audio_started_at || ""),
    stderr: "",
  };
}

export function resolveMeetingTranscribeProvider(provider = meetingTranscribeProvider) {
  const normalized = String(provider || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");

  if (!normalized || normalized === "faster_whisper" || normalized === "local") {
    return "faster_whisper";
  }
  if (normalized === "openai" || normalized === "openai_compatible") {
    return "openai_compatible";
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Transcription runtime and health-state shaping
// ---------------------------------------------------------------------------

function buildMeetingTranscriptionFailure(reason) {
  return {
    ok: false,
    reason: normalizeText(reason) || "unknown_reason",
  };
}

function buildMeetingTranscriptionSuccess({ text = "", provider = "", model = "" } = {}) {
  return {
    ok: true,
    text,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

async function transcribeMeetingAudioWithOpenAiCompatible(filePath) {
  if (!filePath || !meetingTranscribeApiKey) {
    return buildMeetingTranscriptionFailure("missing_transcribe_api_key");
  }
  const buffer = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append("model", meetingTranscribeModel);
  if (meetingTranscribeLanguage) {
    form.append("language", meetingTranscribeLanguage);
  }
  form.append("file", new Blob([buffer]), path.basename(filePath));

  const response = await fetch(`${meetingTranscribeBaseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${meetingTranscribeApiKey}`,
    },
    body: form,
  });
  if (!response.ok) {
    const body = await response.text();
    return buildMeetingTranscriptionFailure(normalizeText(body) || `transcription_failed_${response.status}`);
  }
  const payload = await response.json();
  const text = normalizeText(payload?.text || "");
  if (!text) {
    return buildMeetingTranscriptionFailure("empty_transcript");
  }
  return buildMeetingTranscriptionSuccess({ text });
}

async function transcribeMeetingAudioWithFasterWhisper(filePath) {
  if (!filePath) {
    return buildMeetingTranscriptionFailure("missing_audio_file");
  }

  const args = [
    meetingTranscribeFasterWhisperScript,
    "--file",
    filePath,
    "--model",
    meetingTranscribeFasterWhisperModel,
    "--device",
    meetingTranscribeFasterWhisperDevice,
    "--compute-type",
    meetingTranscribeFasterWhisperComputeType,
    "--cache-dir",
    meetingTranscribeFasterWhisperCacheDir,
  ];
  if (meetingTranscribeLanguage) {
    args.push("--language", meetingTranscribeLanguage);
  }

  try {
    const result = await execFile(meetingTranscribeFasterWhisperPython, args, {
      maxBuffer: 10 * 1024 * 1024,
    });
    const payload = JSON.parse(String(result.stdout || "{}"));
    const text = normalizeText(payload?.text || "");
    if (!text) {
      return buildMeetingTranscriptionFailure("empty_transcript");
    }
    return buildMeetingTranscriptionSuccess({
      text,
      provider: "faster_whisper",
      model: payload?.model || meetingTranscribeFasterWhisperModel,
    });
  } catch (error) {
    const stderr = normalizeText(error?.stderr || error?.stdout || error?.message || "");
    return buildMeetingTranscriptionFailure(stderr || "faster_whisper_failed");
  }
}

export async function transcribeMeetingAudio(filePath) {
  const provider = resolveMeetingTranscribeProvider(meetingTranscribeProvider);
  if (provider === "faster_whisper") {
    return transcribeMeetingAudioWithFasterWhisper(filePath);
  }
  if (provider === "openai_compatible") {
    return transcribeMeetingAudioWithOpenAiCompatible(filePath);
  }
  return buildMeetingTranscriptionFailure(`unsupported_transcribe_provider:${provider}`);
}
