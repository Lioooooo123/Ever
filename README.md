# Ever

**A Task-first coding agent for work that must survive, recover, and prove it is done.**

Ever runs development work as durable Tasks instead of disposable chat sessions. A Task keeps its plan, attempts, evidence, verification results, and recovery state across terminal disconnects and daemon restarts.

Ever is developed directly from a complete in-repository execution stack. It is not an extension wrapped around another agent. The model loop, tools, context management, terminal UI, Task control plane, recovery logic, and completion policy are maintained together as one product.

## Why Ever

- **Task-first:** the Task is the primary user-facing unit; Sessions are internal execution records.
- **Durable:** detached work survives terminal disconnects and resident Worker restarts.
- **Recoverable:** interrupted attempts resume from persisted checkpoints and evidence.
- **Verifiable:** a Task completes only after its acceptance policy passes.
- **Observable:** status, events, evidence, and RPC output expose what the agent is doing.
- **Bounded:** unattended work has explicit time, turn, cost, permission, and sandbox controls.

## Execution lifecycle

```text
Reason -> Execute -> Observe -> Verify -> Repair -> Done
                              ^          |
                              |----------|
```

Ever reasons about the next step, executes it through the embedded tool loop, observes the result, and verifies the Task against explicit acceptance criteria. Failed verification returns the Task to repair. `Done` is a policy decision backed by evidence, not a model assertion.

## Install

```bash
npm install -g --ignore-scripts @lioooooo123/ever
ever
```

Running `ever` opens Task Home. Create a Task directly from the command line:

```bash
ever "refactor the repository and run the focused tests" \
  --verify "npm run check" \
  --yes
```

Detach long-running work, then inspect or reconnect later:

```bash
ever "upgrade the dependency and verify compatibility" --detach --yes
ever tasks
ever status <task-id>
ever attach <task-id>
```

Apply execution limits when a Task must stay within a fixed budget:

```bash
ever "fix the failing tests" \
  --verify "./test.sh" \
  --max-turns 20 \
  --max-wall-time-minutes 45 \
  --max-cost-usd 5 \
  --yes
```

Automation can use strict JSONL RPC framing:

```bash
printf '%s\n' '{"id":1,"method":"task.list"}' | ever --mode rpc
```

See the [Ever CLI and SDK documentation](packages/coding-agent/README.md) for providers, models, Task commands, configuration, and programmatic usage.

## Task model

| Concept | Meaning |
|---|---|
| **Task** | The durable user goal and its completion policy |
| **Attempt** | One recoverable execution of a Task |
| **Session** | The internal model and tool transcript for an Attempt |
| **Evidence** | Persisted observations used by recovery and verification |
| **Worker** | The resident process that executes a Task |

This boundary keeps user workflows stable without replacing the proven model-and-tool loop with a second agent runtime.

## Architecture

| Module | Responsibility |
|---|---|
| **[@lioooooo123/ever](packages/coding-agent)** | Public CLI, embedded SDK, tools, terminal interface, and Task integration |
| **[@lioooooo123/ever-long-tasks](packages/long-tasks)** | Durable Tasks, Attempts, evidence, recovery, and completion decisions |
| **[@lioooooo123/ever-agent-core](packages/agent)** | Reasoning loop, state transitions, and tool execution |
| **[@lioooooo123/ever-ai](packages/ai)** | Multi-provider model API |
| **[@lioooooo123/ever-protocol](packages/protocol)** | Transport-neutral protocol for remote execution |
| **[@lioooooo123/ever-client](packages/client)** | Client for remote Ever execution |
| **[@lioooooo123/ever-server](packages/server)** | Experimental remote execution server |
| **[@lioooooo123/ever-tui](packages/tui)** | Terminal rendering and interaction primitives |
| **[@lioooooo123/ever-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts and schemas |
| **[@lioooooo123/ever-evals](packages/evals)** | Evaluation harnesses and acceptance metrics |

The execution kernel is embedded source code within this repository. Ever does not require a separately installed Pi package or route Tasks through a parallel wrapper lifecycle.

## Safety

Unattended Tasks require the platform sandbox unless the operator explicitly opts out. Ever removes ambient credentials from Worker environments and sends only the selected provider credential through an owner-only startup channel.

Interactive execution runs with the permissions of its host process. Use the unattended Task path or an external sandbox when you need a stronger boundary. See the [containerization guide](packages/coding-agent/docs/containerization.md).

## Development

```bash
npm install --ignore-scripts
npm run build
npm run build:offline
npm run check
./test.sh
./ever-test.sh
```

`npm run build:offline` uses the checked-in provider model data instead of refreshing it over the network. `./ever-test.sh` starts Ever from source for interactive debugging.

Design and implementation references:

- [Ever v0.1 development specification](EVER_V0.1_DEVELOPMENT_SPEC.md)
- [Ever architecture optimization specification](EVER_ARCHITECTURE_OPTIMIZATION_SPEC.md)
- [Long-running control plane specification](LONG_RUNNING_CONTROL_PLANE_SPEC.md)
- [Contributing guide](CONTRIBUTING.md)
- [Development rules](AGENTS.md)

## Supply-chain policy

- Direct external dependencies are pinned to exact versions.
- `package-lock.json` is the dependency ground truth.
- Releases include a generated npm shrinkwrap for transitive dependency pinning.
- CI installs dependencies with lifecycle scripts disabled.
- Dependency lifecycle scripts require an explicit reviewed allowlist.

## Upstream attribution

Ever began from source code derived from the Pi agent project and continues to preserve the applicable upstream copyright and MIT license notices. Ever's Task model, product identity, package namespace, control plane, recovery behavior, and release surface are maintained as Ever.

## License

MIT
