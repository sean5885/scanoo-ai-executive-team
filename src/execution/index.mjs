import { createEvidencePlaneFacade } from "../evidence/index.mjs";
import { createDecisionCapability } from "./decision.mjs";
import { createDispatchCapability } from "./dispatch.mjs";
import { createRecoveryCapability } from "./recovery.mjs";
import { createFormatterCapability } from "./formatter.mjs";

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
  const decision = createDecisionCapability({
    selector: decisionSelector,
  });
  const dispatch = createDispatchCapability({
    dispatcher,
  });
  const recovery = createRecoveryCapability({
    resolver: recoveryResolver,
  });
  const outputFormatter = createFormatterCapability({
    renderer: formatter,
  });

  return {
    version: EXECUTION_PLANE_VERSION,
    decision,
    dispatch,
    recovery,
    formatter: outputFormatter,
    evidence,
    verifyCapabilityEvidence({
      capability = "",
      evidenceItems = [],
      payload = {},
    } = {}) {
      return evidence.verify({
        capability,
        evidence: evidenceItems,
        ...payload,
      });
    },
  };
}
