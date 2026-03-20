# Deployment

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Confirmed Runtime Shape

This repo is designed for local execution.

This file is the runtime view.
It complements [architecture.md](/Users/seanhan/Documents/Playground/docs/system/architecture.md), which describes module and responsibility structure.

Confirmed from code:

- Node.js HTTP service
- optional Node.js long-connection bot
- local SQLite database
- local filesystem state
- optional Python security wrapper
- OpenClaw plugin talking to local HTTP server

## Runtime Layer vs Architecture Layer

Use this file to answer:

- what process starts
- what command starts it
- what runtime dependency is required
- what external boundary each process crosses
- where runtime state lives

Do not use this file as the main source for:

- module responsibility
- request dispatch structure
- service layer boundaries
- logical data flow inside code

Those belong in [architecture.md](/Users/seanhan/Documents/Playground/docs/system/architecture.md), [modules.md](/Users/seanhan/Documents/Playground/docs/system/modules.md), and [data_flow.md](/Users/seanhan/Documents/Playground/docs/system/data_flow.md).

## Startup Paths

- HTTP only:
  - `npm start`
  - entry: `/Users/seanhan/Documents/Playground/src/http-only.mjs`

- Full mode:
  - `npm run start:full`
  - entry: `/Users/seanhan/Documents/Playground/src/index.mjs`

Operationally, the runtime modes are:

- API runtime
  - local Node process
  - serves HTTP API

- bot runtime
  - same Node process in full mode
  - adds Lark long-connection listener

- plugin runtime
  - OpenClaw process outside this repo
  - calls the local Node HTTP API

- security runtime
  - Python subprocess invoked from Node
  - used only for guarded local actions

Repo-managed local service asset:

- LaunchAgent template
  - `/Users/seanhan/Documents/Playground/config/com.seanhan.lark-kb-http.plist`
  - intended to run `/Users/seanhan/Documents/Playground/src/index.mjs` as the Playground long-connection bot

## Runtime Dependencies

- Node.js
- npm
- Lark app credentials
- optional OpenClaw CLI
- optional OpenAI-compatible API key
- optional Python `faster-whisper` runtime for local meeting transcription
- optional Python 3 for `lobster_security`

More specifically:

- required to boot base service
  - Node.js
  - npm-installed dependencies
  - `LARK_APP_ID`
  - `LARK_APP_SECRET`

- required to use account-backed collaboration features
  - completed user OAuth flow
  - granted Lark scopes matching the feature set

- required only for selected workflows
  - OpenClaw CLI for semantic organization and plugin usage
  - OpenAI-compatible key for answer generation and comment rewrite
  - Python 3 for local guarded actions

## Environment Configuration

Primary env surface is `/Users/seanhan/Documents/Playground/src/config.mjs`.

Key values:

- Lark app credentials
- domain and OAuth callback settings
- OAuth scopes
- token encryption secret
- comment suggestion poller enablement, interval, and watch-file path
- SQLite path
- chunk/search limits
- embedding dimensions and semantic search top-k
- LLM endpoint and model
- meeting audio capture and transcription settings
- semantic classifier provider and OpenClaw settings
- lobster-security paths and approval mode
- lobster-security expected version

## Infra Artifacts Present

- local `.data` runtime state
  - includes the RAG/OAuth SQLite database, lobster_security state, doc replace confirmation store, comment watch state, and comment suggestion watch definitions
  - user OAuth tokens are persisted in SQLite `lark_tokens`, optionally encrypted by `LARK_TOKEN_ENCRYPTION_SECRET`
- Python config files under:
  - `/Users/seanhan/Documents/Playground/lobster_security/config/policy.yaml`
  - `/Users/seanhan/Documents/Playground/lobster_security/config/network_policy.yaml`

## Infra Artifacts Not Found

- Docker
- docker-compose
- Kubernetes manifests
- Terraform
- CI/CD deployment workflow for hosted runtime

## External Service Boundaries

- Lark API
  - source of truth for user content and collaboration objects

- OpenAI-compatible LLM
  - used for answer generation and comment rewrite
  - may also be used for meeting-audio transcription only when explicitly configured as the meeting transcription provider

- local host microphone via `ffmpeg`
  - used only for meeting capture on the same machine that runs the long-connection bot

- local Python `faster-whisper`
  - default meeting-audio transcription path on the same machine that runs the long-connection bot

- OpenClaw runtime
  - used for semantic classification and plugin execution

- Python `lobster_security`
  - local subprocess boundary
  - runtime contract is checked against `lobster_security/pyproject.toml`

## Runtime State Boundaries

- filesystem state
  - `.data/`
  - SQLite-backed OAuth token store
  - SQLite index
  - pending security state

- external state
  - Lark documents, chats, calendars, tasks, bitables, sheets
  - external LLM provider
  - external OpenClaw runtime configuration

The important distinction is:

- architecture layer says the repo has a sync service and answer service
- runtime layer says those services depend on local SQLite plus external Lark and optional LLM/OpenClaw services

## What Cannot Be Claimed From Deployment Files

From this repo alone, we still cannot confirm:

- any hosted staging or production topology
- container-based deployment
- supervised background process manager outside the developer shell
- central secret manager
- multi-machine or multi-user deployment model

## Current Deployment Risks

- no repo-local hosted deployment definition
- comments rewrite and answer quality depend on external model endpoint quality
- OpenClaw presence is assumed for semantic organization workflows
- watched comment suggestion cards depend on local timer polling unless manually triggered by API
- token and runtime state are local, which simplifies setup but still weakens multi-machine portability even after optional token encryption

## Current Local Machine State

Observed on the current Mac after the latest Playground re-cutover work:

- the repo-managed Playground LaunchAgent plist was restored to `~/Library/LaunchAgents/com.seanhan.lark-kb-http.plist`
- `com.seanhan.lark-kb-http` is the active long-connection runtime on this machine
- `src/index.mjs` now runs a startup guard that disables known competing LaunchAgents such as `ai.openclaw.gateway`, `lobster.core`, `lobster.gateway`, and `lobster.worker` before the Playground long-connection listener starts
- `ai.openclaw.gateway` is currently disabled in `launchctl` on this machine to avoid dual-responder drift
- the previous `ai-server` launch agents `lobster.core`, `lobster.gateway`, and `lobster.worker` must stay disabled; if they are re-enabled, they can still answer on the same machine and reintroduce dual-responder drift
- `~/Library/Logs/lark-kb-http.log` confirms `src/index.mjs` is connected through Lark persistent connection

Why this matters:

- Lark message behavior on this machine now comes from `/Users/seanhan/Documents/Playground/src/index.mjs`
- if a competing local responder is re-enabled later, the Playground startup guard now attempts to disable it again before serving Lark traffic
