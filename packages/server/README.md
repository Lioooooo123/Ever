# @lioooooo123/ever-server

Experimental. This package is under active development and may change or be removed without notice. Its APIs and behavior are not yet stable.

Server package for Ever.

## Session server core

The package exports the `EverServer` session server.

```ts
import type { EverServerService } from "@lioooooo123/ever-server";
import { createUnixServer } from "@lioooooo123/ever-server/unix";

const service: EverServerService = {
  async listSessions() {
    return storage.listSessions();
  },
  async listModels() {
    return modelRegistry.listModels();
  },
  async createSession(options) {
    return storage.createAndOpen(options);
  },
  async openSession(sessionId) {
    return storage.open(sessionId);
  },
};

const server = createUnixServer(service, {
  path: "/tmp/Ever/server.sock",
});
await server.start();
```

`EverServer` composes transport listeners through the `EverServerListener` interface. Each listener must complete any transport-specific authentication and authorization before passing a connection to `EverServer`. For example, a WebSocket listener can validate credentials during the HTTP upgrade, while the Unix listener relies on socket filesystem permissions. The Unix submodule exports the `createUnixListener()` building block and `createUnixServer()` preset, keeping the common case concise without coupling the primary server to Unix sockets. The listener uses length-prefixed CBOR messages from `@lioooooo123/ever-protocol`.

This package does not provide a standalone CLI or coding-agent service. Applications supply the `EverServerService` implementation.

`EverServerService.listSessions()` returns protocol `SessionMetadata`, not acquired runtime state. Services should map the durable fields their storage supports and may omit `updatedAt`, `parentSessionId`, `sessionName`, and `cwd`. `EverServer` refreshes available metadata from live snapshots without requiring stored sessions to fabricate phase, model, thinking-level, attachment, or lock values.

## Transport testing

Custom transports can use `@lioooooo123/ever-server/testing` for deterministic protocol conformance tests. It exports `createTestServer()`, `TestServerService`, `ProtocolTestClient`, and the transport-neutral `WireChannel` contract. `connectUnixTestClient()` is provided for Unix transport tests.

## `Ever-ai` protocol bridge

`@lioooooo123/ever-ai` domain objects and `@lioooooo123/ever-protocol` wire DTOs remain independent. This package owns their boundary and exports `toProtocolModelMetadata()`, `toProtocolAssistantMessage()`, `toProtocolUserMessage()`, and `toProtocolToolResultMessage()`.

The adapters reject invalid tool inputs, identifiers, timestamps, and mismatched tool results; `toProtocolToolResultMessage()` requires the original `ToolCall` so it can verify the association and convert its arguments itself. Diagnostic details are explicitly sanitized. Closed `Ever-ai` unions are mapped exhaustively, and compile-time field manifests enumerate current `Ever-ai` properties so additions require an explicit review. The protocol mirrors `Ever-ai` vocabulary such as `toolCall` and `toolUse` where the semantics are identical. Protocol schemas enforce consistent lifecycle states, and tests encode adapter output through the runtime schemas so incompatible changes fail in the bridging package.
