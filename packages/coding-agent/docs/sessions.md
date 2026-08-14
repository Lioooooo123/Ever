# Sessions

A Session is Ever's execution record for model messages, tool calls, compaction, and branching. Ever treats the Task as the public unit of work and attaches an internal Session to each Task Attempt.

Ever does not expose standalone Session selection flags such as `--continue`, `--resume`, `--session`, or `--fork`. Use Task commands to inspect and reconnect to work:

```bash
ever status
ever attach <task-id> --follow
```

## Storage

Ever Session files use JSONL with a tree structure. Each entry has an `id` and `parentId`, so the runtime can branch without rewriting history. The active Ever Task stores the Session path in its Attempt checkpoint and resumes that exact Session during recovery.

For the JSONL schema, see [Session Format](session-format.md).

## SDK access

Applications embedding the runtime can create in-memory or persistent Sessions through `SessionManager`:

```typescript
import { createAgentSession, SessionManager } from "@lioooooo123/ever-cli";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});
```

The SDK exposes Session naming, branching, compaction, export, and lifecycle events. See [SDK](sdk.md) for construction and cleanup rules.

## Recovery boundary

Ever advances a Task checkpoint only after the corresponding Ever turn settles. If a Worker stops before the outcome is known, Ever records `unknown_outcome` and does not silently replay the goal or external side effects.

Task recovery, lease ownership, and completion policy belong to Ever. Message history, model context, tools, and compaction belong to Ever.
