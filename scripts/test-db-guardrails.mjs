import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const srcDir = path.join(rootDir, "src");
const testsDir = path.join(rootDir, "tests");
const mode = getArgValue("--check") || "all";

if (process.argv.includes("--help")) {
  console.log([
    "Usage:",
    "  node scripts/test-db-guardrails.mjs",
    "  node scripts/test-db-guardrails.mjs --check direct-import",
    "  node scripts/test-db-guardrails.mjs --check factory",
  ].join("\n"));
  process.exit(0);
}

if (!new Set(["all", "direct-import", "factory"]).has(mode)) {
  console.error(`Unsupported --check value: ${mode}`);
  process.exit(1);
}

const srcFiles = walkFiles(srcDir).filter((filePath) => filePath.endsWith(".mjs"));
const srcModuleSet = new Set(srcFiles.map(toRepoPath));
const srcImportGraph = new Map();

for (const filePath of srcFiles) {
  const modulePath = toRepoPath(filePath);
  const resolvedImports = resolveRelativeImports({
    filePath,
    importSpecs: collectRelativeImports(filePath),
  }).filter((candidate) => srcModuleSet.has(candidate));
  srcImportGraph.set(modulePath, resolvedImports);
}

const dbBoundModules = collectDbBoundModules(srcImportGraph);
const testFiles = walkFiles(testsDir).filter((filePath) => filePath.endsWith(".test.mjs"));
const directDbViolations = [];
const missingFactoryViolations = [];
let dbBoundTestCount = 0;

for (const filePath of testFiles) {
  const repoPath = toRepoPath(filePath);
  const source = fs.readFileSync(filePath, "utf8");
  const resolvedImports = resolveRelativeImports({
    filePath,
    importSpecs: collectRelativeImports(filePath),
  });
  const directDbImports = resolvedImports.filter((candidate) => candidate === "src/db.mjs");
  const dbBoundImports = resolvedImports.filter((candidate) => dbBoundModules.has(candidate));

  if (directDbImports.length > 0) {
    directDbViolations.push(repoPath);
  }

  if (dbBoundImports.length > 0) {
    dbBoundTestCount += 1;
    const hasFactoryImport = /test-db-factory\.mjs/.test(source);
    const hasFactoryUsage = /(createTestDb|createTestDbHarness)\s*\(/.test(source);
    if (!hasFactoryImport || !hasFactoryUsage) {
      missingFactoryViolations.push({
        file: repoPath,
        dbBoundImports: [...new Set(dbBoundImports)].sort(),
      });
    }
  }
}

const shouldCheckDirectImport = mode === "all" || mode === "direct-import";
const shouldCheckFactory = mode === "all" || mode === "factory";
const hasFailures = (shouldCheckDirectImport && directDbViolations.length > 0)
  || (shouldCheckFactory && missingFactoryViolations.length > 0);

if (shouldCheckDirectImport && directDbViolations.length > 0) {
  console.error("Direct DB imports in tests are forbidden:");
  for (const file of directDbViolations) {
    console.error(`- ${file}`);
  }
  console.error("Use tests/utils/test-db-factory.mjs instead of importing src/db.mjs from tests.");
}

if (shouldCheckFactory && missingFactoryViolations.length > 0) {
  if (shouldCheckDirectImport && directDbViolations.length > 0) {
    console.error("");
  }
  console.error("DB-bound tests must use tests/utils/test-db-factory.mjs:");
  for (const violation of missingFactoryViolations) {
    console.error(`- ${violation.file}`);
    console.error(`  db-bound imports: ${violation.dbBoundImports.join(", ")}`);
  }
}

if (hasFailures) {
  process.exit(1);
}

console.log(`test-db-guardrails: ok (${dbBoundTestCount} db-bound test files checked, ${dbBoundModules.size} db-bound src modules tracked)`);

function getArgValue(flag = "") {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] || null;
}

function walkFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function toRepoPath(filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function collectRelativeImports(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const importPattern = /(?:import\s*(?:[^"'`]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\))/g;
  const matches = [];
  let match = null;
  while ((match = importPattern.exec(source)) !== null) {
    const specifier = match[1] || match[2];
    if (!specifier || !specifier.startsWith(".")) {
      continue;
    }
    matches.push(specifier);
  }
  return matches;
}

function resolveRelativeImports({ filePath, importSpecs = [] }) {
  const resolved = [];
  for (const specifier of importSpecs) {
    const withExtension = path.resolve(path.dirname(filePath), specifier);
    const candidates = path.extname(withExtension)
      ? [withExtension]
      : [
          `${withExtension}.mjs`,
          `${withExtension}.js`,
          path.join(withExtension, "index.mjs"),
          path.join(withExtension, "index.js"),
        ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      resolved.push(toRepoPath(candidate));
      break;
    }
  }
  return resolved;
}

function collectDbBoundModules(importGraph = new Map()) {
  const dbBound = new Set();
  for (const [modulePath, deps] of importGraph.entries()) {
    if (deps.includes("src/db.mjs")) {
      dbBound.add(modulePath);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [modulePath, deps] of importGraph.entries()) {
      if (dbBound.has(modulePath)) {
        continue;
      }
      if (deps.some((dep) => dbBound.has(dep))) {
        dbBound.add(modulePath);
        changed = true;
      }
    }
  }

  return dbBound;
}
