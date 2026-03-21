import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

test("routing diagnostics CLI shows latest archived snapshot by default", () => {
  const archiveDir = path.join(os.tmpdir(), `routing-diagnostics-view-${Date.now()}-latest`);
  const raw = execFileSync("node", ["scripts/routing-eval.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });
  const parsed = JSON.parse(raw);
  const output = execFileSync("node", ["scripts/routing-diagnostics.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });

  assert.match(output, new RegExp(`Current: snapshot:${parsed.diagnostics_archive.run_id}`));
  assert.match(output, /Compare: none/);
  assert.match(output, /Decision: observe_only \(info\)/);
  assert.match(output, /Manifest: /);
});

test("routing diagnostics CLI can compare latest snapshot with the previous archived snapshot", () => {
  const archiveDir = path.join(os.tmpdir(), `routing-diagnostics-view-${Date.now()}-previous`);
  const firstRaw = execFileSync("node", ["scripts/routing-eval.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });
  const firstParsed = JSON.parse(firstRaw);

  const secondRaw = execFileSync("node", ["scripts/routing-eval.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });
  const secondParsed = JSON.parse(secondRaw);

  const output = execFileSync("node", ["scripts/routing-diagnostics.mjs", "--compare-previous"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });

  assert.match(output, new RegExp(`Current: snapshot:${secondParsed.diagnostics_archive.run_id}`));
  assert.match(output, new RegExp(`Compare: snapshot:${firstParsed.diagnostics_archive.run_id}`));
  assert.match(output, /trend stable \| delta \+0\.0000/);
  assert.match(output, /Trend: miss delta \+0 \| case delta \+0/);
});

test("routing diagnostics CLI can compare latest snapshot with an existing git tag", () => {
  const archiveDir = path.join(os.tmpdir(), `routing-diagnostics-view-${Date.now()}-tag`);
  execFileSync("node", ["scripts/routing-eval.mjs", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
  });

  const output = execFileSync("node", [
    "scripts/routing-diagnostics.mjs",
    "--compare-tag",
    "routing-eval-baseline-v2",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ROUTING_DIAGNOSTICS_ARCHIVE_DIR: archiveDir,
    },
    maxBuffer: 20 * 1024 * 1024,
  });

  assert.match(output, /Compare: tag:routing-eval-baseline-v2/);
  assert.match(output, /Decision: /);
  assert.match(output, /Snapshot: /);
});
