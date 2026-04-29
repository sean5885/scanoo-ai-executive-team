import { getCapabilityContract } from "../contracts/index.mjs";
import { createEvidencePlaneFacade } from "../evidence/index.mjs";

export const EXECUTION_PLANE_VERSION = "execution-plane-skeleton-v1";

export function createExecutionPlaneFacade({
  decisionSelector = null,
  dispatcher = null,
  recoveryResolver = null,
  formatter = null,
  evidenceVerifier = null,
} = {}) {
  const evidence = createEvidencePlaneFacade({
    verifier: evidenceVerifier,
  });

  return {
    version: EXECUTION_PLANE_VERSION,
    decision: {
      contract: getCapabilityContract("decision"),
      select(input = {}) {
        if (typeof decisionSelector === "function") {
          return decisionSelector(input);
        }
        return {
          selected_action: "",
          reason: "execution_plane_selector_not_configured",
          routing_reason: "execution_plane_selector_not_configured",
        };
      },
    },
    dispatch: {
      contract: getCapabilityContract("dispatch"),
      run(input = {}) {
        if (typeof dispatcher === "function") {
          return dispatcher(input);
        }
        return {
          ok: false,
          error: "runtime_exception",
          reason: "execution_plane_dispatcher_not_configured",
        };
      },
    },
    recovery: {
      contract: getCapabilityContract("recovery"),
      resolve(input = {}) {
        if (typeof recoveryResolver === "function") {
          return recoveryResolver(input);
        }
        return {
          next_state: "blocked",
          reason: "execution_plane_recovery_not_configured",
        };
      },
    },
    formatter: {
      contract: getCapabilityContract("formatter"),
      render(input = {}) {
        if (typeof formatter === "function") {
          return formatter(input);
        }
        return input;
      },
    },
    evidence,
  };
}
