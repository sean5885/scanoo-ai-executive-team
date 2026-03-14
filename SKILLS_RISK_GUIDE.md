# Skills Risk Guide

This file is the local operating guide for installed OpenClaw skills in this workspace.

## Default Allowlist

These are reasonable to keep enabled for normal work.

- `find-skills`
- `skill-creator`
- `subagent-driven-development`
- `using-superpowers`
- `copywriting`
- `systematic-debugging`
- `content-strategy`
- `marketing-ideas`
- `social-content`
- `web-design-guidelines`
- `web-quality-audit`
- `code-review`
- `refactor`
- `testing-expert`
- `security-audit`
- `performance-optimization`
- `data-analyst`
- `user-research`
- `competitor-analysis`
- `document-formatter`
- `meeting-notes`
- `xlsx`
- `pptx`
- `git-master`
- `frontend-ui-ux-engineer`
- `growth-hacking`
- `biz-email-writer`

## Use With Review

These are useful, but they should be used intentionally rather than as silent defaults.

- `seo-geo-optimizer`
  - broad content-analysis and optimization skill
  - can generate large SEO-oriented outputs that are easy to over-apply
- `dev-browser`
  - browser automation on real browsing sessions
  - can operate on authenticated pages and scrape session-backed content
- `playwright-cli`
  - can manipulate browser state, cookies, localStorage, sessionStorage, file upload, and arbitrary browser code
- `nano-image-generator`
  - sends prompts and optional reference images to an external image API

## High-Risk / Explicit Approval Recommended

- `agent-tools`
  - installs and uses the `infsh` CLI from an external service
  - requires login
  - can upload local files to external cloud apps

## Why These Are High Risk

### `agent-tools`

Observed triggers in installed skill files:

- installs external CLI via `curl -fsSL https://cli.inference.sh | sh`
- requires `infsh login`
- documents automatic local file upload when a file path is passed

### `playwright-cli`

Observed capabilities in installed skill files:

- cookie read/write
- localStorage and sessionStorage manipulation
- upload local files
- save/load browser auth state
- run arbitrary Playwright code in the browser context

### `dev-browser`

Observed capabilities in installed skill files:

- browser automation with persistent page state
- extension mode on the user's actual Chrome session
- intended use on authenticated sites

### `nano-image-generator`

Observed capabilities in installed skill files:

- calls `generativelanguage.googleapis.com`
- requires an API key
- supports reference image upload to the external image API

## Working Rule

Recommended default behavior:

1. Allow normal text / analysis / writing / formatting skills by default.
2. Review before using browser automation or external-upload skills.
3. Ask before using `agent-tools` on any task involving local files, login, or external cloud execution.
