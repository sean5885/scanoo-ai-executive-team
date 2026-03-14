import fs from "node:fs/promises";

import { lobsterSecurityExpectedVersion, lobsterSecurityProjectRoot } from "./config.mjs";

export async function getLobsterSecurityRuntimeContract() {
  const pyprojectPath = `${lobsterSecurityProjectRoot}/pyproject.toml`;
  try {
    const raw = await fs.readFile(pyprojectPath, "utf8");
    const name = raw.match(/^name\s*=\s*"([^"]+)"/m)?.[1] || "lobster-security";
    const version = raw.match(/^version\s*=\s*"([^"]+)"/m)?.[1] || null;
    return {
      package_name: name,
      version,
      expected_version: lobsterSecurityExpectedVersion,
      compatible: Boolean(version && version === lobsterSecurityExpectedVersion),
      pyproject_path: pyprojectPath,
    };
  } catch (error) {
    return {
      package_name: "lobster-security",
      version: null,
      expected_version: lobsterSecurityExpectedVersion,
      compatible: false,
      pyproject_path: pyprojectPath,
      error: error?.message || "runtime_contract_unavailable",
    };
  }
}
