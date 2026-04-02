# Dependencies

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Backend Runtime

- `@larksuiteoapi/node-sdk`
  - Lark OAuth, doc, wiki, message, calendar, task, and drive operations

- `better-sqlite3`
  - local persistence and FTS-backed retrieval

- `dotenv`
  - environment variable loading

## AI / Model Integration

- OpenAI-compatible HTTP API
  - used by `answer-service.mjs`
  - used by `doc-comment-rewrite.mjs`

- OpenClaw CLI runtime
  - used by `lark-drive-semantic-classifier.mjs`
  - used as plugin host for `openclaw-plugin/lark-kb`

## Plugin Layer

- local plugin package
  - `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/package.json`
  - minimal package with OpenClaw extension entry

## Python Subproject

- `lobster_security`
  - separate Python package
  - currently no third-party runtime dependencies declared in `pyproject.toml`

## Tooling

- npm / npx
- TypeScript compiler used ad hoc for plugin validation

## Dependency Guardrails

- `/Users/seanhan/Documents/Playground/src/dependency-guardrails.mjs` scans every checked-in `package-lock.json` under the repo and fails when a blocked package version is resolved.
- `/Users/seanhan/Documents/Playground/scripts/dependency-guardrails.mjs` is the operator/CI entry and is exposed as:
  - `npm run check:dependencies`
- current blocked versions are:
  - `axios@1.14.1`
  - `axios@0.30.4`
- these two versions are blocked because of the 2026-03-31 npm maintainer compromise; the repo currently allows other safe axios versions and does not pin axios to a single forever version.
- root runtime currently reaches axios only transitively through `@larksuiteoapi/node-sdk`; `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/package-lock.json` does not currently resolve axios.

## Notes

- There is no large backend framework dependency graph in this repo.
- Most complexity is in product integration and operational flow, not package count.
