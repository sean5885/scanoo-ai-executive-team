import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  llmOpenClawAgentId,
  llmOpenClawSessionPrefix,
  llmOpenClawTimeoutMs,
} from "./config.mjs";
import { cleanText } from "./message-intent-utils.mjs";

const execFile = promisify(execFileCb);
const OPENCLAW_LOCK_RETRY_MAX = 3;
const OPENCLAW_LOCK_RETRY_DELAY_MS = 1500;

function buildOpenClawEnvelope({ systemPrompt = "", prompt = "" } = {}) {
  return [
    "<lobster_text_request>",
    "<system_instructions>",
    String(systemPrompt || "").trim(),
    "</system_instructions>",
    "<user_prompt>",
    String(prompt || "").trim(),
    "</user_prompt>",
    "</lobster_text_request>",
  ].join("\n");
}

function safeSessionIdSuffix(value = "") {
  const normalized = cleanText(String(value || "").toLowerCase()).replace(/[^a-z0-9_-]+/g, "-");
  return normalized || "default";
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason || Object.assign(new Error("request_cancelled"), {
    name: "AbortError",
    code: "request_cancelled",
  });
}

function waitWithSignal(delayMs, signal) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason || Object.assign(new Error("request_cancelled"), {
        name: "AbortError",
        code: "request_cancelled",
      }));
    }

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function parseOpenClawJson(rawText = "") {
  const text = String(rawText || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("\n{");
    const candidate = start >= 0 ? text.slice(start + 1).trim() : text;
    return JSON.parse(candidate);
  }
}

export async function callOpenClawTextGeneration({
  systemPrompt = "",
  prompt = "",
  sessionIdSuffix = "default",
  timeoutMs = llmOpenClawTimeoutMs,
  signal = null,
} = {}) {
  throwIfAborted(signal);
  const args = [
    "agent",
    "--agent",
    llmOpenClawAgentId,
    "--session-id",
    `${llmOpenClawSessionPrefix}-${safeSessionIdSuffix(sessionIdSuffix)}`,
    "--thinking",
    "off",
    "--timeout",
    String(Math.ceil(timeoutMs / 1000)),
    "--json",
    "--message",
    buildOpenClawEnvelope({ systemPrompt, prompt }),
  ];

  let lastError = null;
  for (let attempt = 0; attempt <= OPENCLAW_LOCK_RETRY_MAX; attempt += 1) {
    throwIfAborted(signal);
    try {
      const { stdout } = await execFile("openclaw", args, {
        cwd: process.cwd(),
        timeout: timeoutMs + 3000,
        maxBuffer: 1024 * 1024 * 8,
        signal,
      });
      const outer = parseOpenClawJson(stdout);
      const payloadText = outer?.payloads?.[0]?.text || outer?.result?.payloads?.[0]?.text || "";
      if (!payloadText) {
        throw new Error("openclaw_text_generation_empty_payload");
      }
      return payloadText;
    } catch (error) {
      lastError = error;
      const stderr = String(error?.stderr || "");
      if (attempt >= OPENCLAW_LOCK_RETRY_MAX || !stderr.includes("session file locked")) {
        break;
      }
      await waitWithSignal(OPENCLAW_LOCK_RETRY_DELAY_MS, signal);
    }
  }
  throw lastError || new Error("openclaw_text_generation_failed");
}
