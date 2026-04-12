# Agent / Skill Healthcheck Audit

You are auditing an AI agent system.

Your goal is NOT to explain code.
Your goal is to evaluate system readiness as a real AI agent.

## Output STRICTLY in this structure:

### 1. Agent Inventory
- list all agents
- describe responsibility of each
- mark overlap / redundancy

### 2. Skill Inventory
- list all skills/tools
- for each:
  - invocation correctness risk (low/medium/high)
  - execution reliability (low/medium/high)
  - missing contract parts

### 3. Routing Quality
- is routing deterministic or fuzzy?
- % of cases likely misrouted
- where routing will fail

### 4. Orchestration Gaps
- missing transitions
- broken continuation paths
- retry loops / deadlocks

### 5. Critical Risks (Top 5)
- what will break in real user usage

### 6. System Score
- Agent maturity (0-100)
- Skill maturity (0-100)
- True agent capability (0-100)

Be brutally honest.
Do NOT be polite.
