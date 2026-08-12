# Ever evals

Ever evals are behavioral, model-backed checks for Ever workflows. They adapt a real `AgentSession` to `vitest-evals`, run
it in isolated temporary project and agent directories, and attach native Ever session artifacts.
Use them to measure end-to-end behavior and compare prompts, tools, skills, models, or other harness configurations.

## Running evals

Eval has two execution profiles and one report command:

- `quick`: lightweight Ever Agent checks through `vitest-evals`; no Docker. It defaults to one end-to-end smoke prompt.
- `benchmark`: Docker-isolated external benchmarks with official verifiers, Oracle gating, and resumable trials.
- `report`: lists both job types or renders one normalized overview with the profile-specific comparison appended.

Run the daily smoke profile from the repository root:

```bash
npm run eval -- quick --provider openai --model gpt-5.6-sol
```

The equivalent environment variables are:

```bash
EVER_PROVIDER=openai EVER_MODEL=gpt-5.6-sol npm run eval -- quick
```

CLI values take precedence over the environment. Provider and model must be supplied together so every quick job records an exact default model identity.
Authentication comes from Ever's normal `ModelRuntime`, including Ever subscription credentials and provider API-key
environment variables.

Use `--suite all` for every lightweight Eval, or pass advanced Vitest filters directly:

```bash
npm run eval -- quick --provider openai --model gpt-5.6-sol --suite all
npm run eval -- quick --provider openai --model gpt-5.6-sol src/extensions.eval.ts
npm run eval -- quick --provider openai --model gpt-5.6-sol -t "creates, reloads, and uses"
```

Each job writes a common `eval-job.json` under `.eval/<job-id>/`. Quick jobs retain `runs.jsonl`, sessions, sources, and
harness comparisons. Benchmark jobs retain official results, verifier output, trajectories, and workspace snapshots.
These files may contain prompts, responses, source code, and tool output.

List all jobs or render one report:

```bash
npm run eval -- report
npm run eval -- report <job-id>
```

## Writing evals

Follow [`vitest-evals`](https://github.com/getsentry/vitest-evals) for general suite, judge, assertion, and normalized
trace guidance. Ever-specific evals use `createEverCodingAgentHarness(...)` from `src/ever-harness.ts`, with one harness bound
to each `describeEval(...)` suite:

```ts
import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createEverCodingAgentHarness } from "./ever-harness.ts";

const harness = createEverCodingAgentHarness({ noTools: "all" });

describeEval("Ever smoke", { harness }, (it) => {
	it("answers a factual question", async ({ run }) => {
		const result = await run("What is the capital of France? Reply with only the city name.");
		expect(result.output).toBe("Paris");
	});
});
```

### Configuring the Ever harness

`createEverCodingAgentHarness(...)` accepts:

- `name`: stable harness identity used by reports and comparisons.
- `model`: optional `{ provider, id }` selection. It overrides the runner's default model.
- `noTools`: Ever's tool-disable configuration.
- `transformSystemPrompt`: transforms the complete default prompt before the eval starts.
- `output`: transforms the final response and `AgentSession` into a JSON-safe domain result.

An explicitly selected model makes model-comparison harnesses independent of the runner default:

```ts
const harness = createEverCodingAgentHarness({
	name: "claude-opus-4-6",
	model: { provider: "anthropic", id: "claude-opus-4-6" },
});
```

A run accepts either one prompt or a sequence of prompt and reload steps. Reload steps are useful when the preceding
prompt creates or changes Ever resources:

```ts
const result = await run([
	{ type: "prompt", content: "Create an Ever extension." },
	{ type: "reload" },
	{ type: "prompt", content: "Use the extension." },
]);
```

### Transforming harness output

Use `output` to expose scenario-specific, JSON-safe behavior without adding that behavior to the generic Ever adapter:

```ts
const harness = createEverCodingAgentHarness({
	output: ({ response, session }) => ({
		response,
		activeTools: session.getActiveToolNames(),
		extensionErrors: session.resourceLoader.getExtensions().errors,
	}),
});
```

Assert application behavior on `result.output`. Assert model and tool traces on `result.session`, using
`vitest-evals` helpers such as `toolCalls(...)`.

### Writing comparative eval sets

Use `evalHarnessTable(...)` with Vitest's native `describe.for(...)` to run the same inputs against multiple harnesses.
Harnesses may differ by prompt, tools, skills, model, or any other Ever configuration:

```ts
import { describe } from "vitest";
import { createJudge, describeEval } from "vitest-evals";
import { evalHarnessTable } from "./vitest-evals/harness-table.ts";

const TargetTaskJudge = createJudge<string, string>("TargetTaskJudge", ({ output }) => ({
	score: output === "expected result" ? 1 : 0,
}));

const harnessTable = evalHarnessTable(
	"target skill effectiveness",
	{
		baseline: withoutTargetSkillHarness,
		candidate: withTargetSkillHarness,
		repetitions: 6,
	},
);

describe.for(harnessTable)("$name repetition $repetition", ({ harness }) => {
	describeEval("target skill effectiveness", { harness, judges: [TargetTaskJudge], judgeThreshold: null }, (it) => {
		it("completes the target task", async ({ run }) => {
			await run("Complete the target task.");
		});
	});
});
```

Comparative suites should record correctness with deterministic or model-backed judges and set `judgeThreshold: null`.
This keeps a low score as an observation instead of making the Vitest invocation fail. Use hard assertions only for
suite invariants and infrastructure contracts. `expect.soft(...)` still fails the test and is not a scoring mechanism.

The Ever harness snapshots native session JSONL before deleting its temporary workspace. An eval-only `afterEach` hook
registers that snapshot against the explicit Vitest test task before reporters run.

Harness names must be stable and unique within an eval set. The grouping key combines repetition with a non-empty string
`input.id` when available, otherwise with a SHA-256 hash of strict canonical JSON input. Use `candidate` for one treatment
or `candidates` for multiple treatments. Each candidate is compared only with the declared baseline. For each matched
input and repetition, the reporter computes pass-rate lift from each run's recorded average judge score, treating a score
of at least `1` as passing. Lift is the candidate pass rate minus the baseline pass rate, in percentage points. Missing
judge scores are reported as incomplete observations. Tokens, latency, and estimated cost remain separate
candidate-minus-baseline paired deltas; missing telemetry remains unavailable. If execution-order randomization becomes
necessary, use Vitest's built-in sequence shuffling.

See the [`skill-eval-harness`](https://github.com/adewale/skill-eval-harness/) guidance for comparative-eval methodology,
repetition strategy, trustworthy judges, and telemetry interpretation.

## Running external benchmarks

The benchmark runner executes Terminal-Bench 2.1 tasks in fresh Docker containers and injects each task's official
`tests/` directory only after the agent has stopped. It writes append-only results under `packages/evals/.eval/` and can
resume an interrupted job.

Prepare a JSON agent configuration. Commands run inside the benchmark container, so each entry must either name an
executable already present in the image or use `preparation` to copy and install a pinned local artifact. Credential
names are declared with `forwardEnvironment`; their values are read only after Docker preflight and are not persisted.

```json
[
  {
    "kind": "ever",
    "name": "ever",
    "version": "0.84.1+a12230ac0",
    "executableDigest": "<64-character-sha256>",
    "configurationDigest": "<64-character-sha256>",
    "command": ["/opt/ever/bin/ever"],
    "forwardEnvironment": ["OPENAI_API_KEY"],
    "preparation": {
      "copyIn": [{ "source": "/absolute/path/ever-release", "destination": "/opt/ever" }]
    }
  },
  {
    "kind": "command",
    "name": "codex",
    "version": "<exact-version>",
    "executableDigest": "<64-character-sha256>",
    "configurationDigest": "<64-character-sha256>",
    "command": ["codex", "exec", "{instruction}"],
    "forwardEnvironment": ["OPENAI_API_KEY"]
  }
]
```

First run the deterministic ten-task subset with an `oracle` entry from the same agent configuration. The oracle command
normally copies the task's `solution/` assets during its own agent phase. Model-backed comparisons require the resulting
job as a hard gate.

```bash
npm run eval -- benchmark \
  --benchmark terminal-bench-2-1 \
  --benchmark-root /absolute/path/to/terminal-bench-2.1 \
  --agent-config /absolute/path/to/agents.json \
  --agents oracle \
  --subset development
```

Then run the comparison with one exact model identity and a hard job admission budget:

```bash
npm run eval -- benchmark \
  --benchmark terminal-bench-2-1 \
  --benchmark-root /absolute/path/to/terminal-bench-2.1 \
  --agent-config /absolute/path/to/agents.json \
  --agents ever,codex,terminus-2 \
  --oracle-job <oracle-job-id> \
  --provider openai \
  --model <exact-model-id> \
  --max-cost-usd 50
```

Resume and regenerate a report without rerunning completed trials:

```bash
npm run eval -- benchmark --resume <job-id>
npm run eval -- report <job-id>
npm run eval -- benchmark --redact <job-id> --secret-env OPENAI_API_KEY
```

Docker must be installed and `docker info` must succeed. The command rejects floating agent versions, floating model
aliases, digest drift, mismatched models, missing budgets, benchmark symlinks, and hidden tests visible before execution.

Fault injection is intentionally separate from official benchmark jobs. Use only an Ever agent, a profile name that
starts with `ever-reliability`, and a JSON schedule containing `kill_agent_process`, `kill_daemon_process`,
`pause_agent_process`, or `terminate_container` entries:

```bash
npm run eval -- benchmark <normal-options> \
  --agents ever \
  --fault-profile ever-reliability-daemon-kill \
  --fault-schedule /absolute/path/to/faults.json
```
