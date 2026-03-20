import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  runtimeGuardCompetingLaunchLabels,
  runtimeGuardDisableCompetingLaunchAgents,
} from "./config.mjs";

const execFileAsync = promisify(execFile);

async function runLaunchctl(args) {
  return execFileAsync("/bin/launchctl", args, {
    timeout: 10000,
    env: process.env,
  });
}

async function isLaunchAgentRunning(label) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!uid) {
    return false;
  }

  try {
    await runLaunchctl(["print", `gui/${uid}/${label}`]);
    return true;
  } catch {
    return false;
  }
}

async function disableLaunchAgent(label) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!uid) {
    return false;
  }

  try {
    await runLaunchctl(["bootout", `gui/${uid}/${label}`]);
  } catch {
    // The service may already be stopped; disabling still matters.
  }

  await runLaunchctl(["disable", `gui/${uid}/${label}`]);
  return true;
}

export async function enforceSingleLarkResponderRuntime({ logger = console } = {}) {
  if (process.platform !== "darwin" || !runtimeGuardDisableCompetingLaunchAgents) {
    return { inspected: [], disabled: [] };
  }

  const inspected = [];
  const disabled = [];

  for (const label of runtimeGuardCompetingLaunchLabels) {
    if (!label) {
      continue;
    }

    const running = await isLaunchAgentRunning(label);
    inspected.push({ label, running });

    if (!running) {
      continue;
    }

    await disableLaunchAgent(label);
    disabled.push(label);
    logger.warn?.("competing_launch_agent_disabled", { label });
  }

  return { inspected, disabled };
}
