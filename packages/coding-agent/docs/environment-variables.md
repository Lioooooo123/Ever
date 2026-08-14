# Environment Variables

Ever uses environment variables in three ways:

- Variables such as `EVER_OFFLINE` configure the Ever process.
- Ever sets `EVER_CODING_AGENT` so child processes can detect that they run inside Ever.
- Commands run by the LLM-callable bash tool receive `EVER_*` variables describing the current Session.

Provider API-key variables are documented separately in [Providers](providers.md#environment-variables-or-auth-file).

## Process Marker

The CLI and RPC entry points set `EVER_CODING_AGENT=true`. Child processes inherit it and can use it to detect that they run inside Ever. It is not session-specific and is not set automatically when Ever is embedded through the SDK.

## Bash Tool Session Environment

Commands run by the bash tool receive the current Ever session state:

| Variable | Description |
|----------|-------------|
| `EVER_SESSION_ID` | Current session ID |
| `EVER_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `EVER_PROVIDER` | Currently selected model provider |
| `EVER_MODEL` | Currently selected model ID |
| `EVER_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next bash command without restarting Ever. `EVER_PROVIDER` and `EVER_MODEL` identify the selected Ever model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$EVER_PROVIDER" "$EVER_MODEL"
printf 'reasoning=%s session=%s\n' "$EVER_REASONING_LEVEL" "$EVER_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$EVER_SESSION_FILE" ]; then
  tail -n 1 "$EVER_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable bash tool. They are not injected into user-entered `!` or `!!` commands.

### Custom Bash Tools

Bash tools created with `createBashTool()` expose the session environment by default when registered with Ever. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const bashTool = createBashTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, Ever removes inherited values for these variables so nested Ever processes do not expose stale parent-session metadata.

## Ever Process Configuration

These variables are read by Ever itself:

| Variable | Description |
|----------|-------------|
| `EVER_CODING_AGENT_DIR` | Override the config directory; default is `~/.ever/agent` |
| `EVER_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `EVER_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `EVER_OFFLINE` | Disable startup network operations, including version checks, package updates, and provider model refreshes |
| `EVER_SKIP_VERSION_CHECK` | Disable the npm registry latest-version request for `@lioooooo123/ever-cli` |
| `EVER_TELEMETRY` | Control optional provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `EVER_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `EVER_SHARE_VIEWER_URL` | Optional custom viewer base URL used by `/share`; otherwise Ever opens the private gist directly |
| `EVER_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Providers](providers.md#environment-variables-or-auth-file).
