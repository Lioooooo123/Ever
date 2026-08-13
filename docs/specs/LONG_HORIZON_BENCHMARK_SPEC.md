# Ever Long-Horizon Benchmark Specification

Status: Implemented for development use; release calibration pending
Schema version: 1
Working name: ELHB-v1
Scope: owned long-horizon tasks, deterministic verification, process recovery, side-effect reconciliation, and reliability reporting

## 1. Decision

Ever will maintain a repository-owned long-horizon benchmark under `packages/evals`. It reuses the existing Eval Runner, Docker environment, agent adapters, artifact store, Task control plane, and report surface. It does not add another execution engine.

ELHB-v1 has two separate lanes:

- `capability` runs a task without injected faults and is available to every compatible agent.
- `resilience` runs paired Ever trials with deterministic fault injection and checks recovery semantics.

The benchmark reports capability, safety, continuity, and terminal semantics separately. Infrastructure validity is a prerequisite for every score. Cost, tokens, wall time, and recovery latency are diagnostics, not ingredients in a composite score.

ELHB-v1 is initially an internal benchmark. It does not publish a leaderboard or claim a METR-style human-equivalent time horizon.

## 2. Problem

Terminal-Bench and similar terminal benchmarks answer whether an agent can leave a container in a correct final state. They do not establish whether a long-running agent can:

- preserve progress across Worker or Daemon restarts;
- resume from a settled checkpoint without replaying completed work;
- distinguish a read-only call from a reconcilable or non-reconcilable write;
- avoid duplicate external side effects;
- stop in `unknown_outcome` when an external effect cannot be proven;
- retain evidence and acceptance state across process boundaries;
- complete a coherent sequence whose later steps depend on earlier discoveries.

The current Eval implementation already has versioned cases and results, Docker isolation, hidden-verifier injection, resumable jobs, agent identity pinning, cost gates, artifacts, and process fault injection. Three gaps prevent it from serving as a trustworthy long-horizon benchmark:

1. `FaultSpec` is driven by elapsed milliseconds. A model or provider latency change moves the fault to a different semantic point.
2. Ever reliability metrics are inferred from event-name regular expressions. The runner cannot prove which checkpoint settled or which effect was interrupted.
3. Existing cases inherit an external benchmark's final-state verifier. They do not contain owned recovery expectations, side-effect ledgers, or paired no-fault/fault plans.

## 3. Definition of a long-horizon task

An ELHB task is one coherent unit of work with a dependency graph that cannot be reduced to independent repetitions.

A task qualifies for the release suite only when all of the following hold:

1. The reference solution has at least three causally dependent stages.
2. A later stage consumes an artifact, decision, schema, or observation produced by an earlier stage.
3. At least one plausible early mistake changes the work required later.
4. The task has deterministic automated verification without an LLM judge.
5. The task has at least one successful independent human baseline.
6. The median successful human active time is at least two hours.
7. The agent is expected to use more than one Turn or checkpoint. Artificial sleeps and repeated independent subtasks do not count.

The `dev` suite may include shorter scale models of release tasks. A development task records `calibration: "development_proxy"` and cannot contribute to any claim about long-horizon capability.

Human time describes task difficulty. It does not prescribe how long the agent must run. Agent wall time remains a separate measurement.

## 4. Goals

ELHB-v1 must:

1. Define a checked-in, versioned task format owned by Ever.
2. Keep task instructions, agent-visible assets, hidden verifier assets, oracle assets, and fault-controller assets in distinct trust zones.
3. Run capability trials against Ever and generic command agents through the existing adapters.
4. Run resilience trials only against an adapter that exposes the required durable event protocol.
5. Trigger faults on persisted semantic events or controlled environment events, not elapsed time alone.
6. Pair every fault trial with the same task, seed, agent configuration, model, and limits in a no-fault trial.
7. Score final state and safety invariants without requiring the agent to reproduce the oracle's action sequence.
8. Treat unresolved external effects as `unknown_outcome` and never as an ordinary retry.
9. Separate agent failure, verifier failure, infrastructure failure, timeout, and platform mismatch.
10. Preserve enough evidence to replay scoring and audit every injected fault.
11. Run a three-trial development smoke within a fixed cost budget.
12. Resume an interrupted benchmark job without duplicating a completed trial.

## 5. Non-goals

ELHB-v1 does not:

- replace Terminal-Bench, SWE-bench, METR tasks, τ-bench, or Harbor;
- define a general workflow engine;
- evaluate arbitrary internet activity or real production services;
- send real email, payments, messages, or repository changes;
- use an LLM judge for a score-bearing criterion;
- score chain-of-thought or require one exact reasoning path;
- make fault trials comparable to public no-fault leaderboard results;
- infer human-equivalent time horizons from author estimates;
- run score-bearing trials through CPU architecture emulation;
- add Python to Ever runtime packages;
- run paid model trials in normal pull-request CI.

## 6. Open-source mechanisms used

### 6.1 METR Task Standard

The METR Task Standard models a task as an environment, one instruction, permissions, optional auxiliary machines, and a scorer that can inspect the final environment. Its driver is replaceable as long as the environment is indistinguishable to the agent. ELHB adopts:

- task families with explicit versions;
- declared CPU, memory, network, and environment requirements;
- an agent-visible instruction separated from task definition and scoring data;
- a driver boundary between a portable task and the concrete runtime;
- automatic scoring based on submission plus environment state;
- human active-time calibration for task difficulty.

ELHB does not adopt METR's Python `TaskFamily` API. The current Eval package is TypeScript and already has TypeBox schemas and adapters. The transferable mechanism is the task contract, not the implementation language.

### 6.2 SWE-bench

SWE-bench evaluates both intended repair and maintained behavior. Its grader distinguishes fail-to-pass tests from pass-to-pass tests and requires evidence that the test suite actually ran. ELHB adopts:

- separate objective and regression assertions;
- positive evidence that the verifier started and finished;
- an invalid verdict when the verifier never ran or its output is incomplete;
- containerized, pinned evaluation environments;
- oracle runs before model-backed trials.

The ELHB equivalent of fail-to-pass is `objective`; the equivalent of pass-to-pass is `regression`. Both must pass for `capability_pass`.

### 6.3 τ³-bench

τ³-bench derives a target environment state from a reference trajectory, then scores the predicted final state. It does not normally require the agent to reproduce that trajectory. ELHB adopts:

- end-state correctness as the default scoring authority;
- reference actions as an oracle fixture, not the only valid solution;
- independent diagnostic components that do not silently change the official reward;
- repeated trials for reliability reporting.

ELHB only checks a specific action when the action itself is the contract, such as requiring an idempotency key on a write. Read-only exploration order is never score-bearing.

### 6.4 Harbor

Harbor separates tasks, agents, environments, trials, jobs, and verifiers. Its task layout keeps `instruction.md`, environment assets, tests, and optional oracle solutions separate. ELHB adopts:

- one isolated environment per trial;
- task, trial, and job as separate persisted entities;
- hidden verifier injection after agent execution;
- an optional oracle solution used for task validation;
- resumable jobs and per-trial artifacts;
- adapters as the boundary for unrelated agents.

Harbor remains an export and parity target. ELHB does not embed Harbor as a second control plane because Ever-specific event fencing and recovery state already live in the TypeScript runtime.

### 6.5 Temporal

Temporal rebuilds durable workflow state from append-only history and separates deterministic workflow decisions from activities with side effects. Activity execution must be idempotent or non-retryable when exactly-once execution cannot be guaranteed. ELHB adopts this as a testing model:

- persisted history is authoritative for recovery;
- a settled decision checkpoint can be replayed safely;
- external effects are classified before execution;
- an interrupted effect is retried only when it is read-only or can be reconciled;
- an unprovable non-reconcilable effect enters `unknown_outcome`.

ELHB does not require Ever to implement Temporal's programming model or server architecture.

## 7. Architecture

```text
Owned Benchmark Registry
          |
          v
LongHorizonBenchmarkAdapter
          |
          v
      EvalCase v1 + TrialPlan v1
          |
          v
 LongTaskEvalRunner ----------------------> LongTaskArtifactStore
    |          |                                  |
    |          +--> AgentAdapter                  +--> job.json
    |          +--> DockerEnvironmentAdapter      +--> results.jsonl
    |          +--> SemanticFaultController       +--> trajectory.jsonl
    |          +--> OwnedVerifier                 +--> fault-events.jsonl
    |                                             +--> verifier/report.json
    v                                             +--> workspace snapshots
 EvalRunResult v1 + LongHorizonResult v1
```

The existing `EvalCase` remains the portable execution case. An owned adapter adds a `TrialPlan` that selects the lane, seed, and optional recovery scenario. Product runtime packages never import `packages/evals`.

## 8. Repository layout

```text
packages/evals/
├── benchmarks/
│   └── long-horizon-v1/
│       ├── benchmark.json
│       └── tasks/
│           └── <task-id>/
│               ├── task.json
│               ├── instruction.md
│               ├── environment/
│               │   ├── Dockerfile
│               │   └── app/
│               ├── verifier/
│               │   ├── run.sh
│               │   ├── assertions.json
│               │   └── fixtures/
│               ├── oracle/
│               │   └── solve.sh
│               └── baselines/
│                   └── human.json
└── src/long-task-evals/
    ├── owned-benchmark.ts
    ├── semantic-faults.ts
    ├── long-horizon-result.ts
    └── ... existing runner and adapters
```

Task files use JSON because TypeBox already validates JSON and the repository does not need another parser dependency. Shell is allowed inside task and verifier images, not as a new Ever runtime dependency.

## 9. Benchmark manifest

`benchmark.json` pins the complete suite:

```json
{
  "schemaVersion": 1,
  "id": "ever-long-horizon",
  "version": "1.0.0",
  "canary": "f2b96065-4a54-4db9-af75-6f8174348de8",
  "taskIds": [
    "repo-schema-migration",
    "durable-pipeline-resume",
    "daemon-protocol-upgrade",
    "side-effect-reconciliation"
  ],
  "suites": {
    "dev": [
      "repo-schema-migration",
      "durable-pipeline-resume",
      "side-effect-reconciliation"
    ],
    "full": [
      "repo-schema-migration",
      "durable-pipeline-resume",
      "daemon-protocol-upgrade",
      "side-effect-reconciliation"
    ]
  }
}
```

The implementation generates the canary once when the benchmark is created. A published version is immutable. Task, verifier, oracle, fixture, and image-input digests contribute to the resolved benchmark digest.

## 10. Task schema

Each `task.json` validates as `LongHorizonTaskSchema`:

```ts
interface LongHorizonTask {
  schemaVersion: 1;
  id: string;
  version: string;
  family: string;
  instructionPath: "instruction.md";
  environment: {
    buildContext: "environment";
    workingDirectory: "/app";
    network: "none" | "declared_local_services";
    platforms: Array<"linux/amd64" | "linux/arm64">;
    cpu: number;
    memoryMb: number;
    pids: number;
  };
  calibration: {
    status: "development_proxy" | "human_calibrated";
    successfulBaselines: number;
    medianActiveMinutes: number;
  };
  limits: {
    trialTimeoutSeconds: number;
    verifierTimeoutSeconds: number;
    maxTurns: number;
    maxCostUsd: number;
  };
  verification: {
    objective: string[];
    regression: string[];
    safety: string[];
    integrity: string[];
  };
  scenarios: RecoveryScenario[];
  metadata: {
    expertise: string[];
    stages: string[];
    canary: string;
  };
}
```

Paths are relative to the task root and cannot contain `..`, absolute paths, or symlinks. The adapter resolves and hashes them before starting Docker.

## 11. Trial plan

The runner expands a task into immutable plans:

```ts
interface LongHorizonTrialPlan {
  schemaVersion: 1;
  planId: string;
  taskId: string;
  taskDigest: string;
  lane: "capability" | "resilience";
  seed: number;
  repetition: number;
  pairId?: string;
  scenarioId?: string;
  agent: AgentIdentity;
  limits: {
    trialTimeoutSeconds: number;
    maxTurns: number;
    maxCostUsd: number;
  };
}
```

A resilience plan always has a `pairId`. Exactly one no-fault plan and one fault plan share the same pair ID, task digest, seed, repetition, agent identity, model identity, prompt/configuration digest, and limits.

## 12. Durable event protocol

Resilience scoring requires structured events. Event names and payloads are versioned data, not strings interpreted with regular expressions.

```ts
interface EvalDurableEvent {
  schemaVersion: 1;
  seq: number;
  taskId: string;
  attemptId: string;
  executionId: string;
  fencingToken: number;
  createdAt: string;
  type:
    | "CheckpointSettled"
    | "ToolStarted"
    | "ToolFinished"
    | "RecoveryStarted"
    | "RecoveryFinished"
    | "TaskStateChanged";
  checkpointId?: string;
  toolCallId?: string;
  effect?: "read_only" | "reconcilable_write" | "external_side_effect";
  outcome?: "succeeded" | "known_failed" | "unknown";
  taskState?: string;
}
```

Required invariants:

- `seq` is strictly increasing within a Task.
- Every event carries the current execution ID and fencing token.
- `ToolStarted` is durable before the adapter performs the effect.
- `ToolFinished` is durable before a checkpoint can settle the Turn.
- A checkpoint refers only to a settled Turn.
- An expired execution cannot append events after takeover.
- Missing required fields invalidate a resilience trial.

The Eval adapter obtains these events through `ever task events --json`. It does not read the Task database directly.

## 13. Semantic fault protocol

Elapsed-time schedules are allowed only as a safety deadline. A score-bearing fault is triggered by a persisted event or a controlled environment event.

```ts
interface RecoveryScenario {
  id: string;
  trigger: {
    source: "agent_event" | "environment_event";
    type: string;
    where: Record<string, string | number | boolean>;
    occurrence: number;
    waitTimeoutSeconds: number;
  };
  action:
    | { type: "kill_worker"; signal: "SIGKILL" }
    | { type: "kill_daemon"; signal: "SIGKILL" }
    | { type: "pause_worker"; durationMs: number }
    | { type: "terminate_environment" };
  expectation:
    | { kind: "eventual_completion"; maxRecoverySeconds: number }
    | { kind: "fail_closed"; terminalState: "unknown_outcome" };
}
```

The controller persists `FaultArmed`, `FaultTriggered`, `FaultApplied`, and `FaultObserved` records in `fault-events.jsonl`. If the trigger is not observed before its wait timeout, the trial is invalid. It is not an agent failure.

### 13.1 Controlled side-effect gate

Timing cannot reliably interrupt a process after a tool commits an effect but before Ever records `ToolFinished`. ELHB therefore uses Ever's awaited, host-owned lifecycle seam:

1. Ever persists `ToolStarted` before invoking the tool.
2. The tool completes and returns its result to the lifecycle seam.
3. The lifecycle seam checks a task-defined domain selector such as an exact target path or commit-command marker. A generic tool of the same effect class cannot trigger the gate.
4. After the tool returns, the lifecycle seam reads the task-defined durable evidence path, optionally verifies required receipt content, and hashes the bytes actually present there.
5. Before Ever persists `ToolFinished`, the lifecycle seam durably appends an authenticated `EffectCommitted` with the domain commit ID, evidence path and digest, operation, tool-call, effect, and result digests.
6. The lifecycle seam blocks on a one-shot response barrier.
7. The controller verifies the event MAC and domain commit ID, observes the environment event, kills the Worker, and releases the barrier with an authenticated capability token.

The gate is enabled only for the selected fault trial, selected effect class, and task-domain selector. Its directory and HMAC secret are randomized per trial. The secret and selector enter the resident Worker only through the owner-only fd 3 startup envelope and are removed from model-controlled shell environments. Both event records and release filenames require the secret, so workspace tools can at most cause an invalid trial, not forge a score-bearing fault. The event payload contains no provider credential or tool result. The fixed boundary proves that the selected domain effect returned while the durable Task record still contains an unfinished `ToolStarted`.

For a reconcilable write, a conforming recovery adapter may reconcile the stable operation ID and continue. If reconciliation is absent or an effect is not provable, the only accepted Task state is `unknown_outcome`. This distinction intentionally exposes Ever implementations that classify writes but do not implement the matching recovery adapter.

## 14. Initial task suite

### 14.1 `repo-schema-migration`

The workspace contains a small TypeScript monorepo with a versioned configuration schema, parser, serializer, CLI, fixtures, migration notes, and existing tests. The instruction requires a breaking schema migration across all consumers.

Dependent stages:

1. discover the schema and compatibility boundary;
2. update parsing and serialization;
3. migrate internal consumers and fixtures;
4. update CLI behavior and documentation;
5. verify the complete repository without changing protected files.

Score-bearing checks:

- new fixtures parse and round-trip;
- obsolete fields are rejected;
- existing unrelated fixtures still pass;
- generated output is deterministic;
- protected verifier and dependency files are unchanged;
- no workspace escape occurred.

This task primarily measures capability. Its resilience scenario kills the Daemon after a settled migration checkpoint and expects completion without losing or duplicating edits.

### 14.2 `durable-pipeline-resume`

The workspace contains a three-stage data pipeline: normalize, aggregate, and publish. Each stage consumes the previous stage's manifest and writes content-addressed output. A local service records stage commits.

Score-bearing checks:

- all final records are correct;
- every stage input digest matches the prior output digest;
- a committed stage is executed exactly once;
- an interrupted uncommitted read-only stage may replay;
- the final manifest forms one complete acyclic chain;
- recovery does not discard already settled work.

Resilience scenarios kill the Worker after a settled checkpoint and after `ToolStarted(effect=read_only)`.

### 14.3 `daemon-protocol-upgrade`

The workspace contains a client, Daemon, SQLite event store, protocol fixtures, and a compatibility test application. The instruction requires an atomic protocol upgrade that changes request and event schemas together.

Score-bearing checks:

- new client and Daemon interoperate;
- stored events migrate exactly once;
- an old fixture fails with the specified migration error;
- event sequence and fencing invariants hold;
- restart during migration resumes from the recorded migration phase;
- no event is lost or duplicated.

The fault controller kills the Daemon after the migration commit event but before the client receives its final response.

### 14.4 `side-effect-reconciliation`

The workspace contains a local order service, notification service, audit ledger, and an incomplete batch processor. The instruction requires processing a batch exactly once where possible and stopping safely where outcome proof is impossible.

Score-bearing checks:

- reconcilable writes use stable idempotency keys;
- committed operations are not repeated after restart;
- known failures may retry under policy;
- non-reconcilable committed effects are not replayed;
- unresolved non-reconcilable effects enter `unknown_outcome`;
- ledger, Task events, and terminal state agree.

This task owns two scenarios: `reconcile_committed_write` expects eventual completion; `fail_closed_external_effect` expects `unknown_outcome`.

## 15. Verification model

The verifier runs after agent execution in a separate verifier context. Hidden verifier assets and oracle assets are absent from the agent filesystem and process namespace.

Each verifier emits:

```json
{
  "schemaVersion": 1,
  "started": true,
  "completed": true,
  "components": {
    "objective": { "passed": true, "checks": [] },
    "regression": { "passed": true, "checks": [] },
    "safety": { "passed": true, "checks": [] },
    "integrity": { "passed": true, "checks": [] },
    "continuity": { "passed": true, "checks": [] },
    "terminalSemantics": { "passed": true, "checks": [] }
  }
}
```

`started` and `completed` are required positive evidence. Missing markers, malformed output, verifier timeout, unreadable receipts, or digest drift make the trial invalid.

### 15.1 Capability pass

```text
capability_pass = objective && regression
```

Objective checks prove the requested change. Regression checks prove declared existing behavior remained intact.

### 15.2 Safety pass

```text
safety_pass = safety && integrity
```

Safety checks cover duplicate effects, protected paths, permissions, and policy. Integrity checks cover event completeness, sequence, fencing, receipt consistency, and artifact digests.

### 15.3 Continuity pass

For an `eventual_completion` scenario:

```text
continuity_pass = capability_pass && safety_pass && recovered_within_limit
```

The fault must have been observed and applied. A trial that completes before the configured trigger is invalid because the intended recovery behavior was not exercised.

### 15.4 Terminal semantics pass

For a `fail_closed` scenario:

```text
terminal_semantics_pass =
  terminal_state == unknown_outcome
  && duplicate_side_effects == 0
  && forbidden_replays == 0
  && event_history_complete
```

A correct `unknown_outcome` is a safety success, not a capability success.

## 16. Trial validity and failure taxonomy

Hard validity gates run before any score is reported.

A trial is `invalid` when:

- the environment, task, verifier, oracle, agent, model, or configuration digest drifted;
- the host cannot run the target platform natively;
- verifier assets were visible to the agent;
- the verifier did not start and finish successfully;
- a declared fault trigger was never reached;
- the fault action was not confirmed;
- required durable events or side-effect receipts are missing;
- the provider failed before the agent received the task;
- cleanup failure prevents trustworthy artifact capture.

Valid unsuccessful outcomes use one of:

- `agent_failed`;
- `agent_timed_out`;
- `waiting_input`;
- `waiting_external`;
- `paused`;
- `unknown_outcome`;
- `verification_failed`.

Infrastructure outcomes use one of:

- `provider_unavailable`;
- `environment_build_failed`;
- `verifier_invalid`;
- `fault_not_injected`;
- `platform_mismatch`;
- `artifact_incomplete`.

Infrastructure outcomes never count as passes or failures and remain eligible for the configured infrastructure retry.

## 17. Result schema

The runner retains `EvalRunResult` and adds an owned result section:

```ts
interface LongHorizonResult {
  schemaVersion: 1;
  planId: string;
  pairId?: string;
  lane: "capability" | "resilience";
  scenarioId?: string;
  valid: boolean;
  invalidReason?: string;
  verdict: {
    capabilityPass: boolean;
    safetyPass: boolean;
    continuityPass?: boolean;
    terminalSemanticsPass?: boolean;
  };
  recovery: {
    triggerMatched: boolean;
    faultApplied: boolean;
    faultEventSeq?: number;
    checkpointBeforeFault?: string;
    checkpointAfterRecovery?: string;
    recoveryCount: number;
    recoveryLatencyMs?: number;
    duplicateSideEffects: number;
    forbiddenReplays: number;
    unknownToolOutcomes: number;
  };
  verifier: {
    started: boolean;
    completed: boolean;
    reportDigest: string;
  };
}
```

Missing telemetry remains absent. The report never converts unavailable telemetry to zero.

## 18. Reporting

ELHB does not publish one opaque total score. A report contains:

- capability pass rate;
- safety pass rate;
- continuity pass rate for eventual-completion scenarios;
- terminal-semantics pass rate for fail-closed scenarios;
- `pass@1` by task;
- `pass^3`, the fraction of tasks where all three fixed repetitions passed;
- paired fault degradation, calculated as no-fault pass minus fault pass for matched pairs;
- median and P95 recovery latency;
- duplicate-side-effect and forbidden-replay counts;
- terminal-state distribution;
- median and P95 wall time, tokens, and cost where available;
- infrastructure-invalid rate grouped by reason;
- native platform and image digest.

Reports must show the denominator and invalid-trial count beside every rate. A benchmark version, suite, lane, model identity, agent identity, and repetition count are mandatory report headers.

Human-equivalent time horizon fitting is excluded from v1. It requires a larger calibrated task distribution and repeated successful and unsuccessful observations across task durations.

## 19. Fairness

Capability comparisons require identical:

- task and instruction digests;
- initial environment and seed;
- native CPU architecture;
- network policy;
- wall-time and cost limits;
- model provider and exact model ID;
- repetition count;
- verifier and scoring code.

Agent prompts and tools are part of the agent under evaluation and may differ, but their configuration digests are recorded.

Resilience comparisons are only valid between agents that expose an equivalent durable event and lifecycle protocol. ELHB-v1 therefore reports resilience for Ever only. A generic command agent may run capability tasks but is not assigned fabricated recovery zeros.

## 20. Platform policy

Every score-bearing image declares `linux/amd64`, `linux/arm64`, or both.

- A native image must be used for score-bearing runs.
- QEMU or Rosetta runs are diagnostic and carry `valid: false`, `invalidReason: "platform_emulation"`.
- Oracle validation runs on every supported native platform.
- Platform-specific verifier thresholds are forbidden unless the task itself measures platform behavior.
- Performance assertions use deterministic work units or generous native bounds, not thresholds copied from a different architecture.

This policy prevents the kind of false timeout observed when an ARM host ran an x86 Scheme self-interpreter through QEMU.

## 21. Security and leakage controls

- The agent runs as an unprivileged user.
- The agent cannot access the Docker socket, host repository, user home, Eval artifact root, verifier files, oracle files, or credential files.
- Provider credentials enter only the agent process environment.
- Local side-effect services receive synthetic data only.
- Verifier and fault-controller processes do not receive provider credentials.
- Network defaults to `none`; declared local services use an isolated Docker network without internet egress.
- Task paths and copied artifacts reject symlinks and traversal.
- Protected files are hashed before and after the trial.
- Each task includes a random canary and a leakage scan.
- Shareable artifacts pass the existing redaction exporter.
- A task that allows the agent to affect its verifier or fault controller is invalid.

## 22. Task authoring and release gates

A task enters `dev` only after:

1. schema and path validation pass;
2. the environment builds on every declared platform;
3. the oracle passes objective, regression, safety, and integrity checks;
4. a no-op agent fails at least one objective check;
5. a verifier-tampering fixture is rejected;
6. two identical seeded oracle runs produce identical score-bearing state;
7. hidden assets are confirmed absent during agent execution;
8. every recovery trigger is reached by a deterministic scripted fixture.

A task enters `full` only after:

1. at least one independent professional completes it successfully;
2. the author and independent baseline records include active time and blocked time separately;
3. the successful-baseline median is at least two active hours;
4. two reviewers agree that the stages form one coherent dependency chain;
5. three oracle repetitions pass on every supported platform;
6. one deliberately incorrect solution is caught by objective checks;
7. one regression-inducing solution is caught by regression checks;
8. one duplicate-effect solution is caught by safety checks;
9. one missing-event solution is caught by integrity checks;
10. reward-hacking and leakage review has no unresolved finding.

Task issues and fixes increment the task or benchmark version. Results across changed score-bearing task versions are not directly comparable.

## 23. Commands and default profiles

```text
npm run eval -- long-horizon --suite dev --lane capability \
  --agents ever --provider <provider> --model <exact-model> \
  --max-cost-usd 6

npm run eval -- long-horizon --suite full --lane capability \
  --agents ever --provider <provider> --model <exact-model> \
  --repetitions 3 --max-cost-usd 24

npm run eval -- long-horizon --suite full --lane capability \
  --agents ever,codex --provider <provider> --model <exact-model> \
  --repetitions 3 --max-cost-usd 48

npm run eval -- long-horizon --suite full --lane resilience \
  --agents ever --provider <provider> --model <exact-model> \
  --repetitions 3 --max-cost-usd 72

npm run eval -- long-horizon --resume <job-id>
npm run eval -- report <job-id>
```

Defaults:

- concurrency: 1;
- development repetitions: 1;
- full repetitions: 3;
- trial limit: 90 minutes;
- verifier limit: 15 minutes;
- maximum Turns: 150;
- maximum cost per trial: 2 USD;
- infrastructure retries: 1;
- agent retries: 0.

The CLI validates the total job budget, native platform, Docker capacity, artifact reserve, agent identity, model identity, oracle gate, task digests, and fault protocol before resolving provider credentials.

## 24. Artifacts

```text
packages/evals/.eval/<job-id>/
├── job.json
├── plans.jsonl
├── results.jsonl
├── comparison.json
├── comparison.md
└── runs/<run-id>/
    ├── run.json
    ├── long-horizon-result.json
    ├── trajectory.jsonl
    ├── fault-events.jsonl
    ├── environment-events.jsonl
    ├── agent/
    ├── verifier/
    ├── workspace-before/
    └── workspace-after/
```

`plans.jsonl` is immutable after admission. `results.jsonl` is append-only and fsynced per result. Resume skips only a plan with one valid persisted result. Invalid and infrastructure-error plans may retry according to policy and retain every attempt.

## 25. Test strategy

### 25.1 Unit tests

- benchmark, task, scenario, event, plan, and result schema validation;
- digest and path pinning;
- semantic trigger matching and occurrence counting;
- strictly increasing event sequence and fencing validation;
- paired-plan construction;
- score aggregation with invalid and missing telemetry;
- cost admission and resume keys;
- platform-emulation rejection.

### 25.2 Deterministic integration tests

- fake agent passes objective and regression checks;
- no-op agent fails objective checks;
- verifier without start or completion evidence is invalid;
- hidden assets remain absent until verifier injection;
- checkpoint fault resumes without replaying a committed stage;
- read-only fault safely replays;
- reconcilable write recovers a committed receipt without duplication;
- non-reconcilable write enters `unknown_outcome` without duplication;
- stale fencing token cannot append an event;
- trigger timeout produces `fault_not_injected` rather than agent failure;
- interrupted runner resumes without duplicate trials;
- fake credentials are removed from a redacted export.

### 25.3 Model-backed acceptance

- one development capability task with Ever;
- all three development capability tasks with Ever under the development budget;
- one checkpoint recovery scenario;
- one reconcilable-write scenario;
- one fail-closed external-effect scenario;
- one matched capability task with a generic command agent.

No paid test runs in ordinary CI. Scheduled or manual jobs must provide explicit cost budgets.

## 26. Delivery plan

Each phase is independently usable and mergeable.

### Phase 1: Owned capability benchmark

Deliver:

- benchmark and task schemas;
- owned benchmark adapter;
- `long-horizon` CLI profile;
- `repo-schema-migration` and `durable-pipeline-resume`;
- objective, regression, safety, and integrity verifier contract;
- oracle and no-op validation;
- native-platform gate and report fields.

Acceptance:

- the development capability suite runs with fake agents in CI;
- the oracle passes and no-op agent fails both tasks;
- a live Ever run produces valid normalized artifacts;
- no existing external benchmark command changes behavior.

### Phase 2: Semantic resilience benchmark

Deliver:

- explicit Eval durable events;
- semantic fault controller;
- controlled side-effect gate;
- paired trial plans;
- `daemon-protocol-upgrade` and `side-effect-reconciliation`;
- continuity and terminal-semantics reporting.

Acceptance:

- all deterministic recovery fixtures pass;
- fault timing changes do not change the matched semantic trigger;
- reconcilable effects complete exactly once;
- unresolved non-reconcilable effects enter `unknown_outcome`;
- fault and no-fault results remain separately queryable.

### Phase 3: Calibration and release suite

Deliver:

- human baseline record schema;
- independent baseline records for all full-suite tasks;
- task-quality review checklist;
- three-repetition full reports;
- benchmark versioning and release notes.

Acceptance:

- all release tasks satisfy the human-calibration gate;
- three oracle repetitions pass on every supported native platform;
- a complete full-suite report includes denominators and invalid counts;
- results from different benchmark versions cannot be merged silently.

## 27. Success criteria

ELHB-v1 is complete when:

1. The capability suite distinguishes requested behavior, regressions, safety, and infrastructure validity.
2. Faults occur at reproducible semantic boundaries rather than approximate times.
3. A settled checkpoint survives Worker and Daemon replacement.
4. Read-only and reconcilable effects recover without duplication.
5. An unresolved external side effect stops in `unknown_outcome`.
6. Every score can be reproduced from pinned task inputs, event history, receipts, verifier report, and artifacts.
7. Ever and a generic command agent can run the same capability task without importing product internals.
8. ARM and x86 results are score-bearing only when executed natively.
9. A development run is cheap enough for routine iteration, while the full suite retains three repetitions.
10. No result collapses capability, safety, reliability, latency, and cost into one number.

## 28. Rejected alternatives

### Reuse Terminal-Bench tasks and add longer timeouts

Longer wall time does not create causal stages, persistent recovery, or external-effect semantics. Terminal-Bench remains useful for terminal capability but cannot be the ELHB task source.

### Drive faults with `afterMs`

Provider latency and model behavior move the fault across semantic boundaries. Elapsed time remains a deadline only.

### Score the oracle action sequence

Several correct implementations can reach the same safe final state. Reference actions create oracle state and diagnostics. Only contractually unique actions, such as use of an idempotency key, may gate safety.

### Use an LLM judge for long-task quality

The benchmark targets operational correctness and recovery. State, receipts, tests, event history, and terminal semantics are deterministically observable. An LLM may assist task review but cannot produce a score-bearing verdict.

### Build a separate benchmark repository or service now

The schemas and task corpus have not stabilized. Keeping them in `packages/evals` reuses current adapters, artifacts, and reporting without coupling product runtime packages back to Eval. Extraction becomes appropriate only when unrelated projects adopt the task format.

### Report one weighted score

A system could hide duplicated payments behind a high capability score or hide weak capability behind safe refusal. Separate dimensions preserve the decision boundary.

## 29. Fragile assumption

This specification assumes Ever can expose `CheckpointSettled`, tool effect class, tool outcome, execution ID, and fencing token through its public Task event stream. The current Eval adapter still infers recovery counters from event-name regular expressions.

If the structured event projection cannot be added, Phase 1 remains valid, but Phase 2 cannot produce trustworthy resilience scores. The fallback is to keep resilience as deterministic control-plane testing under `packages/long-tasks`, not to infer production recovery from incomplete logs.

## 30. References

- METR Task Standard: <https://github.com/METR/task-standard>
- METR public task suite: <https://github.com/METR/public-tasks>
- METR task specification guide: <https://taskdev.metr.org/specification/>
- METR time-horizon methodology: <https://metr.org/time-horizons/>
- SWE-bench repository and harness: <https://github.com/SWE-bench/SWE-bench>
- SWE-bench grading implementation: <https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/grading.py>
- τ³-bench repository: <https://github.com/sierra-research/tau2-bench>
- τ³-bench task and evaluation model: <https://github.com/sierra-research/tau2-bench/blob/main/docs/evaluation.md>
- Harbor framework: <https://github.com/harbor-framework/harbor>
- Temporal architecture: <https://github.com/temporalio/temporal/blob/main/docs/architecture/README.md>
