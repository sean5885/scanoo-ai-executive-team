# Errors

## [ERR-20260312-001] npm_start_port_conflict

**Logged**: 2026-03-12T00:00:00+08:00
**Priority**: medium
**Status**: pending
**Area**: infra

### Summary
Starting the local Lark KB HTTP service can fail because port `3333` is already occupied by an existing Node process from the same workspace.

### Error
```text
Error: listen EADDRINUSE: address already in use :::3333
```

### Context
- Command attempted: `npm start`
- Workspace already had a Node process listening on `127.0.0.1:3333`
- `curl /health` and `curl /api/auth/status` both succeeded against the existing process

### Suggested Fix
Before starting the service, check whether port `3333` is already serving the expected Lark KB API. Reuse the running service when healthy, or stop the old process explicitly before restart.

### Metadata
- Reproducible: yes
- Related Files: src/http-only.mjs, src/http-server.mjs

---
