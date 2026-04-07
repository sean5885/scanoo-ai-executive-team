# Executive Replay Fixtures

This directory contains checked-in, local-only replay specs for
`scripts/executive-evolution-replay.mjs`.

Rules for this pack:

- deterministic inputs only
- bounded text and step counts
- no external side effects
- no live tool replay

Each fixture is a standalone JSON object that can be passed directly to:

```bash
node scripts/executive-evolution-replay.mjs evals/executive-replay/fixtures/<fixture>.json
```

Run the whole checked-in pack with:

```bash
node scripts/executive-evolution-replay-pack.mjs
node scripts/executive-evolution-replay-pack.mjs --json
```
