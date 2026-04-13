import test from "node:test";
import assert from "node:assert/strict";
import { dispatchPlannerTool } from "../src/executive-planner.mjs";

test("dispatchPlannerTool backfills account_id from auth context for planner-visible skill action", async () => {
  const withAuth = await dispatchPlannerTool({
    action: "search_and_summarize",
    payload: { q: "healthcheck" },
    authContext: { account_id: "acct_backfill_test" },
  });
  assert.notEqual(withAuth?.error, "contract_violation");

  const withoutAuth = await dispatchPlannerTool({
    action: "search_and_summarize",
    payload: { q: "healthcheck" },
  });
  assert.equal(withoutAuth?.error, "missing_required_account_id");
});
