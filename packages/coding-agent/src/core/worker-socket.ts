import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Keep Unix-domain socket paths below macOS/Linux sockaddr_un limits, even for deep agent directories. */
export function workerSocketDirectory(agentDir: string): string {
	const owner = process.getuid?.() ?? "user";
	const identity = createHash("sha256").update(agentDir).digest("hex").slice(0, 16);
	const socketRoot = process.platform === "darwin" ? "/private/tmp" : process.platform === "win32" ? tmpdir() : "/tmp";
	return join(socketRoot, `ever-${owner}-${identity}`);
}

export function createWorkerSocketPath(agentDir: string, agentId: string): string {
	const directory = workerSocketDirectory(agentDir);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	return join(directory, `${agentId}.sock`);
}

export function createDaemonSocketPath(agentDir: string): string {
	return createWorkerSocketPath(agentDir, "daemon");
}
