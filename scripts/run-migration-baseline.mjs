import { spawn } from "node:child_process";

const BASELINES = Object.freeze({
  pr00: [
    "tests/fake-completion-baseline.test.mjs",
    "tests/executive-orchestrator.test.mjs",
  ],
  pr01: [
    "tests/plane-skeleton.test.mjs",
  ],
  pr02: [
    "tests/executive-verifier.test.mjs",
  ],
  pr03: [
    "tests/pdf-extractor.test.mjs",
    "tests/pdf-retriever.test.mjs",
    "tests/e2e-pdf-baseline.test.mjs",
    "tests/answer-source-mapper.test.mjs",
  ],
  pr04: [
    "tests/executive-orchestrator.test.mjs",
    "tests/executive-verifier.test.mjs",
    "tests/plane-skeleton.test.mjs",
  ],
  pr05: [
    "tests/system-self-check.test.mjs",
    "tests/release-check.test.mjs",
  ],
  pr06: [
    "tests/system-self-check.test.mjs",
  ],
  pr07: [
    "tests/pdf-acceptance-eval.test.mjs",
  ],
  pr08: [
    "tests/system-self-check.test.mjs",
    "tests/pdf-acceptance-eval.test.mjs",
  ],
  pr09: [
    "tests/release-check.test.mjs",
  ],
  pr10: [
    "tests/system-self-check.test.mjs",
    "tests/release-check.test.mjs",
    "tests/pdf-acceptance-eval.test.mjs",
  ],
  pr11: [
    "tests/system-self-check.test.mjs",
    "tests/release-check.test.mjs",
    "tests/pdf-acceptance-eval.test.mjs",
    "tests/fake-completion-baseline.test.mjs",
    "tests/e2e-pdf-baseline.test.mjs",
  ],
});

function resolveRequestedBaselines(value = "") {
  const normalized = String(value || "all").trim().toLowerCase();
  if (!normalized || normalized === "all") {
    return Object.keys(BASELINES);
  }
  const names = normalized.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = names.filter((item) => !BASELINES[item]);
  if (unknown.length > 0) {
    throw new Error(`unknown migration baseline(s): ${unknown.join(", ")}`);
  }
  return names;
}

function runNodeTest(files = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--test", ...files], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`migration baseline failed with exit ${code ?? 1}`));
    });
  });
}

async function main() {
  const wantsList = process.argv.includes("--list");
  const wantsDryRun = process.argv.includes("--dry-run");
  const requested = process.argv
    .slice(2)
    .find((value) => !String(value || "").startsWith("--")) || "all";
  const baselineNames = resolveRequestedBaselines(requested);
  if (wantsList) {
    console.log(Object.keys(BASELINES).join("\n"));
    return;
  }
  console.log(`Running migration baseline: ${baselineNames.join(", ")}`);

  for (const name of baselineNames) {
    const files = BASELINES[name];
    console.log(`\n[migration-baseline:${name}]`);
    for (const file of files) {
      console.log(`- ${file}`);
    }
    if (!wantsDryRun) {
      await runNodeTest(files);
    }
  }

  if (wantsDryRun) {
    console.log("\nMigration baseline dry-run complete.");
  } else {
    console.log("\nMigration baseline complete.");
  }
}

main().catch((error) => {
  console.error(`migration baseline error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
