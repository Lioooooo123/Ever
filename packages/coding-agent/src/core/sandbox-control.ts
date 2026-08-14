import { writeSync } from "node:fs";

/** File descriptor the foreground sandbox host reads for sandbox-control requests (see SessionExecutionHost). */
const SANDBOX_CONTROL_FD = 4;

export interface SandboxControlRequest {
	type: "updateAllowedDomains";
	domains: string[];
}

/** True when this process runs inside a foreground sandbox with a reachable control channel. */
export function sandboxControlAvailable(): boolean {
	return process.env.EVER_FOREGROUND_SANDBOX === "1";
}

/**
 * Ask the foreground sandbox host to hot-update the network allowlist so an
 * already-running Session can reach a newly granted domain without a restart.
 * Fail-closed: the host enforces the previous allowlist if this write fails.
 */
export function requestSandboxControl(request: SandboxControlRequest): void {
	if (!sandboxControlAvailable()) return;
	try {
		writeSync(SANDBOX_CONTROL_FD, `${JSON.stringify(request)}\n`);
	} catch {
		// The host may have exited; the command fails closed on the network boundary.
	}
}
