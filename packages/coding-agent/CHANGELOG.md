# Changelog

## [Unreleased]

### Changed

- Restored the default CLI to a normal persistent Session and made durable Task creation explicit through `ever run`, `ever new`, `ever home`, `/goal`, or `/flow`.
- Restored `/goal <objective>` as a thin Session adapter over the durable Task runtime, without reintroducing a second Goal state machine.
- Required durable completion requests to audit each explicit objective requirement against host-verified evidence.
- Deferred automatic Task continuation whenever the Session is already occupied by user work.

### Added

- Added `/flow` for durable DAG orchestration and reusable `agent_spawn`, `agent_dispatch`, `agent_message`, `agent_inbox`, and `agent_report` tools for named Agents across ordinary Sessions, with fresh Dispatch Sessions, persistent Episodes, and durable cross-Session delivery.
- Sandboxed the foreground execution path so `ever`, `ever run`, `ever attach`, `ever new`, and `ever home` re-exec the Session inside the same Session Execution Host used by detached Workers. Bare Sessions are sandboxed at launch, `/goal` inherits `sandboxAvailable` without its own handling, and the Small Model Judge can auto-approve eligible low-risk process commands in the foreground instead of prompting for every command. Startup envelopes now carry the full credential map, and unsandboxed platforms or missing credentials still fall back to manual confirmation.
- Allowed durable permission grants to attach to a Session without a Task: `taskId` is now optional, `session` grants are keyed by `sessionId`, and `workspace`/`project_policy` grants are keyed by workspace alone. A sandboxed Session hot-updates the network allowlist over a control channel when the user grants a new domain, so newly approved domains work without a restart.
- Added a permission security eval gate: an adversarial process corpus must never auto-allow, and eligible benign workspace intents must auto-approve at a ≥90% rate.

## [0.0.1] - 2026-08-14

### Added

- Added a fullscreen exit output setting to choose between printing the final transcript and only a session resume hint.
- Added the `ever` guided asynchronous task command, persistent daemon consumption, and desktop task notifications.
- Added versioned JSON task submission, inspection, event streaming, and daemon control for black-box Eval runners.
- Added Task-aware reuse of the native Ever TUI, Task-first JSONL RPC, durable steering, verified completion bundles, resident Worker recovery, and OS-level unattended execution sandbox.
- Added `/goal` as a durable Task adapter that adopts the current Session and uses native continuation, checkpoints, budgets, permissions, evidence, acceptance, and recovery.
- Added deterministic tool-intent authorization, bounded LLM risk review, durable scoped permission grants, approval scope selection, revocation support, and permission auditing.

### Breaking Changes

- Restored Task-first CLI semantics: every public execution now creates, resumes, or controls a durable Task, while direct Session selection remains an internal bridge.
- Renamed the npm CLI distribution from `@lioooooo123/ever` to `@lioooooo123/ever-cli` and started its independent version line at `0.0.1`; reinstall the new package while continuing to invoke the `ever` command.
- Removed all pre-Ever configuration directories, environment variables, package manifests, module aliases, and resource-discovery fallbacks. Existing state must be placed under `.ever` or `~/.ever/agent` and configured with `EVER_*` variables.

### Changed

- Centralized durable `<long_task>` prompt injection in the native `before_turn` lifecycle and removed undeployed multi-Agent roster and delegation fields from V0.1 model context.
- Changed the directly developed coding-agent distribution to publish independently as `@lioooooo123/ever-cli` with `ever-*` release artifacts, with the in-repository Ever agent, AI, and TUI source modules as its execution kernel.
- Replaced the inherited Mistral SDK transport with a native Chat Completions HTTP stream, eliminating its generated client and schema runtime overhead.
- Changed `/goal` to use the same Task Application and `NativeLongTaskAgent` execution chain as resident Workers instead of maintaining an extension-owned Goal state machine.
- Centralized Task submission and control behind an idempotent Task Application boundary and made completion verification execute exactly once.
- Pinned unattended Task models at submission and isolated Resident Worker credentials to a one-time, Provider-scoped startup channel instead of inheriting the host environment.
- Reset the GitHub Release link-repair baseline to Ever's independent `cli-v0.0.1` release line.
- Replaced unpublished library npm links with source-workspace links and documented their current source-only distribution status.

### Fixed

- Fixed Goal and detached Task execution having divergent continuation, budget, completion, and recovery semantics.
- Fixed Resident Worker startup failures when deep agent directories exceeded Unix-domain socket path limits.
