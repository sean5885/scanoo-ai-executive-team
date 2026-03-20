# Tech Stack

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Languages

- JavaScript (ES modules, Node.js)
- TypeScript
- Python

## Frameworks and SDKs

- `@larksuiteoapi/node-sdk`
  - primary Lark SDK
- built-in Node HTTP server
  - no Express/Fastify detected

## Frontend

- No browser frontend application found in this repo.

## Backend

- Node.js local HTTP service
- Node.js Lark long-connection bot
- Python security wrapper subproject

## Data Storage

- SQLite via `better-sqlite3`
- SQLite FTS5 for search
- local JSON files for token and approval state

## Cache / Queue

- cache:
  - semantic classifier cache in `.data`
- queue:
  - no internal queue framework found
  - Lark async drive task IDs are external async behavior, not an internal queue

## AI and External Services

- Lark / LarkSuite Open APIs
- OpenClaw CLI and OpenClaw plugin runtime
- OpenAI-compatible chat completions endpoint

## Infra and Runtime Tools

- npm
- Node.js
- Python 3 for `lobster_security`
- `ffmpeg` for local meeting audio capture on the host machine
- `faster-whisper` for default local meeting transcription
- local filesystem state under `.data`

## Build / Package Files Found

- `/Users/seanhan/Documents/Playground/package.json`
- `/Users/seanhan/Documents/Playground/package-lock.json`
- `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/package.json`
- `/Users/seanhan/Documents/Playground/openclaw-plugin/lark-kb/tsconfig.json`
- `/Users/seanhan/Documents/Playground/lobster_security/pyproject.toml`

## Not Found

- no `Dockerfile`
- no `docker-compose.yml`
- no `go.mod`
- no `Cargo.toml`
- no `frontend` framework manifest
