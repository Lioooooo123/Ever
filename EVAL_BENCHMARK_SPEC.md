# Karissa External Benchmark Eval Specification

Status: Proposed
Schema version: 1
Scope: Karissa Eval Runner, external benchmark adapters, agent comparison, and reproducible artifacts

## 1. Decision

Karissa owns a TypeScript Eval Runner inside the existing monorepo. External benchmarks are connected through adapters. The runner does not reimplement or reinterpret an external benchmark's verifier. It executes the official verifier, preserves official metrics, and records additional Karissa runtime observations separately.

V1 integrates Terminal-Bench 2.1 and compares Karissa with Codex and Terminus-2 under the same model, task set, limits, environment, and repetition count.

The Eval implementation remains under `packages/evals`. It is process-isolated from the Karissa runtime but is not moved to a separate repository until its adapter and result contracts have stabilized.

## 2. Problem

Karissa currently has:

- deterministic tests for Task state, leases, recovery, coordination, and asynchronous submission;
- model-backed `vitest-evals` for ordinary `AgentSession` behavior;
- no external benchmark integration that can compare Karissa with other agents;
- no black-box harness that drives the installed `karissa` command through a long-running task lifecycle.

Internal tests can show that Karissa follows its own contract, but they cannot show whether it performs better or worse than other agents on the same public tasks. Running a public benchmark directly can produce a comparison, but without a Karissa-owned normalization layer it cannot combine official reward with Karissa-specific recovery, checkpoint, cost, and event evidence.

## 3. Goals

V1 must:

1. Load a versioned external benchmark without copying its scoring logic into Karissa.
2. Run the same task against Karissa, Codex, and Terminus-2.
3. Pin and record benchmark identity, agent version, model identity, environment, permissions, budgets, and repetition.
4. Execute every trial in an isolated Docker environment.
5. Keep benchmark tests and reference solutions unavailable to the agent during execution.
6. Preserve the official benchmark reward unchanged.
7. Record normalized timing, token, cost, terminal state, artifacts, and errors.
8. Record Karissa-specific checkpoint, recovery, Turn, Task, Agent, and event evidence without using it to rewrite the official reward.
9. Support deterministic subsets and resumable batch execution.
10. Produce machine-readable JSONL plus a concise comparison report.

## 4. Non-goals

V1 does not:

- create a new public benchmark;
- submit results to an external leaderboard;
- reproduce the full Harbor framework;
- replace the official Terminal-Bench verifier;
- support SWE-bench, METR Task Standard, or private tasks;
- add an LLM-as-judge score;
- run more than one trial concurrently by default;
- add Python to Karissa runtime packages;
- evaluate macOS notifications or launchd behavior inside Linux benchmark containers;
- claim long-term reliability from a single benchmark run.

## 5. Design principles

### 5.1 External score authority

The external benchmark owns its task meaning and official score. Karissa may normalize the score into its result schema but must retain the original metric names and values.

### 5.2 Black-box agent execution

The runner starts an installed, pinned agent executable. It must not import `TaskController`, `SqliteTaskStore`, Daemon internals, or another agent's implementation.

### 5.3 Adapter parity

An adapter is valid only after:

1. its oracle/reference solution produces the benchmark's expected reward;
2. one supported baseline agent produces materially equivalent results in the official harness and the Karissa runner on the same parity subset;
3. environment, prompt, model, limits, and verifier inputs are shown to be equal.

### 5.4 Hard gates before soft metrics

Infrastructure validity, verifier execution, workspace isolation, and artifact integrity are hard gates. Time, tokens, cost, tool calls, and recovery latency are comparison metrics only after a valid trial.

### 5.5 No benchmark leakage

The task instruction and declared task assets are available during execution. Hidden tests, oracle solutions, expected patches, and evaluator credentials are mounted or copied only after the agent exits.

## 6. Architecture

```text
External Benchmark Registry
            |
            v
   BenchmarkAdapter
            |
            v
       EvalCase v1
            |
            v
      EvalRunner -----------------------> ArtifactStore
       |      |                                |
       |      +--> EnvironmentAdapter          +--> run.json
       |      +--> AgentAdapter                +--> trajectory.jsonl
       |      +--> FaultInjector               +--> verifier/
       |      +--> OfficialVerifier            +--> workspace/
       |                                       +--> comparison.json
       v
  EvalRunResult v1
       |
       +--> Official benchmark metrics
       +--> Comparable common metrics
       +--> Karissa-only runtime metrics
```

There is no dependency from the Karissa runtime back to `packages/evals`.

## 7. Repository layout

```text
packages/evals/
├── src/
│   ├── long-task-evals/
│   │   ├── runner.ts
│   │   ├── schemas.ts
│   │   ├── task-selection.ts
│   │   ├── comparison.ts
│   │   ├── artifacts.ts
│   │   ├── agents/
│   │   │   ├── agent-adapter.ts
│   │   │   ├── karissa-agent.ts
│   │   │   ├── codex-agent.ts
│   │   │   └── terminus-agent.ts
│   │   ├── benchmarks/
│   │   │   ├── benchmark-adapter.ts
│   │   │   └── terminal-bench-2-1.ts
│   │   ├── environments/
│   │   │   ├── environment-adapter.ts
│   │   │   └── docker-environment.ts
│   │   ├── faults/
│   │   │   ├── fault-injector.ts
│   │   │   └── process-faults.ts
│   │   └── verifiers/
│   │       └── official-verifier.ts
│   └── terminal-bench.eval.ts
└── test/
    └── long-task-evals/
```

This design adds more than eight files and five components exchanging data. The additional surface is justified because benchmark loading, agent execution, environment isolation, fault injection, official verification, and artifact persistence have different trust boundaries and independent test adapters.

## 8. Core contracts

All persisted structures include `schemaVersion: 1`. TypeBox schemas validate external and persisted data before use.

### 8.1 `EvalCase`

```ts
interface EvalCase {
  schemaVersion: 1;
  benchmark: {
    name: string;
    version: string;
    source: string;
    resolvedDigest: string;
  };
  id: string;
  instruction: string;
  taskRoot: string;
  environment: {
    kind: "docker";
    buildContext: string;
    imageDigest?: string;
    workingDirectory: string;
    network: "none" | "benchmark_declared";
  };
  verifier: {
    command: string[];
    testsSource: string;
    timeoutSeconds: number;
  };
  limits: {
    trialTimeoutSeconds: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxCostUsd?: number;
  };
  metadata: Record<string, string | number | boolean>;
}
```

Paths in `EvalCase` are resolved under an adapter-owned immutable cache. Path traversal, symlink escape, and digest mismatch invalidate the case before a container starts.

### 8.2 `AgentAdapter`

```ts
interface AgentAdapter {
  readonly identity: AgentIdentity;
  setup(context: AgentSetupContext): Promise<void>;
  run(context: AgentRunContext): Promise<AgentRunOutcome>;
  stop(reason: "timeout" | "cancelled" | "fault"): Promise<void>;
  collectArtifacts(): Promise<AgentArtifact[]>;
}
```

`AgentIdentity` contains:

- stable adapter name;
- exact package or Git version;
- executable digest;
- exact model provider and model ID;
- system prompt or configuration digest;
- tool and permission configuration digest.

The runner rejects floating versions such as `latest`, an unqualified Git branch, or a model alias that cannot be resolved to an exact identity.

### 8.3 `BenchmarkAdapter`

```ts
interface BenchmarkAdapter {
  readonly identity: BenchmarkIdentity;
  resolve(): Promise<ResolvedBenchmark>;
  listCases(benchmark: ResolvedBenchmark): Promise<EvalCase[]>;
  prepareCase(testCase: EvalCase, destination: string): Promise<PreparedCase>;
  verify(testCase: EvalCase, trial: TrialArtifacts): Promise<OfficialVerification>;
  exportOfficialResult(result: EvalRunResult): Promise<unknown>;
}
```

The adapter may translate task metadata and directory layout. It may not change instructions, tests, oracle behavior, reward thresholds, or official metric formulas unless the change is required for agent parity and is applied identically to every compared agent. Every such change is recorded in `run.json`.

### 8.4 `EnvironmentAdapter`

```ts
interface EnvironmentAdapter {
  create(testCase: EvalCase, runDirectory: string): Promise<EvalEnvironment>;
  execute(request: EnvironmentCommand): Promise<EnvironmentCommandResult>;
  injectVerifier(testCase: EvalCase): Promise<void>;
  snapshot(): Promise<EnvironmentSnapshot>;
  destroy(): Promise<void>;
}
```

The Docker adapter:

- builds or pulls the declared environment;
- records the final image digest;
- uses a fresh container per trial;
- mounts only declared agent inputs during execution;
- injects tests after the agent exits;
- disables network unless the benchmark explicitly requires it;
- enforces CPU, memory, process, and wall-time limits;
- removes the container after artifact collection unless `--keep-environment` is explicitly set.

### 8.5 `FaultInjector`

```ts
interface FaultInjector {
  inject(schedule: FaultSchedule, trial: ActiveTrial): Promise<FaultResult[]>;
}
```

V1 fault types are:

- `kill_agent_process`;
- `kill_daemon_process`;
- `pause_agent_process` with a bounded duration;
- `terminate_container`, used only by recovery-negative tests.

External benchmark comparison runs use no injected faults. Karissa reliability runs use a separately named profile so their scores cannot be confused with official benchmark results.

## 9. Karissa black-box control protocol

The Eval Runner requires stable JSON output from the product CLI. V1 adds:

```text
karissa task submit --manifest <path> --yes --json
karissa task show <task-id> --json
karissa task events <task-id> --after <seq> --json
karissa daemon status --json
karissa daemon stop --json
```

`task submit` accepts a local manifest containing goal, workspace root, registered verification command, limits, and unattended authorization. It prints one JSON object containing `schemaVersion`, `taskId`, `state`, and `createdAt`.

The Eval Runner never parses human-readable command output. Unknown JSON schema versions are rejected.

For a Harbor-style container trial, `KarissaAgent.run()`:

1. starts or confirms the Karissa Daemon;
2. submits the benchmark instruction;
3. polls Task state with bounded exponential backoff from 250 ms to 5 seconds;
4. streams new Task events into the trial trajectory;
5. returns only when the Task enters a terminal or user-attention state;
6. stops the Daemon and confirms lease release before verifier injection.

`waiting_input`, `waiting_external`, `paused`, `unknown_outcome`, and timeout are unsuccessful agent outcomes for unattended public benchmark runs. They remain distinct in artifacts.

## 10. Terminal-Bench 2.1 adapter

V1 uses registry identity `terminal-bench/terminal-bench-2-1`.

The adapter records the resolved registry version, source digest, task manifest digest, environment image digest, instruction digest, and verifier digest. A cached task is reused only when all digests match.

### 10.1 Deterministic development subset

The development subset contains 10 tasks selected without hand-picking:

1. list all task IDs from the resolved dataset;
2. sort by SHA-256 of `terminal-bench-2-1\0<task-id>`;
3. select the first 10;
4. persist the selected IDs and dataset digest in the run manifest.

The same resolved subset is used for every compared agent.

### 10.2 Official verification

The adapter executes the task's official verifier after agent execution. Raw verifier stdout, stderr, exit code, duration, and reward files are preserved. The normalized result carries the official reward without rounding or threshold changes.

Before model-backed runs, the oracle agent must achieve the expected reward on all selected cases. An oracle failure marks the adapter or environment invalid and blocks comparisons.

## 11. Agents and fairness

V1 comparison agents are:

- Karissa;
- Codex;
- Terminus-2.

Every comparison job requires one exact model identity supported by all selected agents. The job is rejected if an adapter silently substitutes a different model.

The following values are identical or explicitly reported as unavailable:

- task instruction;
- environment image;
- network policy;
- working directory;
- wall-time limit;
- model identity;
- reasoning or thinking configuration;
- input and output token limits;
- concurrency;
- repetition count;
- verifier version.

Agent-specific tools and prompts are part of the agent being evaluated and are therefore not forced to be identical. Their digests and user-visible configuration are recorded.

Default comparison settings:

- repetitions: 3;
- concurrent trials: 1;
- task subset size: 10;
- network: benchmark-declared only;
- execution order: deterministic interleaving by case, repetition, then agent;
- retry on infrastructure failure: one retry;
- retry on agent failure: none.

## 12. Result model

```ts
interface EvalRunResult {
  schemaVersion: 1;
  runId: string;
  caseId: string;
  repetition: number;
  benchmark: BenchmarkIdentity;
  agent: AgentIdentity;
  environment: EnvironmentIdentity;
  outcome:
    | "completed"
    | "failed"
    | "timed_out"
    | "waiting_input"
    | "waiting_external"
    | "paused"
    | "unknown_outcome"
    | "infrastructure_error";
  official: {
    valid: boolean;
    metrics: Record<string, number>;
    verifierExitCode?: number;
  };
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    wallTimeMs: number;
    toolCalls?: number;
  };
  integrity: {
    environmentDigest: string;
    instructionDigest: string;
    verifierDigest: string;
    artifactsDigest: string;
    violations: string[];
  };
  karissa?: {
    taskId: string;
    terminalState: string;
    turns: number;
    checkpoints: number;
    recoveries: number;
    recoveryLatencyMs?: number;
    unknownToolOutcomes: number;
    duplicateSideEffects: number;
  };
  artifacts: Array<{ name: string; path: string; sha256: string }>;
  errors: Array<{ source: string; code: string; message: string }>;
}
```

Missing telemetry remains absent. It is never converted to zero.

## 13. Scoring and reporting

### 13.1 Official score

The primary capability comparison is the benchmark's official reward aggregated exactly as documented by the benchmark.

### 13.2 Common comparison metrics

The report includes:

- mean official reward;
- pass rate according to the official benchmark;
- pass@1 by case;
- success rate across three repetitions;
- median and P95 wall time;
- median tokens and estimated cost when available;
- timeout rate;
- infrastructure-error rate.

No composite score mixes reward, cost, and latency.

### 13.3 Karissa reliability metrics

Karissa-only observations are reported separately:

- checkpoint count;
- recovery count and latency;
- duplicate side effects;
- unknown tool outcomes;
- Task terminal-state distribution;
- Task event integrity violations.

These metrics explain Karissa behavior but do not change Terminal-Bench reward.

### 13.4 Hard invalidation

A trial is invalid rather than failed when:

- the environment or verifier digest differs from the case manifest;
- the verifier cannot execute;
- hidden tests or oracle assets were visible during agent execution;
- the container violates configured isolation;
- required artifacts cannot be hashed or persisted;
- the selected model differs from the recorded model;
- an infrastructure failure prevents the agent from receiving the task.

Invalid trials do not count as passes or failures. They appear as incomplete observations and block leaderboard-style claims.

## 14. Artifacts

Each job writes:

```text
packages/evals/.eval/<job-id>/
├── job.json
├── results.jsonl
├── comparison.json
├── comparison.md
└── runs/<run-id>/
    ├── run.json
    ├── trajectory.jsonl
    ├── agent/
    ├── verifier/
    ├── workspace-before/
    └── workspace-after/
```

Artifacts may contain prompts, source code, tool output, credentials accidentally printed by third-party agents, or benchmark material. Directories use mode `0700`; files use `0600`; artifacts are ignored by Git. Before sharing, a redaction command removes environment variables, authorization headers, credential files, and configured secret patterns.

`results.jsonl` is append-only. A run is resumable by `runId`; completed valid trials are not rerun unless `--force` is supplied.

## 15. Commands

V1 extends the existing root Eval command:

```text
npm run eval -- benchmark --benchmark terminal-bench-2-1 --agents karissa,codex,terminus-2 --model <exact-model> --max-cost-usd <amount>
npm run eval -- benchmark --benchmark terminal-bench-2-1 --agents oracle --subset development
npm run eval -- benchmark --resume <job-id>
npm run eval -- report <job-id>
```

`--model` and `--max-cost-usd` are required for model-backed jobs. The runner validates them before starting Docker or making a provider request. Shell history and reports never contain credential values.

## 16. Dependencies and credentials

Required local dependencies:

- Node.js and existing npm workspace dependencies;
- a working Docker-compatible daemon;
- sufficient local disk for benchmark images and artifacts.

Required credentials:

- one provider API credential accepted by every selected agent for the exact comparison model;
- benchmark registry credentials only if the selected registry requires authentication.

Harbor and Python are not runtime dependencies of V1. Harbor is used as a parity reference during adapter validation. If an official benchmark verifier requires Python inside its container, that runtime remains contained in the benchmark environment.

The current development machine has `uv` and Python but no available `docker` command. Model-backed Terminal-Bench execution is blocked until a Docker-compatible daemon and CLI are installed and `docker info` succeeds.

## 17. Security

- Provider credentials enter only the agent process environment and are never written into task manifests.
- Verifier processes do not receive provider credentials.
- Benchmark content is treated as untrusted input.
- Docker build contexts are constrained to the resolved benchmark task.
- Adapter commands use argument arrays, not shell interpolation.
- Host paths mounted into containers are explicit and read-only unless the task requires a writable workspace.
- Agent containers do not mount the Karissa repository, user home, Docker socket, or the Eval artifact root.
- The runner refuses privileged containers and host networking in V1.
- Test and oracle paths are verified absent before the agent starts.

## 18. Failure handling

### External registry unavailable

The runner uses a previously resolved cache only when all recorded digests match. Otherwise it stops before creating trials. It never silently switches dataset versions.

### Docker unavailable

Preflight fails before credentials are resolved or model calls begin.

### Provider unavailable

The trial records an agent or provider error. The job continues to the next scheduled trial unless the job cost or consecutive-infrastructure-error limit is reached.

### Ten-times task volume

The scheduler streams cases and results rather than loading trajectories into memory. Artifact storage and Docker disk usage are the first expected constraints. Preflight estimates required disk from cached image metadata and refuses to start when the configured reserve would be exhausted.

### Rollback

The feature is isolated under `packages/evals` and new JSON CLI modes. Removing the Eval Runner does not migrate or modify user Task databases. Rollback consists of disabling the new Eval command and retaining `.eval` artifacts for later inspection.

## 19. Delivery plan

Each phase is independently usable and mergeable.

### Phase 1: Black-box contracts and local deterministic runner

Deliver:

- stable Karissa JSON task-control commands;
- versioned `EvalCase` and `EvalRunResult` schemas;
- `EvalRunner`, artifact storage, resume, and report generation;
- fake benchmark, fake environment, and fake agent adapters;
- hard-gate and result-normalization tests.

Acceptance:

- a fake three-agent comparison produces deterministic JSONL and Markdown reports;
- interrupted jobs resume without duplicating completed trials;
- malformed schemas, floating versions, missing budgets, and artifact digest errors fail before execution;
- the runner has no import from Karissa long-task internals.

### Phase 2: Terminal-Bench 2.1 and Docker

Deliver:

- Docker environment adapter;
- Terminal-Bench 2.1 adapter;
- deterministic 10-task subset;
- hidden-verifier injection;
- oracle validation;
- Karissa, Codex, and Terminus-2 adapters.

Acceptance:

- oracle reaches expected reward on all 10 selected tasks;
- tests and oracle assets are absent during agent execution;
- one baseline parity run matches the official Harbor result per case;
- the same resolved model and environment digests are recorded for all compared agents;
- one model-backed case can run end to end and produce official reward plus normalized artifacts.

### Phase 3: Repeated comparison and Karissa fault profiles

Deliver:

- three-repetition comparison jobs;
- cost, token, latency, and success summaries;
- Karissa process-fault injection profiles;
- checkpoint, recovery, duplicate-side-effect, and unknown-outcome reporting.

Acceptance:

- the 10-case, three-agent, three-repetition job can resume after runner interruption;
- official no-fault results remain separate from Karissa fault-profile results;
- hard-gate failures cannot be hidden by average reward;
- comparison output identifies incomplete telemetry rather than treating it as zero.

## 20. Test strategy

### Unit tests

- schema validation and migrations between no versions other than v1;
- deterministic task selection;
- version and digest pinning;
- cost-budget admission;
- result aggregation with missing telemetry;
- artifact hashing and redaction;
- invalid-trial classification.

### Integration tests without paid models

- fake agent passes and fails official fake verifier;
- oracle assets remain hidden until verifier injection;
- runner interruption and resume;
- Docker timeout and cleanup;
- malformed benchmark task and symlink escape rejection;
- agent output containing fake credentials is redacted from shareable artifacts;
- two agents receive byte-identical task instructions and environment identities.

### Model-backed acceptance

- one Terminal-Bench task with Karissa;
- the same task and model with one baseline agent;
- development subset oracle run;
- development subset parity comparison;
- one Karissa Daemon restart fault run, reported outside official comparison.

No paid model-backed run occurs in normal pull-request CI. Pull requests run unit and deterministic integration tests. Repeated live comparisons run manually or in a budgeted scheduled workflow.

## 21. Success criteria

The project is successful when:

1. Karissa, Codex, and Terminus-2 can run the same resolved Terminal-Bench 2.1 subset through one command.
2. Official verifier outputs remain unchanged and reproducible.
3. Oracle and baseline parity demonstrate adapter correctness.
4. Every comparison records exact benchmark, model, agent, environment, prompt/configuration, limits, and artifact digests.
5. Invalid infrastructure cannot be reported as an agent failure or pass.
6. Results expose capability, cost, latency, and reliability without collapsing them into one opaque score.
7. Karissa-specific long-task recovery data is available without contaminating public benchmark reward.

## 22. Rejected alternative

V1 will not fork or embed Harbor as Karissa's Eval core. Doing so would introduce a second orchestration stack and Python control plane while still requiring Karissa-specific Task polling, recovery events, and artifact normalization. Harbor remains the official parity reference and a future export target.

If the primary goal changes from Karissa development to publishing and maintaining benchmarks for many unrelated agents, the Eval package should move to a separate repository and use Harbor directly as its execution core.

## 23. Fragile assumption

This design assumes external benchmarks expose deterministic task environments and official verifiers that can be invoked without embedding their orchestration framework. If Terminal-Bench distribution stops exposing those boundaries, the Terminal-Bench adapter becomes a thin Harbor subprocess adapter while the common `EvalCase`, `AgentAdapter`, result, artifact, and reporting contracts remain unchanged.

## 24. References

- Harbor Agents: <https://www.harborframework.com/docs/agents>
- Harbor Core Concepts: <https://www.harborframework.com/docs/core-concepts>
- Harbor Task Structure: <https://www.harborframework.com/docs/tasks>
- Terminal-Bench runner: <https://www.harborframework.com/docs/tutorials/running-terminal-bench>
- Terminal-Bench repository: <https://github.com/harbor-framework/terminal-bench>
- SWE-bench evaluation harness: <https://github.com/SWE-bench/SWE-bench>
- Inspect AI: <https://github.com/UKGovernmentBEIS/inspect_ai>
- METR public tasks and Task Standard examples: <https://github.com/METR/public-tasks>
