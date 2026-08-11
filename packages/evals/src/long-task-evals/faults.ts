import type { AgentAdapter, EvalEnvironment } from "./contracts.ts";

export type FaultSpec =
	| { type: "kill_agent_process"; afterMs: number }
	| { type: "kill_daemon_process"; afterMs: number; processPattern?: string }
	| { type: "pause_agent_process"; afterMs: number; durationMs: number; processPattern?: string }
	| { type: "terminate_container"; afterMs: number };

export interface FaultResult {
	type: FaultSpec["type"];
	requestedAtMs: number;
	status: "injected" | "cancelled" | "failed";
	message?: string;
}

export interface ActiveTrial {
	agent: AgentAdapter;
	environment: EvalEnvironment;
}

export interface FaultInjector {
	inject(schedule: readonly FaultSpec[], trial: ActiveTrial, signal: AbortSignal): Promise<FaultResult[]>;
}

async function waitUntil(startedAt: number, afterMs: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return false;
	const remaining = Math.max(0, startedAt + afterMs - Date.now());
	if (remaining === 0) return !signal.aborted;
	return await new Promise((resolve) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve(true);
		}, remaining);
		const abort = (): void => {
			clearTimeout(timeout);
			resolve(false);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

export class ProcessFaultInjector implements FaultInjector {
	async inject(schedule: readonly FaultSpec[], trial: ActiveTrial, signal: AbortSignal): Promise<FaultResult[]> {
		const results: FaultResult[] = [];
		const startedAt = Date.now();
		for (const fault of [...schedule].sort((left, right) => left.afterMs - right.afterMs)) {
			if (!(await waitUntil(startedAt, fault.afterMs, signal))) {
				results.push({ type: fault.type, requestedAtMs: fault.afterMs, status: "cancelled" });
				continue;
			}
			try {
				if (fault.type === "kill_agent_process") {
					await trial.agent.stop("fault");
				} else if (fault.type === "terminate_container") {
					await trial.environment.destroy();
				} else {
					const pattern =
						fault.processPattern ??
						(fault.type === "kill_daemon_process" ? "karissa.*daemon.*serve" : "karissa.*task.*run");
					const signalName = fault.type === "pause_agent_process" ? "STOP" : "TERM";
					const sent = await trial.environment.exec({
						args: ["pkill", `-${signalName}`, "-f", pattern],
						timeoutSeconds: 30,
					});
					if (sent.exitCode !== 0 || sent.timedOut)
						throw new Error(sent.stderr.trim() || `pkill exited ${sent.exitCode ?? "unknown"}`);
					if (fault.type === "pause_agent_process") {
						await new Promise((resolve) => setTimeout(resolve, fault.durationMs));
						const resumed = await trial.environment.exec({
							args: ["pkill", "-CONT", "-f", pattern],
							timeoutSeconds: 30,
						});
						if (resumed.exitCode !== 0 || resumed.timedOut)
							throw new Error(resumed.stderr.trim() || "Failed to resume agent process");
					}
				}
				results.push({ type: fault.type, requestedAtMs: fault.afterMs, status: "injected" });
			} catch (error) {
				results.push({
					type: fault.type,
					requestedAtMs: fault.afterMs,
					status: "failed",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return results;
	}
}
