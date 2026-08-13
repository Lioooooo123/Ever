# Ever Long-Horizon Benchmark v1.0.0

Development proxy for multi-stage repository work and semantic recovery. Every task is Docker-isolated, has a hidden verifier, an Oracle solution, explicit capability/safety gates, and versioned resilience scenarios.

Run the author gate first:

```bash
npm run eval -- long-horizon --suite dev --agents oracle
```

Validate all four tasks with three deterministic Oracle repetitions without claiming release calibration:

```bash
npm run eval -- long-horizon --suite full --agents oracle --author-gate
npm run eval -- long-horizon --suite full --agents no-op --author-gate --repetitions 1
```

The Oracle command must pass. The no-op command must exit non-zero with a valid failed objective result for every task.
Audit the separate human release gate with:

```bash
npm run eval -- long-horizon --suite full --agents oracle --audit-calibration
```

Model-backed jobs require the passing Oracle job ID:

```bash
npm run eval -- long-horizon --suite dev --agents ever --agent-config /absolute/path/to/agents.json --oracle-job <job-id> --provider <provider> --model <exact-id> --max-cost-usd 10
```

The resilience lane runs an exactly matched no-fault/fault pair for every scenario. It accepts only the native Ever adapter because generic command agents do not expose durable events:

```bash
npm run eval -- long-horizon --suite dev --lane resilience --agents ever --agent-config /absolute/path/to/agents.json --oracle-job <job-id> --provider <provider> --model <exact-id> --max-cost-usd 20
```

Faults match a persisted event type, fields, and occurrence. Missing triggers invalidate the trial; they are not scored as agent failures.

These tasks are marked `development_proxy`; they are not human-time calibrated benchmark claims.
See `RELEASE_NOTES.md` for benchmark-schema changes. Never merge results across different benchmark versions.
