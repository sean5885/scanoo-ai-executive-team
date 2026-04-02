import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

import { cleanText } from "./message-intent-utils.mjs";

const IGNORED_DIRS = new Set([
  ".git",
  ".tmp",
  "node_modules",
]);

export const BLOCKED_PACKAGE_VERSION_POLICIES = Object.freeze([
  {
    package_name: "axios",
    version: "1.14.1",
    reason: "blocked due to the 2026-03-31 npm maintainer compromise",
  },
  {
    package_name: "axios",
    version: "0.30.4",
    reason: "blocked due to the 2026-03-31 npm maintainer compromise",
  },
]);

async function findPackageLockFiles(rootDir, currentDir = rootDir, found = []) {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      await findPackageLockFiles(rootDir, path.join(currentDir, entry.name), found);
      continue;
    }

    if (entry.isFile() && entry.name === "package-lock.json") {
      found.push(path.join(currentDir, entry.name));
    }
  }

  return found;
}

function extractPackageName(packagePath = "") {
  const normalized = cleanText(packagePath);
  if (!normalized.includes("node_modules/")) {
    return null;
  }
  return normalized.split("node_modules/").pop() || null;
}

function inspectLockfile({
  rootDir = process.cwd(),
  lockfilePath = "",
  lockfile = {},
  policies = BLOCKED_PACKAGE_VERSION_POLICIES,
} = {}) {
  const packages = lockfile?.packages && typeof lockfile.packages === "object"
    ? Object.entries(lockfile.packages)
    : [];
  const normalizedLockfilePath = path.relative(rootDir, lockfilePath) || "package-lock.json";
  const violations = [];

  for (const [packagePath, metadata] of packages) {
    const packageName = extractPackageName(packagePath);
    const detectedVersion = cleanText(metadata?.version);
    if (!packageName || !detectedVersion) {
      continue;
    }

    for (const policy of policies) {
      if (packageName === policy.package_name && detectedVersion === policy.version) {
        violations.push({
          lockfile_path: normalizedLockfilePath,
          package_name: packageName,
          detected_version: detectedVersion,
          package_path: cleanText(packagePath),
          reason: cleanText(policy.reason),
        });
      }
    }
  }

  return {
    lockfile_path: normalizedLockfilePath,
    package_count: packages.length,
    violations,
  };
}

export async function buildDependencySummary({
  rootDir = process.cwd(),
  policies = BLOCKED_PACKAGE_VERSION_POLICIES,
} = {}) {
  const lockfilePaths = (await findPackageLockFiles(rootDir)).sort((left, right) => left.localeCompare(right));
  const inspections = await Promise.all(lockfilePaths.map(async (lockfilePath) => {
    try {
      const raw = await readFile(lockfilePath, "utf8");
      const lockfile = JSON.parse(raw);
      return inspectLockfile({
        rootDir,
        lockfilePath,
        lockfile,
        policies,
      });
    } catch (error) {
      return {
        lockfile_path: path.relative(rootDir, lockfilePath) || "package-lock.json",
        package_count: 0,
        violations: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  const violations = inspections.flatMap((inspection) => inspection.violations || []);
  const errors = inspections
    .filter((inspection) => cleanText(inspection?.error))
    .map((inspection) => ({
      lockfile_path: inspection.lockfile_path,
      error: cleanText(inspection.error),
    }));
  const blockedVersions = policies.map((policy) => `${policy.package_name}@${policy.version}`);
  const status = violations.length === 0 && errors.length === 0 ? "pass" : "fail";
  const guidance = status === "pass"
    ? "dependency guardrails pass; keep blocked package versions out of lockfiles during npm updates."
    : errors.length > 0
      ? "先修 dependency guardrails：有 lockfile 無法讀取；修好 lockfile 後重跑 npm run check:dependencies。"
      : "先修 dependency guardrails：禁止讓 package-lock 解析到 axios 1.14.1 / 0.30.4；調整 direct/transitive constraints 後重跑 npm run check:dependencies。";

  return {
    status,
    summary: status === "pass"
      ? "dependency lockfiles avoid blocked package versions"
      : "dependency lockfiles include blocked package versions or parse errors",
    guidance,
    checked_lockfiles: inspections.map((inspection) => inspection.lockfile_path),
    checked_package_count: inspections.reduce((sum, inspection) => sum + Number(inspection.package_count || 0), 0),
    blocked_versions: blockedVersions,
    violations,
    errors,
  };
}

export function renderDependencyGuardrailsReport(summary = {}) {
  const checkedLockfiles = Array.isArray(summary?.checked_lockfiles) && summary.checked_lockfiles.length > 0
    ? summary.checked_lockfiles.join(", ")
    : "none";
  const blockedVersions = Array.isArray(summary?.blocked_versions) && summary.blocked_versions.length > 0
    ? summary.blocked_versions.join(", ")
    : "none";
  const violations = Array.isArray(summary?.violations) && summary.violations.length > 0
    ? summary.violations
      .map((item) => `${cleanText(item?.package_name) || "unknown"}@${cleanText(item?.detected_version) || "unknown"} via ${cleanText(item?.lockfile_path) || "unknown"}`)
      .join(", ")
    : "none";
  const errors = Array.isArray(summary?.errors) && summary.errors.length > 0
    ? summary.errors
      .map((item) => `${cleanText(item?.lockfile_path) || "unknown"}: ${cleanText(item?.error) || "unknown error"}`)
      .join(", ")
    : "none";

  return [
    "Dependency Guardrails",
    `狀態：${cleanText(summary?.status) || "fail"}`,
    `lockfiles：${checkedLockfiles}`,
    `blocked versions：${blockedVersions}`,
    `違規：${violations}`,
    `錯誤：${errors}`,
    `指引：${cleanText(summary?.guidance) || "先修 dependency guardrails。"}`
  ].join("\n");
}

export function getDependencyGuardrailsExitCode(summary = {}) {
  return cleanText(summary?.status) === "pass" ? 0 : 1;
}
