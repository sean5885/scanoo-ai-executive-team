# Lobster Improvement Loop

Lobster now treats important failures as upgrade inputs, and those upgrades no longer stop at task-local records.

## Reflection Record

Each important task can produce a reflection record containing:

- task_input
- action_taken
- evidence collected
- verification result
- what_went_wrong
- missing_elements
- routing_quality
- response_quality
- error_type

Reflection records are archived to the executive reflection store before improvement proposals are generated.

## Improvement Proposal Categories

- prompt_improvement
- routing_improvement
- rule_improvement
- verification_improvement
- knowledge_policy_update
- meeting_agent_improvement

## Application Modes

- `auto_apply`
  - low-risk checklist/routing hardening that can be safely applied immediately
- `proposal_only`
  - changes that should be reviewed before adoption
- `human_approval`
  - high-risk governance or policy changes that must be approved first

## Approval Workflow

Improvement proposals now move through a real workflow:

1. reflection is archived
2. improvement proposals are persisted
3. low-risk proposals may `auto_apply`
4. reviewed proposals are exposed through:
   - `GET /agent/improvements`
   - `POST /agent/improvements/:id/approve`
   - `POST /agent/improvements/:id/reject`
   - `POST /agent/improvements/:id/apply`
5. applied improvements are written to approved memory as `improvement_applied`

Task lifecycle only reaches `improved` after proposals are actually applied.

## Learning Memory

Improvement proposals and recurring failure patterns are stored separately from approved knowledge so the system can learn without polluting long-term memory.
