import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@lioooooo123/ever-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { RADIUS_PROVIDER_ID } from "../src/core/radius.ts";
import { allowNetwork } from "./test-network-env.ts";

function radiusOAuthCredential(gatewayBaseUrl: string) {
	return {
		type: "oauth" as const,
		access: "access-token",
		refresh: "refresh-token",
		expires: Date.now() + 60 * 60 * 1000,
		gatewayConfig: radiusConfig(gatewayBaseUrl),
	};
}

function radiusConfig(baseUrl: string) {
	return {
		baseUrl,
		models: [
			{
				id: "auto",
				name: "Radius Auto",
				reasoning: false,
				input: ["text" as const],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
	};
}

let tempDir: string;

beforeEach(() => {
	allowNetwork();
	tempDir = join(tmpdir(), `ever-test-radius-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
});

describe("Radius provider", () => {
	it("does not trust a gateway embedded only in stored credentials", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				[RADIUS_PROVIDER_ID]: radiusOAuthCredential("https://radius.example.com/v1"),
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});

		expect(runtime.getModels(RADIUS_PROVIDER_ID)).toEqual([]);
		expect(runtime.getProvider(RADIUS_PROVIDER_ID)).toBeUndefined();
	});

	it("does not send a stored token to an implicitly restored gateway", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify(radiusConfig("https://radius.example.com/v1")), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const credentials = AuthStorage.inMemory({
			[RADIUS_PROVIDER_ID]: radiusOAuthCredential("https://radius.example.com/v1"),
		});
		const runtime = await ModelRuntime.create({
			credentials,
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: true,
		});

		expect(runtime.getModels(RADIUS_PROVIDER_ID)).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not refresh catalogs over the network by default", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected catalog fetch"));
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				[RADIUS_PROVIDER_ID]: radiusOAuthCredential("https://radius.example.com/v1"),
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
		});

		expect(runtime.getModels(RADIUS_PROVIDER_ID)).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not fetch or expose Radius models without configured auth", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: true,
		});

		expect(runtime.getModels(RADIUS_PROVIDER_ID)).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("supports custom Radius gateways from models.json", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response(JSON.stringify(radiusConfig("http://localhost:8788/v1")), { status: 200 }),
		);
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { "radius-dev": { name: "Radius (dev)", baseUrl: "http://localhost:8788", oauth: "radius" } },
			}),
		);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				"radius-dev": {
					type: "oauth",
					access: "access-token",
					refresh: "refresh-token",
					expires: Date.now() + 60 * 60 * 1000,
				},
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath,
			allowModelNetwork: true,
		});

		expect(runtime.getModel("radius-dev", "auto")).toMatchObject({
			api: "ever-messages",
			baseUrl: "http://localhost:8788/v1",
		});
		expect(runtime.getProvider("radius-dev")?.name).toBe("Radius (dev)");
	});

	it("requires baseUrl for custom Radius gateways", async () => {
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { "radius-dev": { oauth: "radius" } } }));
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath,
			allowModelNetwork: false,
		});

		expect(runtime.getError()).toContain('"baseUrl" is required when "oauth" is set');
	});
});
