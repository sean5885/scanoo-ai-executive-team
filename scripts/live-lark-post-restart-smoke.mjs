import "dotenv/config";
import http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { getLatestAccount } from "../src/rag-repository.mjs";

function getAccountId() {
  return String(process.argv[2] || process.env.LARK_SMOKE_ACCOUNT_ID || getLatestAccount()?.id || "").trim();
}

function rememberOutput(lines, chunk) {
  const next = String(chunk || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of next) {
    lines.push(line);
    if (lines.length > 20) {
      lines.shift();
    }
  }
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return {
    status: response.status,
    data,
  };
}

async function waitForHealth(baseUrl, child, logs, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`server exited early (${child.exitCode})`);
    }
    try {
      const health = await fetchJson(`${baseUrl}/health`);
      if (health.status === 200 && health.data?.ok === true) {
        return;
      }
    } catch {
      // Server not ready yet.
    }
    await delay(250);
  }

  throw new Error(`timed out waiting for /health; stderr_tail=${JSON.stringify(logs.stderr)}`);
}

async function stopServer(child) {
  if (!child || child.exitCode != null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000).then(() => {
      if (child.exitCode == null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

async function runCycle({ label, port, accountId }) {
  const logs = {
    stdout: [],
    stderr: [],
  };
  const child = spawn(process.execPath, ["src/http-only.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LARK_OAUTH_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => rememberOutput(logs.stdout, chunk));
  child.stderr.on("data", (chunk) => rememberOutput(logs.stderr, chunk));

  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForHealth(baseUrl, child, logs);

    const auth = await fetchJson(
      `${baseUrl}/api/auth/status?account_id=${encodeURIComponent(accountId)}`,
    );
    if (auth.status !== 200 || auth.data?.ok !== true || auth.data?.authorized !== true) {
      throw new Error(`auth smoke failed: ${JSON.stringify(auth.data)}`);
    }

    const driveRoot = await fetchJson(
      `${baseUrl}/api/drive/root?account_id=${encodeURIComponent(accountId)}`,
    );
    if (driveRoot.status !== 200 || driveRoot.data?.ok !== true) {
      throw new Error(`drive-root smoke failed: ${JSON.stringify(driveRoot.data)}`);
    }

    return {
      label,
      pid: child.pid,
      auth: {
        account_id: auth.data.account_id || accountId,
        user_open_id: auth.data.user?.open_id || null,
        expires_at: auth.data.expires_at || null,
      },
      drive_root: {
        item_count: Array.isArray(driveRoot.data?.items) ? driveRoot.data.items.length : 0,
        has_more: driveRoot.data?.has_more === true,
      },
      stdout_tail: logs.stdout,
      stderr_tail: logs.stderr,
    };
  } finally {
    await stopServer(child);
  }
}

async function main() {
  const accountId = getAccountId();
  if (!accountId) {
    throw new Error("missing_account_id: pass one as argv[2] or set LARK_SMOKE_ACCOUNT_ID after OAuth");
  }

  const port = await findFreePort();
  const first = await runCycle({
    label: "before_restart",
    port,
    accountId,
  });
  const second = await runCycle({
    label: "after_restart",
    port,
    accountId,
  });

  console.log(JSON.stringify({
    ok: true,
    account_id: accountId,
    port,
    cycles: [first, second],
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
    account_id: getAccountId() || null,
  }, null, 2));
  process.exitCode = 1;
});
