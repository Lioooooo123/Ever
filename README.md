# Ever

**A Session-native coding agent with an opt-in long-running Goal mode.**

Ever uses Sessions for normal interactive and one-shot work. When a job needs autonomous continuation across multiple turns, start a Goal inside the current Session with `/goal`.

Ever is developed directly from a complete in-repository execution stack. It is not an extension wrapped around another agent. The model loop, tools, context management, terminal UI, Task control plane, recovery logic, and completion policy are maintained together as one product.

## Why Ever

- **Session-native:** ordinary prompts, history, resume, branching, and compaction use the same Session runtime.
- **Opt-in:** long-running behavior starts only after `/goal`; normal Sessions never auto-continue.
- **Durable:** Goal state is stored in the Session and follows resume, compaction, and tree navigation.
- **Verifiable:** the agent must report concrete evidence before it can complete a Goal.
- **Bounded:** Goal continuation has explicit turn, time, and optional token limits.
- **Recoverable:** the advanced `ever task` control plane remains available for detached Worker execution.

## Goal lifecycle

```text
Reason -> Execute -> Observe -> Verify -> Repair -> Done
                              ^          |
                              |----------|
```

Ever reasons about the next step, executes it through the embedded tool loop, observes the result, and records progress in the active Goal. A Goal continues after each settled turn until verified completion, a budget pause, or the same blocker is reported on three consecutive Goal turns.

## Install

```bash
npm install -g --ignore-scripts @lioooooo123/ever-cli
ever
```

Running `ever` opens a normal interactive Session. A prompt remains ordinary Session work:

```bash
ever
ever "inspect this repository and explain the architecture"
ever -p "summarize the current diff"
```

Inside the TUI, opt into long-running execution with one command:

```bash
/goal refactor the repository and run the focused tests
/goal status
/goal pause
/goal resume
/goal blocked <reason>
/goal permissions
/goal cancel
```

The durable Worker control plane is an advanced interface for detached automation:

```bash
ever task submit --manifest task.json --yes --json
ever task ls
ever task show <task-id>
```

See the [Ever CLI and SDK documentation](packages/coding-agent/README.md) for Sessions, `/goal`, providers, models, and programmatic usage.

## Runtime model

| Concept | Meaning |
|---|---|
| **Session** | The normal user-facing conversation, tool transcript, history, and branch tree |
| **Goal** | The objective of a durable Task attached to the current Session |
| **Evidence** | Concrete verification required before agent-reported Goal completion |
| **Task / Attempt / Worker** | Advanced detached control-plane records used by `ever task` |

Goal mode deepens the existing Session lifecycle instead of introducing a second interactive runtime.

## Architecture

| Module | Responsibility |
|---|---|
| **[@lioooooo123/ever-cli](packages/coding-agent)** | Public Session CLI, `/goal`, embedded SDK, tools, and terminal interface |
| **[@lioooooo123/ever-long-tasks](packages/long-tasks)** | Durable Tasks, Attempts, evidence, recovery, and completion decisions |
| **[@lioooooo123/ever-agent-core](packages/agent)** | Reasoning loop, state transitions, and tool execution |
| **[@lioooooo123/ever-ai](packages/ai)** | Multi-provider model API |
| **[@lioooooo123/ever-protocol](packages/protocol)** | Transport-neutral protocol for remote execution |
| **[@lioooooo123/ever-client](packages/client)** | Client for remote Ever execution |
| **[@lioooooo123/ever-server](packages/server)** | Experimental remote execution server |
| **[@lioooooo123/ever-tui](packages/tui)** | Terminal rendering and interaction primitives |
| **[@lioooooo123/ever-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts and schemas |
| **[@lioooooo123/ever-evals](packages/evals)** | Evaluation harnesses and acceptance metrics |

The execution kernel is embedded source code within this repository. Ever does not require a separately installed runtime package or route Tasks through a parallel wrapper lifecycle.

## Safety

Advanced unattended Tasks require the platform sandbox unless the operator explicitly opts out. Ever removes ambient credentials from Worker environments and sends only the selected provider credential through an owner-only startup channel.

Interactive execution runs with the permissions of its host process. Use the unattended Task path or an external sandbox when you need a stronger boundary. See the [containerization guide](packages/coding-agent/docs/containerization.md).

## Development

```bash
npm install --ignore-scripts
npm run build
npm run build:offline
npm run check
./scripts/test.sh
./scripts/ever-test.sh
```

`npm run build:offline` uses the checked-in provider model data instead of refreshing it over the network. `./scripts/ever-test.sh` starts Ever from source for interactive debugging.

Design and implementation references:

- [Documentation index](docs/README.md)
- [Ever v0.1 development specification](docs/specs/EVER_V0.1_DEVELOPMENT_SPEC.md)
- [Ever architecture optimization specification](docs/specs/EVER_ARCHITECTURE_OPTIMIZATION_SPEC.md)
- [Long-running control plane specification](docs/specs/LONG_RUNNING_CONTROL_PLANE_SPEC.md)
- [Contributing guide](CONTRIBUTING.md)
- [Development rules](AGENTS.md)

## Supply-chain policy

- Direct external dependencies are pinned to exact versions.
- `package-lock.json` is the dependency ground truth.
- Releases include a generated npm shrinkwrap for transitive dependency pinning.
- CI installs dependencies with lifecycle scripts disabled.
- Dependency lifecycle scripts require an explicit reviewed allowlist.

## Upstream attribution

Ever began from upstream MIT-licensed agent source and continues to preserve the applicable copyright and license notices. Ever's Task model, product identity, package namespace, control plane, recovery behavior, and release surface are maintained as Ever.

## License

MIT
