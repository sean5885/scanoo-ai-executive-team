import { execFileSync } from "node:child_process";
import process from "node:process";

function readGitCommitShort() {
  try {
    return String(
      execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).trim() || "";
  } catch {
    return "";
  }
}

function readGitDirty() {
  try {
    return String(
      execFileSync("git", ["status", "--short"], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).trim().length > 0;
  } catch {
    return false;
  }
}

const runtimeGitCommitShort = readGitCommitShort();
const runtimeGitDirty = readGitDirty();

export function getRuntimeVersionSnapshot() {
  return {
    git_commit: runtimeGitCommitShort || "",
    git_dirty: runtimeGitDirty === true,
  };
}

export { runtimeGitCommitShort, runtimeGitDirty };
