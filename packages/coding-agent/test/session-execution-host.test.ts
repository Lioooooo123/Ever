import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionExecutionHost } from "../src/core/session-execution-host.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("SessionExecutionHost", () => {
	it("uses an explicit unsafe host only when requested", async () => {
		const root = mkdtempSync(join(tmpdir(), "ever-session-host-"));
		temporaryPaths.push(root);
		const logFd = openSync(join(root, "worker.log"), "a", 0o600);
		const host = new SessionExecutionHost(join(root, "agent"), true);
		expect(await host.initialize()).toMatchObject({ available: false, reason: "explicitly disabled" });
		try {
			const hosted = await host.start({
				command: process.execPath,
				args: ["-e", "process.exit(0)"],
				cwd: root,
				logFd,
				env: {},
			});
			hosted.tokenChannel.end();
			await new Promise<void>((resolve, reject) => {
				hosted.child.once("error", reject);
				hosted.child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`))));
			});
			expect(hosted.environment).toMatchObject({ trust: "unsafe_host", workspaceRoot: root });
		} finally {
			closeSync(logFd);
			await host.close();
		}
	});
});
