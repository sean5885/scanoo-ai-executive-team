import test from "node:test";

import {
  resetPlannerTaskLifecycleStoreForTests,
  restorePlannerTaskLifecycleStoreForTests,
  useInMemoryPlannerTaskLifecycleStoreForTests,
} from "../../src/planner-task-lifecycle-v1.mjs";

export function setupPlannerTaskLifecycleTestHarness() {
  test.before(() => {
    useInMemoryPlannerTaskLifecycleStoreForTests();
  });

  test.beforeEach(async () => {
    await resetPlannerTaskLifecycleStoreForTests();
  });

  test.afterEach(async () => {
    await resetPlannerTaskLifecycleStoreForTests();
  });

  test.after(() => {
    restorePlannerTaskLifecycleStoreForTests();
  });
}
