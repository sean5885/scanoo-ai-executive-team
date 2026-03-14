# Lobster Security Wrapper

`lobster_security` is a security-first local wrapper for AI agents such as Codex/OpenClaw-style executors. The design goal is not "make it work"; it is "make unsafe behavior hard by default".

## MVP

The MVP in this repository ships six enforced modules:

1. `Workspace Sandbox`
2. `Command Policy Engine`
3. `Network Guard + Search Proxy`
4. `Approval Layer`
5. `Audit Log + Secrets Redaction`
6. `Snapshot / Rollback Manager`

All defaults are deny-first:

- Workspace writes are limited to `~/lobster-workspace` and `/tmp/lobster-agent`
- Network is disabled by default
- External HTTP only works through explicit allowlists
- High-risk commands pause for approval or fail closed
- Every task gets a snapshot and JSONL audit trail

## Threat Model

### Assets to protect

- OS credentials and private keys
- Personal documents, downloads, browser sessions
- Shell profiles and persistent startup hooks
- External APIs and network egress
- Workspace integrity

### Threats

- Path traversal such as `../`, symlink escape, case tricks, mount indirection
- Dangerous shell execution such as `sudo`, `rm -rf`, `curl | sh`, daemon installs
- Data exfiltration via unrestricted network calls
- Prompt injection in fetched web content
- Silent bulk changes without audit or rollback
- Secret leakage through stdout, stderr, or logs

### Security posture

- Unknown commands: `approval_required`
- Unknown network destinations: `deny`
- Unknown file targets: `deny`
- Missing approver in `strict` mode: `deny`

## Architecture

```text
agent executor
  -> SecureAgentWrapper.execute_action()
     -> WorkspaceSandbox
     -> CommandPolicyEngine
     -> NetworkGuard
     -> ApprovalHandler
     -> AuditLogger
     -> SnapshotManager
     -> optional SearchProxyService
```

## Project Structure

```text
lobster_security/
├── .env.example
├── README.md
├── pyproject.toml
├── config/
│   ├── network_policy.yaml
│   └── policy.yaml
├── lobster_security/
│   ├── __init__.py
│   ├── approval.py
│   ├── audit.py
│   ├── cli.py
│   ├── command_policy.py
│   ├── config_loader.py
│   ├── errors.py
│   ├── models.py
│   ├── network_guard.py
│   ├── search_proxy.py
│   ├── snapshot.py
│   ├── workspace.py
│   ├── wrapper.py
│   └── yamlish.py
└── tests/
    ├── test_audit.py
    ├── test_command_policy.py
    ├── test_network_guard.py
    ├── test_snapshot.py
    ├── test_workspace.py
    └── test_wrapper.py
```

## Config

The system reads:

- [policy.yaml](/Users/seanhan/Documents/Playground/lobster_security/config/policy.yaml)
- [network_policy.yaml](/Users/seanhan/Documents/Playground/lobster_security/config/network_policy.yaml)

The loader intentionally uses a limited YAML subset parser to avoid installing external parsers in the MVP.

## Core APIs

### Workspace Sandbox

- `validate_read_path(path)`
- `validate_write_path(path)`

### Command Policy

- `classify_command(command)`
- `evaluate_command(command, context)`
- `explain_decision(result)`

### Network Guard

- `validate_url(url)`
- `validate_domain(hostname)`
- `guard_http_request(request)`

### Snapshot / Rollback

- `create_snapshot()`
- `diff_snapshot()`
- `rollback_snapshot(task_id)`

## Search Proxy API

Start it:

```bash
cd /Users/seanhan/Documents/Playground/lobster_security
python3 -m lobster_security.cli --config-dir ./config serve-proxy
```

Routes:

- `POST /search`
- `POST /fetch`

Example:

```bash
curl -sS http://127.0.0.1:8787/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"incident response"}'
```

By default the search backend is disabled. For production, point it at your controlled internal search service and keep outbound allowlists tight.

## Codex / Agent Integration

The integration point is [wrapper.py](/Users/seanhan/Documents/Playground/lobster_security/lobster_security/wrapper.py).

The wrapper expects action envelopes like:

```json
{"type":"read_file","path":"notes/todo.md"}
{"type":"write_file","path":"notes/todo.md","content":"updated"}
{"type":"command","command":"python3 -m unittest","cwd":"~/lobster-workspace/project"}
{"type":"search","query":"how to rotate certs"}
{"type":"fetch","url":"https://open.larksuite.com/"}
```

Every action is checked before execution. In `strict` mode, approval-required actions fail closed unless an explicit callback approves them.

## CLI

```bash
cd /Users/seanhan/Documents/Playground/lobster_security
python3 -m lobster_security.cli --config-dir ./config start-task --name "harden-agent"
python3 -m lobster_security.cli --config-dir ./config run-action --task-id <task_id> --action-json '{"type":"read_file","path":"README.md"}'
python3 -m lobster_security.cli --config-dir ./config finish-task --task-id <task_id> --success
python3 -m lobster_security.cli --config-dir ./config rollback --task-id <task_id> --dry-run
```

## Audit and Rollback

- Audit logs are JSONL under `~/lobster-workspace/.lobster-security/audit`
- Snapshots are under `~/lobster-workspace/.lobster-security/snapshots`
- Every task starts with a pre-change snapshot
- End-of-task diff shows `added`, `changed`, and `deleted`
- Rollback supports preview mode with `dry_run=true`

## Extension Path

### MVP shipped here

- Local workspace/file guard
- Command classification
- Network allowlist enforcement
- Approval hooks
- JSONL audit logs with secret redaction
- Snapshot/rollback
- Search Proxy skeleton with secure fetch sanitization

### Recommended next hardening steps

1. Replace shell execution with a syscall-level executor or container runtime
2. Add OS-specific process sandboxing (`sandbox-exec`, `bwrap`, container profile)
3. Replace token files with Keychain/libsecret integration
4. Add signed policy bundles and policy checksum verification
5. Add immutable append-only audit sink
6. Add content DLP classifiers before any outbound send

## Management Summary

See [MANAGER_SUMMARY.md](/Users/seanhan/Documents/Playground/lobster_security/MANAGER_SUMMARY.md).
