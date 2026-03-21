import { readFile } from "node:fs/promises";
import path from "node:path";

const asJson = process.argv.includes("--json");
let restoreStdout = null;

const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true);
restoreStdout = () => {
  process.stdout.write = originalWrite;
};

const {
  buildRoutingTrendReport,
  formatRoutingEvalReport,
  formatRoutingTrendReport,
  runRoutingEval,
} = await import("../src/routing-eval.mjs");

restoreStdout?.();

const DEFAULT_CLOSED_LOOP_DIR = path.resolve(process.cwd(), ".tmp/routing-eval-closed-loop");

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

async function readJson(filePath = "") {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function resolveCompareRunFromLatest(baseDir = DEFAULT_CLOSED_LOOP_DIR) {
  const pointerPath = path.join(baseDir, "latest-session.json");
  const pointer = await readJson(pointerPath);
  const artifactCandidates = [
    pointer?.artifacts?.rerun_eval_json,
    pointer?.artifacts?.initial_eval_json,
  ].filter(Boolean);

  for (const artifactPath of artifactCandidates) {
    try {
      return {
        label: path.relative(process.cwd(), artifactPath) || artifactPath,
        path: artifactPath,
        run: await readJson(artifactPath),
      };
    } catch (error) {
      if (artifactPath === artifactCandidates[artifactCandidates.length - 1]) {
        throw error;
      }
    }
  }

  throw new Error(`No routing eval artifact found in ${pointerPath}`);
}

async function resolveCompareRun() {
  const comparePath = getArgValue("--compare");
  if (comparePath) {
    const resolvedPath = path.resolve(process.cwd(), comparePath);
    return {
      label: path.relative(process.cwd(), resolvedPath) || resolvedPath,
      path: resolvedPath,
      run: await readJson(resolvedPath),
    };
  }

  if (process.argv.includes("--compare-last")) {
    return resolveCompareRunFromLatest();
  }

  return null;
}

const run = await runRoutingEval();
const compareRun = await resolveCompareRun();
const trendReport = buildRoutingTrendReport({
  currentRun: run,
  previousRun: compareRun?.run || null,
  currentLabel: "current",
  previousLabel: compareRun?.label || "previous",
});

if (asJson) {
  console.log(JSON.stringify({
    ...run,
    trend_report: trendReport,
  }, null, 2));
} else {
  console.log(formatRoutingEvalReport(run));
  console.log("");
  console.log(formatRoutingTrendReport(trendReport));
  if (run.validation_issues?.length) {
    console.log("");
    console.log("Validation issues");
    for (const issue of run.validation_issues) {
      console.log(`- ${issue}`);
    }
  }
}

process.exitCode = run.ok ? 0 : 1;
