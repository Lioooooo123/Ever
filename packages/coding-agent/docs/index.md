# Ever Documentation

Ever is a durable coding agent for long-running development Tasks. Its embedded execution kernel owns model interaction, tools, context management, Sessions, and terminal UI components.

## Quick start

```bash
npm install -g --ignore-scripts @lioooooo123/ever-cli
ever "inspect this repository and run its focused checks" --yes
```

See [Quickstart](quickstart.md) for authentication, acceptance commands, status, attach, and RPC examples.

## Ever Tasks

- [Using Ever](usage.md) describes Task execution and the CLI surface.
- [Security](security.md) covers trust and sandbox boundaries.
- [Containerization](containerization.md) covers Docker, Gondolin, and OpenShell isolation.
- [Settings](settings.md) lists runtime configuration.
- [Providers](providers.md) documents authentication and model setup.

## Embedded Ever runtime

- [SDK](sdk.md) embeds the agent and Session runtime in Node.js applications.
- [Sessions](sessions.md) explains the internal Task-to-Session relationship.
- [Session format](session-format.md) specifies the JSONL record format.
- [Compaction](compaction.md) covers context compaction and branch summaries.
- [RPC mode](rpc.md) documents stdin/stdout JSONL integration.
- [JSON events](json.md) documents structured runtime events.

## Runtime customization

- [Extensions](extensions.md) add tools, commands, events, and custom UI.
- [Skills](skills.md) provide reusable on-demand capabilities.
- [Prompt templates](prompt-templates.md) expand reusable prompts.
- [Themes](themes.md) customize the terminal interface.
- [Ever packages](packages.md) bundle runtime extensions, skills, prompts, and themes.
- [Custom models](models.md) add model entries for supported provider APIs.
- [Custom providers](custom-provider.md) implement custom APIs and OAuth flows.
- [TUI components](tui.md) build terminal interfaces for extensions.

## Platform and development

- [Windows](windows.md)
- [Termux](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)
- [Development](development.md)
- [Environment variables](environment-variables.md)
