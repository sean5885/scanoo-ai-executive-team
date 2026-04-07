import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCurrentEvolutionMetrics,
  calculateEvolutionMetricsFromEntries,
  summarizeExecutionReflection,
} from "../src/executive-evolution-metrics.mjs";

test("summarizeExecutionReflection counts deviated steps", () => {
  const summary = summarizeExecutionReflection({
    overall_status: "partial_success",
    step_reviews: [
      { deviation: "none" },
      { deviation: "fallback_used" },
      { deviation: "success_criteria_unmet" },
    ],
  });

  assert.deepEqual(summary, {
    overall_status: "partial_success",
    total_steps: 3,
    deviated_steps: 2,
    deviation_rate: 0.6667,
  });
});

test("calculateEvolutionMetricsFromEntries aggregates local rolling rates", () => {
  const current = buildCurrentEvolutionMetrics({
    executionReflection: {
      overall_status: "success_with_deviation",
      step_reviews: [
        { deviation: "fallback_used" },
        { deviation: "none" },
      ],
    },
    improvementTriggered: true,
    retryAttempted: true,
    retrySucceeded: true,
  });

  const metrics = calculateEvolutionMetricsFromEntries([
    {
      execution_reflection_summary: {
        overall_status: "success",
        total_steps: 2,
        deviated_steps: 0,
        deviation_rate: 0,
      },
      improvement_triggered: false,
      retry_attempted: false,
      retry_succeeded: false,
    },
    current,
    {
      execution_reflection_summary: {
        overall_status: "failed",
        total_steps: 1,
        deviated_steps: 1,
        deviation_rate: 1,
      },
      improvement_triggered: true,
      retry_attempted: true,
      retry_succeeded: false,
    },
  ]);

  assert.deepEqual(metrics, {
    window_size: 3,
    reflection_deviation_rate: 0.4,
    reflection_deviation: {
      deviated_steps: 2,
      total_steps: 5,
    },
    improvement_trigger_rate: 0.6667,
    improvement_trigger: {
      triggered_reflections: 2,
      total_reflections: 3,
    },
    retry_success_rate: 0.5,
    retry_success: {
      successful_retries: 1,
      retry_attempts: 2,
    },
  });
});
