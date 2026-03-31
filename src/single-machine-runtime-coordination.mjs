import { cleanText } from "./message-intent-utils.mjs";

const sessionQueues = new Map();

function buildSessionCoordinationKey({ accountId = "", sessionKey = "" } = {}) {
  const account = cleanText(accountId);
  const session = cleanText(sessionKey);
  return account && session ? `${account}::${session}` : "";
}

export async function runInSingleMachineRuntimeSession({
  accountId = "",
  sessionKey = "",
  logger = null,
  workflow = "",
  reason = "",
} = {}, work = async () => null) {
  if (typeof work !== "function") {
    throw new TypeError("runInSingleMachineRuntimeSession requires a work function");
  }

  const coordinationKey = buildSessionCoordinationKey({ accountId, sessionKey });
  if (!coordinationKey) {
    return work();
  }

  const previous = sessionQueues.get(coordinationKey) || Promise.resolve();
  let releaseCurrent = null;
  const current = previous
    .catch(() => {})
    .then(() => new Promise((resolve) => {
      releaseCurrent = resolve;
    }));

  sessionQueues.set(coordinationKey, current);
  await previous.catch(() => {});

  try {
    logger?.info?.("single_machine_runtime_session_enter", {
      account_id: cleanText(accountId) || null,
      session_key: cleanText(sessionKey) || null,
      workflow: cleanText(workflow) || null,
      reason: cleanText(reason) || null,
    });
    return await work();
  } finally {
    releaseCurrent?.();
    if (sessionQueues.get(coordinationKey) === current) {
      sessionQueues.delete(coordinationKey);
    }
    logger?.info?.("single_machine_runtime_session_exit", {
      account_id: cleanText(accountId) || null,
      session_key: cleanText(sessionKey) || null,
      workflow: cleanText(workflow) || null,
      reason: cleanText(reason) || null,
    });
  }
}

export function resetSingleMachineRuntimeCoordinationForTests() {
  sessionQueues.clear();
}
