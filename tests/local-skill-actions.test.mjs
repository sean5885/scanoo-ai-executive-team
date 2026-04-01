import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import {
  findLocalSkill,
  installLocalSkill,
  verifyLocalSkill,
} from "../src/local-skill-actions.mjs";

async function createLocalSkill(rootPath, skillName, summary = "Test skill summary") {
  const skillPath = path.join(rootPath, skillName);
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), `# ${skillName}\n\n${summary}\n`, "utf8");
  return skillPath;
}

test("findLocalSkill lists matching skills from bounded local roots", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lobster-find-skill-"));
  const installRoot = path.join(tempRoot, "install");
  const sourceRoot = path.join(tempRoot, "source");

  try {
    await createLocalSkill(sourceRoot, "playwright-cli", "Browser automation skill");
    const result = await findLocalSkill({
      query: "playwright",
      discoveryRoots: [installRoot, sourceRoot],
      installRoot,
      remoteCatalogProvider: async () => ({ ok: true, items: [] }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, "find_local_skill");
    assert.match(result.public_reply.answer, /找到 1 個/);
    assert.match(result.public_reply.sources.join("\n"), /playwright-cli/);
    assert.match(result.public_reply.limitations.join("\n"), /只使用受控 skill 來源/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("findLocalSkill also queries the curated remote catalog instead of local-only search", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lobster-find-remote-skill-"));
  const installRoot = path.join(tempRoot, "install");
  const sourceRoot = path.join(tempRoot, "source");

  try {
    const result = await findLocalSkill({
      query: "image",
      discoveryRoots: [installRoot, sourceRoot],
      installRoot,
      remoteCatalogProvider: async () => ({
        ok: true,
        items: [
          { name: "imagegen", installed: false },
        ],
      }),
    });

    assert.equal(result.ok, true);
    assert.match(result.public_reply.answer, /受控 skill 候選/);
    assert.match(result.public_reply.sources.join("\n"), /openai\/skills\/skills\/\.curated\/imagegen/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("installLocalSkill copies a bounded local skill into the install root", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lobster-install-skill-"));
  const installRoot = path.join(tempRoot, "install");
  const sourceRoot = path.join(tempRoot, "source");

  try {
    await createLocalSkill(sourceRoot, "playwright-cli", "Browser automation skill");
    const installResult = await installLocalSkill({
      query: "playwright",
      discoveryRoots: [installRoot, sourceRoot],
      installRoot,
      remoteCatalogProvider: async () => ({ ok: true, items: [] }),
    });

    assert.equal(installResult.ok, true);
    assert.equal(installResult.action, "install_local_skill");
    assert.match(installResult.public_reply.answer, /已安裝本機 skill/);

    const installedSkill = await readFile(path.join(installRoot, "playwright-cli", "SKILL.md"), "utf8");
    assert.match(installedSkill, /Browser automation skill/);

    const verifyResult = await verifyLocalSkill({
      query: "playwright",
      discoveryRoots: [installRoot, sourceRoot],
      installRoot,
    });
    assert.equal(verifyResult.ok, true);
    assert.equal(verifyResult.action, "verify_local_skill");
    assert.match(verifyResult.public_reply.answer, /目前已安裝/);
    assert.match(verifyResult.public_reply.sources.join("\n"), /SKILL\.md/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("installLocalSkill can install from the curated remote catalog through the bounded installer", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lobster-install-remote-skill-"));
  const installRoot = path.join(tempRoot, "install");
  const sourceRoot = path.join(tempRoot, "source");

  try {
    const result = await installLocalSkill({
      query: "imagegen",
      discoveryRoots: [installRoot, sourceRoot],
      installRoot,
      remoteCatalogProvider: async () => ({
        ok: true,
        items: [
          { name: "imagegen", installed: false },
        ],
      }),
      remoteInstaller: async ({ skillName }) => {
        await createLocalSkill(installRoot, skillName, "Installed from curated remote catalog");
        return { ok: true };
      },
    });

    assert.equal(result.ok, true);
    assert.match(result.public_reply.answer, /curated remote catalog 安裝 skill/);
    assert.match(result.public_reply.sources.join("\n"), /imagegen/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("installLocalSkill returns a readable bounded failure when neither local nor curated remote source matches", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lobster-install-skill-missing-"));
  const installRoot = path.join(tempRoot, "install");
  const sourceRoot = path.join(tempRoot, "source");

  try {
    const result = await installLocalSkill({
      query: "minimax 多模態",
      discoveryRoots: [installRoot, sourceRoot],
      installRoot,
      remoteCatalogProvider: async () => ({
        ok: true,
        items: [
          { name: "imagegen", installed: false },
        ],
      }),
    });

    assert.equal(result.ok, false);
    assert.match(result.public_reply.answer, /只命中語意相近候選/);
    assert.match(result.public_reply.sources.join("\n"), /curated remote catalog/);
    assert.match(result.public_reply.sources.join("\n"), /imagegen/);
    assert.doesNotMatch(result.public_reply.answer, /Error|stack|runtime_exception/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
