"""Project-specific exceptions."""


class SecurityError(Exception):
    """Base class for security wrapper errors."""


class PolicyError(SecurityError):
    """Raised when a policy blocks an action."""


class ApprovalPending(SecurityError):
    """Raised when an approval is required but unavailable."""

    def __init__(self, request_payload):
        super().__init__("approval required")
        self.request_payload = request_payload


class ConfigError(SecurityError):
    """Raised when configuration is invalid."""
