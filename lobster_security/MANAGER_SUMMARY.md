# Non-Technical Summary

This project turns `龍蝦` into a locally controlled agent with enterprise-style guardrails.

What it does:

- Restricts the agent to a dedicated workspace
- Blocks access to sensitive folders, keys, browser data, and shell startup files
- Disables internet access by default
- Forces risky actions through an approval gate
- Records what the agent tried to do, with secrets automatically masked
- Creates task snapshots so changes can be reviewed and rolled back

What this means operationally:

- The agent can help inside a controlled project area
- It cannot silently touch personal or system-sensitive data
- It cannot directly browse the internet unless you explicitly allow it
- Every task leaves an audit trail
- If a task goes wrong, changes can be reversed

This is a secure MVP. It is suitable as a local control layer around an agent executor, and it is designed so stricter OS-level sandboxing can be added later without replacing the architecture.
