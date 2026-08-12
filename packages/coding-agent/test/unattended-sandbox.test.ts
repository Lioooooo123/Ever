import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { probeUnattendedSandbox, UnattendedSandbox } from "../src/core/unattended-sandbox.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("UnattendedSandbox", () => {
	it("wraps the full Worker process tree, preserves its private token fd, and denies secret writes", async () => {
		const root = mkdtempSync(join(process.cwd(), ".karissa-sandbox-test-"));
		temporaryPaths.push(root);
		const agentDir = join(root, "agent");
		const workspaceRoot = join(root, "workspace");
		mkdirSync(agentDir);
		mkdirSync(workspaceRoot);
		const authPath = join(agentDir, "auth.json");
		writeFileSync(authPath, '{"anthropic":{"type":"api_key","key":"secret"}}');
		const capability = probeUnattendedSandbox();
		if (process.platform === "darwin") expect(capability).toMatchObject({ available: true, backend: "seatbelt" });
		if (!capability.available) return;
		const sandbox = new UnattendedSandbox(agentDir);
		expect(await sandbox.initialize()).toMatchObject({ available: true });
		try {
			const script = [
				"const fs = require('node:fs')",
				"fs.mkdirSync(process.cwd(), { recursive: true })",
				"fs.writeFileSync('allowed.txt', fs.readFileSync(3, 'utf8'))",
				"try { fs.writeFileSync('.env', 'secret') } catch { fs.writeFileSync('denied.txt', 'yes') }",
				`try { fs.readFileSync(${JSON.stringify(authPath)}, 'utf8') } catch { fs.writeFileSync('auth-denied.txt', 'yes') }`,
				`try { fs.writeFileSync(${JSON.stringify(authPath)}, 'clobbered') } catch { fs.writeFileSync('auth-write-denied.txt', 'yes') }`,
			].join(";");
			const wrapped = await sandbox.wrap(process.execPath, ["-e", script], workspaceRoot);
			await new Promise<void>((resolve, reject) => {
				const child = spawn(wrapped.command, [], {
					cwd: workspaceRoot,
					shell: true,
					stdio: ["ignore", "ignore", "pipe", "pipe"],
				});
				const tokenChannel = child.stdio[3];
				if (!(tokenChannel instanceof Writable)) throw new Error("Sandboxed Worker token fd did not open");
				tokenChannel.end("private-token\n");
				let stderr = "";
				child.stderr?.setEncoding("utf8");
				child.stderr?.on("data", (chunk) => {
					stderr += chunk;
				});
				child.once("error", reject);
				child.once("exit", (code) => {
					if (code === 0) resolve();
					else reject(new Error(`Sandboxed Worker exited ${code}: ${stderr}`));
				});
			});
			expect(readFileSync(join(workspaceRoot, "allowed.txt"), "utf8")).toBe("private-token\n");
			expect(existsSync(join(workspaceRoot, ".env"))).toBe(false);
			expect(readFileSync(join(workspaceRoot, "denied.txt"), "utf8")).toBe("yes");
			expect(readFileSync(join(workspaceRoot, "auth-denied.txt"), "utf8")).toBe("yes");
			expect(readFileSync(join(workspaceRoot, "auth-write-denied.txt"), "utf8")).toBe("yes");
			expect(readFileSync(authPath, "utf8")).toContain("secret");
			expect(wrapped.profileSha256).toMatch(/^[a-f0-9]{64}$/);
		} finally {
			await sandbox.close();
		}
	});
});
