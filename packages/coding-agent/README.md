# Ever

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Sessions and Goals

Ever is Session-native. Normal prompts use the same interactive Session, history, resume, branching, and compaction flow. Long-running autonomous work is opt-in through `/goal` inside that Session.

```bash
# Open Ever
ever

# Start with an ordinary prompt
ever "inspect this repository and explain the architecture"

# Or open the TUI and start a long-running Goal
ever
/goal refactor the repository and run the focused tests
/goal status

# Resume the same Session later
ever --continue
ever --resume
```

Goal mode automatically continues after a settled turn until the agent reports verified completion, a configured budget is exhausted, or the same blocker is reported on three consecutive Goal turns. `/goal pause`, `/goal complete`, `/goal blocked`, and `/goal clear` stop an in-flight Goal turn immediately. The Goal remains part of the current Session and survives compaction, resume, and branch navigation.

Detached Worker execution remains available as the advanced `ever task` control plane. It is not the default product path.

---

## Ever runtime

The embedded runtime is Ever's agent execution kernel. It owns model interaction, tools, context, Sessions, and the terminal UI. Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes). Put reusable extensions, skills, prompt templates, and themes in [Ever Packages](#ever-packages).

Ever runs in four modes: interactive, print or JSON, RPC for process integration, and an SDK for embedding in your own apps.

## Table of Contents

- [Sessions and Goals](#sessions-and-goals)
- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Ever Packages](#ever-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

```bash
npm install -g --ignore-scripts @lioooooo123/ever
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Ever does not require install scripts for normal npm installs.

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
ever "inspect this repository and run the focused checks"
```

The embedded Ever runtime provides four tools by default: `read`, `write`, `edit`, and `bash`. Add runtime capabilities with [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [Ever packages](#ever-packages).

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

For each built-in provider, ever maintains a list of tool-capable models. Configured provider catalogs refresh automatically; run `ever update --models` to force an immediate refresh. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L).

**Subscriptions:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API keys:**
- Anthropic
- Ant Ling
- OpenAI
- Azure OpenAI
- DeepSeek
- NVIDIA NIM
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI Coding Plan (Global)
- ZAI Coding Plan (China)
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Baseten
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)

Ever also supports the llama.cpp router server. Configure it with `/login llama.cpp`, manage downloads and loaded models with `/llama`, then select a loaded model with `/model`. See [docs/llama-cpp.md](docs/llama-cpp.md) for setup and usage.

See [docs/providers.md](docs/providers.md) for other provider setup instructions.

**Custom providers & models:** Add providers via `~/.ever/agent/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, session name, total token/cache usage (`↑` input, `↓` output, `R` cache read, `W` cache write, `CH` latest cache hit rate), cost, context usage, current model. Totals include assistant responses, usage reported by tools, and summary generation.

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| External editor | Ctrl+G opens `externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere |
| Clipboard | Ctrl+V to paste an image or text (Alt+V on Windows), or drag images onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage provider credentials |
| [`/llama`](docs/llama-cpp.md) | Download, load, and unload llama.cpp router models |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/goal [objective]` | Start or inspect an opt-in long-running Goal in this Session |
| `/goal status\|pause\|resume\|complete\|blocked\|clear` | Control the active Goal lifecycle |
| `/goal limit turns\|minutes\|tokens <n>` | Bound automatic Goal continuation |
| `/trust` | Save project trust decision for future sessions (restart required) |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML or JSONL file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, themes, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit ever |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.ever/agent/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |
| Ctrl+X | Copy the last assistant message |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so ever can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

A Session is Ever's normal user-facing unit of work. Use `--continue`, `--resume`, `--session`, `--session-id`, and `--fork` to return to or branch existing work. `/goal` adds long-running state to the active Session without replacing its transcript or navigation model. See [Session details](docs/sessions.md).

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history and Goal state remain in the Session record. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.ever/agent/settings.json` | Global (all projects) |
| `.ever/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

### Project Trust

On interactive startup, ever asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.ever/agent/trust.json`. Trusting a project allows ever to load `.ever/settings.json` and `.ever` resources, install missing project packages, and execute project extensions.

Before the trust decision, ever loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.ever/agent/settings.json`, or change it with `/settings`.

`ever config` and package commands use the same project trust flow, except `ever update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.ever/agent/trust.json` only; the current session is not reloaded, so restart Ever for changes to take effect.

### Provider attribution and update checks

Ever has two separate startup features:

- **Update check:** reads the latest `@lioooooo123/ever` metadata from the npm registry. Disable it with `EVER_SKIP_VERSION_CHECK=1`.
- **Provider attribution:** `EVER_TELEMETRY=0` disables optional attribution headers for OpenRouter, Cloudflare, and direct NVIDIA NIM requests. Ever does not send install or update pings.

Use `--offline` or `EVER_OFFLINE=1` to disable startup network operations, including version checks, package update checks, and provider model refreshes.

---

## Context Files

Ever loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.ever/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

If a directory contains `AGENTS.override.md`, Ever loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory. Context files from other directories are still concatenated.

Use for project instructions (`AGENTS.md`/`CLAUDE.md`), conventions, common commands. All matching files are concatenated.

Disable context file loading with `--no-context-files` (or `-nc`).

### System Prompt

Replace the default system prompt with `.ever/SYSTEM.md` (project) or `~/.ever/agent/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.ever/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.ever/agent/prompts/`, `.ever/prompts/`, or a [Ever package](#ever-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name` or let the agent load them automatically.

```markdown
<!-- ~/.ever/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `~/.ever/agent/skills/`, `~/.agents/skills/`, `.ever/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [Ever package](#ever-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend ever with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (ever: ExtensionAPI) {
  ever.registerTool({ name: "deploy", ... });
  ever.registerCommand("stats", { ... });
  ever.on("tool_call", async (event, ctx) => { ... });
}
```

The default export can also be `async`. ever waits for async extension factories before startup continues, which is useful for one-time initialization such as fetching remote model lists before calling `ever.registerProvider()`.

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make ever look like Claude Code
- Games while waiting (yes, Doom runs)
- Other runtime capabilities provided by extensions

Place in `~/.ever/agent/extensions/`, `.ever/extensions/`, or a [Ever package](#ever-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and ever immediately applies changes.

Place in `~/.ever/agent/themes/`, `.ever/themes/`, or a [Ever package](#ever-packages) to share with others. See [docs/themes.md](docs/themes.md).

### Ever Packages

Bundle and share extensions, skills, prompts, and themes via npm or Git. Find published packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Aever-package).

> **Security:** Ever packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
ever install npm:@foo/ever-tools
ever install npm:@foo/ever-tools@1.2.3      # pinned version
ever install git:github.com/user/repo
ever install git:github.com/user/repo@v1  # tag or commit
ever install git:git@github.com:user/repo
ever install git:git@github.com:user/repo@v1  # tag or commit
ever install https://github.com/user/repo
ever install https://github.com/user/repo@v1      # tag or commit
ever install ssh://git@github.com/user/repo
ever install ssh://git@github.com/user/repo@v1    # tag or commit
ever remove npm:@foo/ever-tools
ever uninstall npm:@foo/ever-tools          # alias for remove
ever list
ever update                               # update Ever only
ever update --all                         # update Ever and packages
ever update --extensions                  # update packages only
ever update --models                      # refresh model catalogs only
ever update --self                        # update Ever only
ever update --self --force                # reinstall Ever even if current
ever update npm:@foo/ever-tools             # update one package
ever config                               # enable/disable extensions, skills, prompts, themes
```

Packages install to `~/.ever/agent/git/` (git) or `~/.ever/agent/npm/` (npm). Use `-l` for project-local installs (`.ever/git/`, `.ever/npm/`). Git `@ref` values are pinned tags or commits; pinned packages are skipped by `ever update --extensions` and `ever update --all`, so use `ever install git:host/user/repo@new-ref` to move an existing package to a new ref. Git packages install dependencies with `npm install --omit=dev` by default, so runtime deps must be listed under `dependencies`; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers. If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `ever` key to `package.json`:

```json
{
  "name": "my-ever-package",
  "keywords": ["ever-package"],
  "ever": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `ever` manifest, ever auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@lioooooo123/ever";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
ever --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Design principles

Ever is Session-native. Ordinary interaction stays conversational and user-driven; `/goal` explicitly promotes one objective into bounded, automatically continuing work within the same Session.

The Goal lifecycle is `reasoning -> execute -> observe -> verify -> repair`, repeated until evidence proves completion, a budget pauses execution, or a repeated blocker requires the user. Advanced detached Tasks additionally use checkpoints, leases, and effect records for Worker recovery.

Extensions, skills, prompt templates, and packages customize execution without creating a second agent loop. Sandboxing and explicit approval boundaries protect unattended work.

---

## CLI Reference

```bash
ever [prompt] [options]
```

### Package Commands

```bash
ever install <source> [-l]     # Install package, -l for project-local
ever remove <source> [-l]      # Remove package
ever uninstall <source> [-l]   # Alias for remove
ever update [source|self]        # Update Ever itself or one package source
ever update --all              # Update ever and packages
ever update --extensions       # Update packages only
ever update --models           # Refresh model catalogs only
ever update --self             # Update ever only
ever update --self --force     # Reinstall ever even if current
ever update --extension <src>  # Update one package
ever list                      # List installed packages
ever config                    # Enable/disable package resources
```

`ever config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `ever update` never prompts for project trust.

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, ever also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | ever -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific tool names across built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific tool names across built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools by default but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools by default |

Available built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable AGENTS.md and CLAUDE.md context file discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--tui-mode <mode>` | TUI mode: `regular` (default) or experimental `fullscreen` |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
ever @prompt.md "Answer this"
ever -p @screenshot.png "What's in this image?"
ever @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
ever "List all .ts files in src/"

# Non-interactive
ever -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | ever -p "Summarize this text"

# Different model
ever --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
ever --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
ever --model sonnet:high "Solve this complex problem"

# Limit model cycling
ever --models "claude-*,gpt-4o"

# Read-only mode
ever --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
ever --exclude-tools ask_question

# High thinking level
ever --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AI_AGENT` | Set to `ever` by the CLI and RPC entry points so generic tooling can attribute child processes to Ever |
| `EVER_CODING_AGENT` | Set to `true` by the CLI and RPC entry points so child processes can detect that they run inside Ever |
| `EVER_CODING_AGENT_DIR` | Override config directory (default: `~/.ever/agent`) |
| `EVER_CODING_AGENT_SESSION_DIR` | Override session storage directory (overridden by `--session-dir`) |
| `EVER_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `EVER_OFFLINE` | Disable startup network operations, including update checks, package update checks, and provider model refreshes |
| `EVER_SKIP_VERSION_CHECK` | Skip the Ever package version check at startup. This prevents the npm registry latest-version request |
| `EVER_TELEMETRY` | Control optional provider attribution headers. Use `1`/`true`/`yes` to enable or `0`/`false`/`no` to disable. This does not disable update checks |
| `EVER_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | Fallback external editor for Ctrl+G when `externalEditor` is unset; defaults to Notepad on Windows and `nano` elsewhere |

Commands run by the LLM-callable bash tool also receive current session metadata:

| Variable | Description |
|----------|-------------|
| `EVER_SESSION_ID` | Current session ID |
| `EVER_SESSION_FILE` | Absolute session JSONL path; unset for ephemeral sessions |
| `EVER_PROVIDER` | Currently selected model provider |
| `EVER_MODEL` | Currently selected model ID |
| `EVER_REASONING_LEVEL` | Current effective reasoning level |

These values are resolved when each command starts. See [Environment Variables](docs/environment-variables.md#bash-tool-session-environment) for semantics, examples, and custom-tool opt-out.

---

## Contributing & Development

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines and [docs/development.md](docs/development.md) for setup, forking, and debugging.

## License

MIT

## See Also

- [@lioooooo123/ever-ai](https://www.npmjs.com/package/@lioooooo123/ever-ai): Core LLM toolkit
- [@lioooooo123/ever-agent-core](https://www.npmjs.com/package/@lioooooo123/ever-agent-core): Agent framework
- [@lioooooo123/ever-tui](https://www.npmjs.com/package/@lioooooo123/ever-tui): Terminal UI components

[Ever source and releases](https://github.com/Lioooooo123/Ever)
