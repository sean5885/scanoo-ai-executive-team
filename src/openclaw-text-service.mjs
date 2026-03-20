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
} = {}) {
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
    try {
      const { stdout } = await execFile("openclaw", args, {
        cwd: process.cwd(),
        timeout: timeoutMs + 3000,
        maxBuffer: 1024 * 1024 * 8,
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
      await new Promise((resolve) => setTimeout(resolve, OPENCLAW_LOCK_RETRY_DELAY_MS));
    }
  }
  throw lastError || new Error("openclaw_text_generation_failed");
}
