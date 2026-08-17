import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	maybeReexecForegroundTask,
	maybeReexecSessionSandboxed,
	resolveForegroundCredentials,
} from "../src/cli/foreground-sandbox.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("foreground sandbox re-exec", () => {
	it("fails closed when no sandbox is available", async () => {
		const result = await maybeReexecForegroundTask({ agentDir: "/tmp/ever-agent", taskId: "missing" }, () => ({
			available: false,
			backend: "unsupported",
			reason: "no sandbox on this platform",
		}));
		expect(result).toEqual({ replaced: false, exitCode: null });
	});

	it("fails closed when the Task store cannot be opened", async () => {
		const result = await maybeReexecForegroundTask({ agentDir: "/nonexistent/agent-dir", taskId: "missing" }, () => ({
			available: true,
			backend: "seatbelt",
		}));
		expect(result).toEqual({ replaced: false, exitCode: null });
	});

	it("skips Session re-exec when no sandbox is available", async () => {
		const result = await maybeReexecSessionSandboxed(
			{ agentDir: "/tmp/ever-agent", cwd: "/tmp/ever-workspace" },
			() => ({ available: false, backend: "unsupported", reason: "no sandbox on this platform" }),
		);
		expect(result).toEqual({ replaced: false, exitCode: null });
	});

	it("skips Session re-exec when no usable credentials exist", async () => {
		const result = await maybeReexecSessionSandboxed(
			{ agentDir: "/nonexistent/agent-dir", cwd: "/tmp/ever-workspace" },
			() => ({ available: true, backend: "seatbelt" }),
		);
		expect(result).toEqual({ replaced: false, exitCode: null });
	});

	it("merges auth.json credentials with ambient API keys for sandbox startup", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "ever-foreground-credentials-"));
		temporaryPaths.push(agentDir);
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ anthropic: { type: "api_key", key: "anthropic-from-auth" } }),
		);
		const previous = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "openai-from-env";
		try {
			await expect(resolveForegroundCredentials(agentDir, "openai")).resolves.toMatchObject({
				anthropic: { type: "api_key", key: "anthropic-from-auth" },
				openai: { type: "api_key", key: "openai-from-env" },
			});
		} finally {
			if (previous === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previous;
		}
	});
});
