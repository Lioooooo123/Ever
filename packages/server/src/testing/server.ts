import { EverServer } from "../server.ts";
import type { EverServerOptions, EverServerService } from "../types.ts";
import { TestServerService } from "./service.ts";

export interface TestServerOptions extends EverServerOptions {
	service?: EverServerService;
}

export interface TestServer {
	server: EverServer;
	service: EverServerService;
}

/** Create an unstarted EverServer with deterministic defaults for transport conformance tests. */
export function createTestServer(options: TestServerOptions): TestServer {
	const service = options.service ?? new TestServerService();
	return {
		server: new EverServer(service, {
			listeners: options.listeners,
			maxFrameLength: options.maxFrameLength,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			serverId: options.serverId,
			onError: options.onError,
		}),
		service,
	};
}
