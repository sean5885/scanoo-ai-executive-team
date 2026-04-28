import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const TEST_FILES = [
  "tests/executive-improvement-workflow.test.mjs",
  "tests/executive-closed-loop.test.mjs",
  "tests/executive-lifecycle.test.mjs",
];

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv = []) {
  const args = {
    rounds: 20,
    parallel: 10,
    testConcurrency: 8,
    quiet: false,
    logDir: path.resolve(process.cwd(), ".tmp/executive-concurrency-stress"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--rounds") {
      args.rounds = parseInteger(argv[index + 1], args.rounds);
      index += 1;
      continue;
    }
    if (arg === "--parallel") {
      args.parallel = parseInteger(argv[index + 1], args.parallel);
      index += 1;
      continue;
    }
    if (arg === "--test-concurrency") {
      args.testConcurrency = parseInteger(argv[index + 1], args.testConcurrency);
      index += 1;
      continue;
    }
    if (arg === "--log-dir") {
      args.logDir = path.resolve(process.cwd(), String(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    if (arg === "--quiet") {
      args.quiet = true;
    }
  }

  args.rounds = Math.max(1, args.rounds);
  args.parallel = Math.max(1, Math.min(args.parallel, args.rounds));
  args.testConcurrency = Math.max(1, args.testConcurrency);
  return args;
}

async function runRound({
  round = 1,
  testConcurrency = 8,
  logDir = "",
  quiet = false,
} = {}) {
  const logPath = path.join(logDir, `round-${String(round).padStart(3, "0")}.log`);
  const commandArgs = [
    "--test",
    `--test-concurrency=${testConcurrency}`,
    ...TEST_FILES,
  ];

  const startedAt = Date.now();
  const outputChunks = [];
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => outputChunks.push(chunk));
    child.stderr.on("data", (chunk) => outputChunks.push(chunk));

    child.on("error", (error) => {
      resolve({ ok: false, error, exitCode: 1 });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, exitCode: code ?? 1, error: null });
    });
  });

  const durationMs = Date.now() - startedAt;
  const output = Buffer.concat(outputChunks).toString("utf8");
  await fs.writeFile(logPath, output, "utf8");

  if (!quiet) {
    const label = result.ok ? "PASS" : "FAIL";
    console.log(
      `[executive-concurrency] ${label} round=${round} duration_ms=${durationMs} log=${logPath}`,
    );
  }

  return {
    ...result,
    round,
    durationMs,
    logPath,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(args.logDir, { recursive: true });

  console.log(
    `[executive-concurrency] start rounds=${args.rounds} parallel=${args.parallel} test_concurrency=${args.testConcurrency}`,
  );
  console.log(`[executive-concurrency] tests=${TEST_FILES.join(",")}`);

  let nextRound = 1;
  let running = 0;
  const failures = [];

  await new Promise((resolve) => {
    const schedule = () => {
      while (running < args.parallel && nextRound <= args.rounds) {
        const round = nextRound;
        nextRound += 1;
        running += 1;
        runRound({
          round,
          testConcurrency: args.testConcurrency,
          logDir: args.logDir,
          quiet: args.quiet,
        })
          .then((result) => {
            if (!result.ok) {
              failures.push(result);
            }
          })
          .finally(() => {
            running -= 1;
            if (nextRound > args.rounds && running === 0) {
              resolve();
              return;
            }
            schedule();
          });
      }
    };
    schedule();
  });

  if (failures.length > 0) {
    console.error(
      `[executive-concurrency] failed ${failures.length}/${args.rounds} rounds`,
    );
    for (const failure of failures) {
      console.error(
        `[executive-concurrency] round=${failure.round} exit=${failure.exitCode} log=${failure.logPath}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(`[executive-concurrency] all ${args.rounds} rounds passed`);
}

main().catch((error) => {
  console.error(`[executive-concurrency] fatal ${error?.message || String(error)}`);
  process.exitCode = 1;
});
