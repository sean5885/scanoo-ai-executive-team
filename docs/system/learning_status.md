# Learning Status

Back to [README.md](/Users/seanhan/Documents/Playground/README.md)

## Agent Learning Pipeline

- A minimal company-brain learning pipeline now exists for planner-side use.
- Current runtime anchors:
  - `/Users/seanhan/Documents/Playground/src/company-brain-learning.mjs`
  - `/Users/seanhan/Documents/Playground/src/company-brain-query.mjs`
  - `/Users/seanhan/Documents/Playground/src/rag-repository.mjs`
  - `/Users/seanhan/Documents/Playground/src/db.mjs`
- The current learning store is simplified:
  - SQLite table `company_brain_learning_state`
  - one row per `{ account_id, doc_id }`
  - stores `learning_status`, `structured_summary`, `key_concepts`, `tags`, `notes`, `learned_at`, `updated_at`

## Which Agents Have Learned Documents

- planner-facing company-brain doc queries can now see per-document `learning_state`
- the runtime can actively write that state through bounded agent actions:
  - `ingest_learning_doc`
  - `update_learning_state`

What does exist:

- synced document knowledge in SQLite
- semantic classification cache for drive organization
- simplified learned-document sidecar state for company-brain docs
- agent-facing `learning/ingest` and `learning/state` routes now send their final write hop through `/Users/seanhan/Documents/Playground/src/mutation-runtime.mjs` with `knowledge_write_v1` verification
- `read-runtime.mjs` now also has a derived-authority internal read helper path for learning-state detail/list reads through `/Users/seanhan/Documents/Playground/src/derived-read-authority.mjs`

## Which Agents Have Not Learned Documents

- planner: no separate autonomous learner; it only reads/writes the bounded company-brain learning sidecar
- specialist agents: not present
- company brain: no approval-governed canonical long-term learning layer

## Automation Status

- sync is request-triggered, not a background learning system
- semantic classification is on-demand
- answer generation is still retrieval-time first
- learning ingest/update is request-triggered, not background worker automation
- the current primary system is Playground's request-triggered flow, not ai-server background automation

## Pollution Risk

Observed risks:

- semantic classifier relies on an external OpenClaw session
- comment rewrite replaces full document content, which can amplify prompt or instruction errors
- no canonical knowledge layer exists to separate stable knowledge from raw synced docs
- learning state is not approval-governed memory admission; it is only a planner/query-side sidecar and must not be described as approved company-brain knowledge
- runtime verification on learning writes only proves the sidecar row was durably written; it does not upgrade that row into approved knowledge

## Completion Criteria

- current bounded learning completion is:
  - source doc exists in the verified `company_brain_docs` mirror
  - `ingest_learning_doc` stores structured summary, key concepts, and tags
  - planner-facing search/detail can read `learning_state`
