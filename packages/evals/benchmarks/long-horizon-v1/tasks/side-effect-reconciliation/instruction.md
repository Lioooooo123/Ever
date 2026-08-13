# Implement safe side-effect reconciliation

Complete the batch processor:

```text
node src/cli.mjs --batch <path> --state <path> --ledger <path>
```

Each item declares `operationId`, `idempotencyKey`, `effect`, and `payload`. Effects are `reconcilable_write` or `external_side_effect`.

Requirements:

- persist one receipt per stable idempotency key before marking an item committed;
- reconcile committed writes on restart without repeating them;
- retry only explicit `known_failed` operations;
- when `ELHB_INTERRUPT_AFTER_COMMIT=<operationId>` is set, exit after the receipt is durable but before completion state is durable, at most once per state directory;
- an interrupted `external_side_effect` must end with terminal state `unknown_outcome` and must not replay;
- reject conflicting reuse of an idempotency key;
- document recovery semantics.

Use only synthetic local files and Node.js built-ins.

For the score-bearing external-effect recovery check, exercise `notify-1` with
`ELHB_INTERRUPT_AFTER_COMMIT=notify-1` and write its ledger to
`/tmp/elhb-agent-effects/external-ledger.jsonl`. The harness waits for the actual
durable `notify-1` receipt at that path before interrupting the Worker.
