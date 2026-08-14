import { describe, expect, it } from "vitest";
import { maybeReexecForegroundTask, maybeReexecSessionSandboxed } from "../src/cli/foreground-sandbox.ts";

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
});
