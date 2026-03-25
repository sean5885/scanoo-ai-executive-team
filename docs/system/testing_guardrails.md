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
   - `tests/utils/test-db-factory.mjs` now provides:
     - `createTestDb()` for raw temp-file-backed SQLite setup
     - `createTestDbHarness()` for test-owned `RAG_SQLITE_PATH` setup plus runtime DB teardown helpers
   - `tests/**/*.test.mjs` must not import `/Users/seanhan/Documents/Playground/src/db.mjs` directly
   - any test that imports a DB-bound src module must use `createTestDbHarness()` so the suite binds runtime DB access to a temp SQLite path before module load
   - `/Users/seanhan/Documents/Playground/scripts/test-db-guardrails.mjs` enforces both rules and is exposed through:
     - `npm run lint:test-db`
     - `npm run check:test-db-factory`
     - `npm run check:test-db-guardrails`
     - `npm run test:ci`

## Follow-up

- DB-bound test suites now use file-scoped temp SQLite setup through `createTestDbHarness()` and are machine-checked by `scripts/test-db-guardrails.mjs`.
- Shared-state-sensitive tests outside the DB boundary still need intentional handling case by case:
  - file-backed stores such as `executiveImprovementStorePath` should keep snapshot/restore or temp-dir isolation
  - child-process CLI tests should pass the test-owned env through spawned process env
  - env-mutation tests should continue restoring original values in teardown
