import test from "node:test";

import {
  resetExecutiveTaskStateStoreForTests,
  restoreExecutiveTaskStateStoreForTests,
  useInMemoryExecutiveTaskStateStoreForTests,
} from "../../src/executive-task-state.mjs";

export function setupExecutiveTaskStateTestHarness() {
  test.before(() => {
    useInMemoryExecutiveTaskStateStoreForTests();
  });

  test.beforeEach(async () => {
    await resetExecutiveTaskStateStoreForTests();
  });

  test.afterEach(async () => {
    await resetExecutiveTaskStateStoreForTests();
  });

  test.after(() => {
    restoreExecutiveTaskStateStoreForTests();
  });
}
