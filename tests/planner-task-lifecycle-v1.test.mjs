import test from "node:test";
import assert from "node:assert/strict";

import { buildPlannerConversationSummary } from "../src/planner-conversation-memory.mjs";
import {
  buildPlannerLifecycleUnfinishedItems,
  getLatestPlannerTaskLifecycleSnapshot,
  handlePlannerPendingItemAction,
  replacePlannerTaskLifecycleStoreForTests,
} from "../src/planner-task-lifecycle-v1.mjs";
import { setupPlannerTaskLifecycleTestHarness } from "./helpers/planner-task-lifecycle-harness.mjs";

setupPlannerTaskLifecycleTestHarness();

test("planner pending item resolve flow renders mark_resolved and hides resolved items", async () => {
  replacePlannerTaskLifecycleStoreForTests({
    tasks: {
      task_pending_1: {
        id: "task_pending_1",
        scope_key: "scope_pending_1",
        title: "跟進報價單",
        theme: "bd",
        owner: "Alice",
        deadline: "2026-03-28",
        task_state: "planned",
        lifecycle_state: "planned",
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    scopes: {
      scope_pending_1: {
        scope_key: "scope_pending_1",
        theme: "bd",
        selected_action: "search_and_detail_doc",
        user_intent: "整理 BD 文件",
        trace_id: "trace_pending_1",
        source_kind: "search_and_detail",
        source_doc_id: "doc_pending_1",
        source_title: "BD Follow-up Board",
        current_task_ids: ["task_pending_1"],
        created_at: "2026-03-20T00:00:00.000Z",
        updated_at: "2026-03-20T00:00:00.000Z",
      },
    },
    latest_scope_key: "scope_pending_1",
  });

  const snapshotBefore = await getLatestPlannerTaskLifecycleSnapshot();
  const pendingItems = buildPlannerLifecycleUnfinishedItems(snapshotBefore);
  assert.deepEqual(pendingItems, [
    {
      type: "task_lifecycle_v1",
      item_id: "task_pending_1",
      label: "待跟進：跟進報價單",
      status: "pending",
      actions: [
        {
          type: "mark_resolved",
          label: "標記完成",
        },
      ],
    },
  ]);

  const summary = buildPlannerConversationSummary({
    unfinishedItems: pendingItems,
  });
  assert.deepEqual(summary.unfinished_items, pendingItems);

  const resolved = await handlePlannerPendingItemAction({
    itemId: "task_pending_1",
    action: pendingItems[0].actions[0],
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.action, "mark_resolved");
  assert.equal(resolved.data.item_id, "task_pending_1");
  assert.equal(resolved.data.status, "resolved");
  assert.equal(Array.isArray(resolved.data.pending_items), true);
  assert.equal(resolved.data.pending_items.length, 0);

  const snapshotAfter = await getLatestPlannerTaskLifecycleSnapshot();
  assert.equal(snapshotAfter?.tasks?.[0]?.pending_item_status, "resolved");
  assert.match(snapshotAfter?.tasks?.[0]?.pending_item_resolved_at || "", /\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(buildPlannerLifecycleUnfinishedItems(snapshotAfter), []);
});
