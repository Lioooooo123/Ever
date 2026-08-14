# Ever Quickstart

## Install

```bash
npm install -g --ignore-scripts @lioooooo123/ever-cli
```

`--ignore-scripts` disables dependency lifecycle scripts. Ever does not require install scripts for normal npm installs.

## Authenticate

Set the credential for the provider you want to use:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Existing credentials in the Ever auth store remain available to the embedded runtime. See [Providers](providers.md) for supported providers and authentication options.

## Start a Task

Run Ever in the repository you want it to change:

```bash
cd /path/to/project
ever "inspect this repository and run its focused checks" --yes
```

Add an acceptance command when completion depends on a deterministic check:

```bash
ever "fix the type errors" --verify "npm run check" --yes
```

Ever creates a durable Task, starts a Worker, records attempts and evidence, and follows the Task until it reaches a terminal state.

## Inspect and reconnect

```bash
ever status
ever attach <task-id> --follow
```

For automation, use JSONL RPC:

```bash
printf '%s\n' '{"id":1,"method":"task.list"}' | ever --mode rpc
```

## Embedded Ever runtime

Ever's embedded execution kernel owns model calls, tools, context management, and Session persistence. Sessions are internal execution records attached to Task Attempts. SDK consumers can access them through `createAgentSession()` and `SessionManager`; they are not separate Ever CLI entrypoints.

See [SDK](sdk.md), [Sessions](sessions.md), and [RPC](rpc.md) for the internal runtime APIs.

## Uninstall

```bash
npm uninstall -g @lioooooo123/ever-cli
```

Uninstalling the package does not delete local configuration, credentials, Tasks, or Session records.
