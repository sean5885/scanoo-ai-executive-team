import test from "node:test";

import {
  resetExecutiveTaskStateStoreForTests,
  restoreExecutiveTaskStateStoreForTests,
  useInMemoryExecutiveTaskStateStoreForTests,
} from "../../src/executive-task-state.mjs";
import {
  resetExecutiveImprovementWorkflowStoresForTests,
  restoreExecutiveImprovementWorkflowStoresForTests,
  useInMemoryExecutiveImprovementWorkflowStoresForTests,
} from "../../src/executive-improvement-workflow.mjs";
import {
  resetExecutiveMemoryStoresForTests,
  restoreExecutiveMemoryStoresForTests,
  useInMemoryExecutiveMemoryStoresForTests,
} from "../../src/executive-memory.mjs";

export function setupExecutiveTaskStateTestHarness({
  includeImprovementWorkflowStores = false,
  includeExecutiveMemoryStores = false,
} = {}) {
  test.before(() => {
    useInMemoryExecutiveTaskStateStoreForTests();
    if (includeImprovementWorkflowStores) {
      useInMemoryExecutiveImprovementWorkflowStoresForTests();
    }
    if (includeExecutiveMemoryStores) {
      useInMemoryExecutiveMemoryStoresForTests();
    }
  });

  test.beforeEach(async () => {
    await resetExecutiveTaskStateStoreForTests();
    if (includeImprovementWorkflowStores) {
      await resetExecutiveImprovementWorkflowStoresForTests();
    }
    if (includeExecutiveMemoryStores) {
      await resetExecutiveMemoryStoresForTests();
    }
  });

  test.afterEach(async () => {
    await resetExecutiveTaskStateStoreForTests();
    if (includeImprovementWorkflowStores) {
      await resetExecutiveImprovementWorkflowStoresForTests();
    }
    if (includeExecutiveMemoryStores) {
      await resetExecutiveMemoryStoresForTests();
    }
  });

  test.after(() => {
    restoreExecutiveTaskStateStoreForTests();
    if (includeImprovementWorkflowStores) {
      restoreExecutiveImprovementWorkflowStoresForTests();
    }
    if (includeExecutiveMemoryStores) {
      restoreExecutiveMemoryStoresForTests();
    }
  });
}
