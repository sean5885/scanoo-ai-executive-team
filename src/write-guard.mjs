function cleanText(value) {
  return String(value || "").trim();
}

function resolveVerifierCompleted({ verifierCompleted = false, verification = null } = {}) {
  if (verifierCompleted === true) {
    return true;
  }
  if (verification === true) {
    return true;
  }
  return verification?.pass === true;
}

export function decideWriteGuard({
  externalWrite = false,
  confirmed = false,
  preview = false,
  mode = "",
  verifierCompleted = false,
  verification = null,
} = {}) {
  const external = externalWrite === true;
  const previewMode = preview === true || cleanText(mode).toLowerCase() === "preview";
  const verificationDone = resolveVerifierCompleted({ verifierCompleted, verification });

  if (!external) {
    return {
      allow: true,
      external_write: false,
      require_confirmation: false,
      reason: "internal_write",
    };
  }

  if (previewMode) {
    return {
      allow: false,
      external_write: true,
      require_confirmation: false,
      reason: "preview_write_blocked",
    };
  }

  if (confirmed !== true) {
    return {
      allow: false,
      external_write: true,
      require_confirmation: true,
      reason: "confirmation_required",
    };
  }

  if (!verificationDone) {
    return {
      allow: false,
      external_write: true,
      require_confirmation: false,
      reason: "verifier_incomplete",
    };
  }

  return {
    allow: true,
    external_write: true,
    require_confirmation: false,
    reason: "allowed",
  };
}
