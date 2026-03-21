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
  runRoutingEval,
} = await import("../src/routing-eval.mjs");
const {
  buildRoutingDiagnosticsSummary,
  formatRoutingDiagnosticsSummary,
} = await import("../src/routing-eval-diagnostics.mjs");
const {
  archiveRoutingDiagnosticsSnapshot,
  resolveRoutingDiagnosticsSnapshot,
  resolveRoutingDiagnosticsTag,
} = await import("../src/routing-diagnostics-history.mjs");

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
        type: "latest-session",
        label: path.relative(process.cwd(), artifactPath) || artifactPath,
        ref: artifactPath,
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
  const compareSnapshot = getArgValue("--compare-snapshot");
  const compareTag = getArgValue("--compare-tag");
  const wantsCompareLast = process.argv.includes("--compare-last");
  const selectors = [
    Boolean(comparePath),
    Boolean(compareSnapshot),
    Boolean(compareTag),
    wantsCompareLast,
  ].filter(Boolean);

  if (selectors.length > 1) {
    throw new Error("Choose only one compare selector: --compare, --compare-snapshot, --compare-tag, or --compare-last");
  }

  if (compareSnapshot) {
    return resolveRoutingDiagnosticsSnapshot({
      reference: compareSnapshot,
    });
  }

  if (compareTag) {
    return resolveRoutingDiagnosticsTag({
      tag: compareTag,
    });
  }

  if (comparePath) {
    const resolvedPath = path.resolve(process.cwd(), comparePath);
    return {
      type: "path",
      label: path.relative(process.cwd(), resolvedPath) || resolvedPath,
      ref: resolvedPath,
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
const diagnosticsSummary = buildRoutingDiagnosticsSummary({
  run,
  previousRun: compareRun?.run || null,
  currentLabel: "current",
  previousLabel: compareRun?.label || "previous",
});
const archivedSnapshot = await archiveRoutingDiagnosticsSnapshot({
  scope: "routing-eval",
  stage: "standalone",
  run,
  diagnosticsSummary,
  compareTarget: compareRun
    ? {
        type: compareRun.type || "custom",
        label: compareRun.label || null,
        ref: compareRun.ref || compareRun.path || null,
      }
    : null,
});

if (asJson) {
  console.log(JSON.stringify({
    ...run,
    trend_report: diagnosticsSummary.trend_report,
    diagnostics_summary: diagnosticsSummary,
    diagnostics_archive: archivedSnapshot,
  }, null, 2));
} else {
  console.log(formatRoutingDiagnosticsSummary(diagnosticsSummary));
  if (archivedSnapshot?.snapshot_path) {
    console.log("");
    console.log(`Diagnostics snapshot: ${path.relative(process.cwd(), archivedSnapshot.snapshot_path) || archivedSnapshot.snapshot_path}`);
    console.log(`Diagnostics manifest: ${path.relative(process.cwd(), archivedSnapshot.manifest_path) || archivedSnapshot.manifest_path}`);
  }
  if (run.validation_issues?.length) {
    console.log("");
    console.log("Validation issues");
    for (const issue of run.validation_issues) {
      console.log(`- ${issue}`);
    }
  }
}

process.exitCode = run.ok ? 0 : 1;
