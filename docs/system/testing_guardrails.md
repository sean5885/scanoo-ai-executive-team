# Testing Guardrails

1. All test HTTP servers must close and await completion.
   - Required pattern:
     - `t.after(() => new Promise((resolve) => server.close(resolve)))`
   - For timeout / keep-alive sensitive cases:
     - use `server.closeAllConnections?.()` in teardown when needed
     - send `Connection: close` in tests that intentionally exercise timeout behavior

2. Timeout paths must fully clean up runtime resources.
   - Always pair timeout setup with clear/abort handling
   - Abort-driven flows must not leave pending sockets, listeners, or timers alive after response is written

3. No internal write path may bypass admission/confirmation.
   - All production write paths must go through canonical mutation admission
   - Internal direct apply/write helpers are prohibited unless explicitly guarded for non-production use

4. Tests must not rely on shared DB connection state.
   - Avoid cross-file coupling through a single shared DB/proxy
   - Prefer isolated DB lifecycle per test file or explicit reset/setup/teardown boundaries
   - Closed DB should fail soft in monitoring/read paths, but this is not a substitute for isolation
   - `tests/utils/test-db-factory.mjs` now provides a temp-file-backed SQLite factory with explicit `dbPath` and `close()` teardown helpers so tests can bind `RAG_SQLITE_PATH` to a test-owned DB lifecycle, including child-process CLI coverage

## Follow-up

- Rule 4 is not yet fully enforced in runtime/tests and remains a cleanup item; `tests/http-monitoring.test.mjs` now uses a file-scoped temp SQLite path plus teardown close, but several other suites still import the shared `src/db.mjs` singleton directly and need follow-up migration onto isolated test-owned DB setup.
