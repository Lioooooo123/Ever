import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter, AgentRunOutcome, EvalEnvironment } from "./contracts.ts";
import { sha256 } from "./hash.ts";
import type { AgentIdentity, EvalCase } from "./schemas.ts";

function identity(name: string, executableDigest: string): AgentIdentity {
	return {
		name,
		version: "1.0.0",
		executableDigest,
		modelProvider: "none",
		modelId: name,
		configurationDigest: sha256(`ever-long-horizon\0${name}\x001.0.0`),
	};
}

export class OwnedOracleAgentAdapter implements AgentAdapter {
	readonly identity: AgentIdentity;

	constructor(agentIdentity: AgentIdentity) {
		this.identity = agentIdentity;
	}

	async run(testCase: EvalCase, environment: EvalEnvironment, runDirectory: string): Promise<AgentRunOutcome> {
		const solution = join(testCase.taskRoot, "oracle", "solve.sh");
		await environment.copyIn(solution, "/tmp/ever-long-horizon-oracle.sh");
		const result = await environment.exec({
			args: ["sh", "/tmp/ever-long-horizon-oracle.sh"],
			cwd: testCase.environment.workingDirectory,
			timeoutSeconds: testCase.limits.trialTimeoutSeconds,
		});
		const agentDirectory = join(runDirectory, "agent");
		await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
		await writeFile(join(agentDirectory, "stdout.txt"), result.stdout, { mode: 0o600 });
		await writeFile(join(agentDirectory, "stderr.txt"), result.stderr, { mode: 0o600 });
		return {
			outcome: result.timedOut ? "timed_out" : result.exitCode === 0 ? "completed" : "failed",
			usage: {},
			errors:
				result.exitCode === 0 && !result.timedOut
					? []
					: [
							{
								source: "oracle",
								code: result.timedOut ? "timeout" : "nonzero_exit",
								message: result.stderr.trim() || `Oracle exited with ${result.exitCode ?? "unknown"}`,
							},
						],
		};
	}

	async stop(_reason: "timeout" | "cancelled" | "fault"): Promise<void> {}
}

export class NoopAgentAdapter implements AgentAdapter {
	readonly identity: AgentIdentity;

	constructor(agentIdentity: AgentIdentity = identity("no-op", sha256("owned-long-horizon-no-op"))) {
		this.identity = agentIdentity;
	}

	async run(): Promise<AgentRunOutcome> {
		return { outcome: "completed", usage: {}, errors: [] };
	}

	async stop(_reason: "timeout" | "cancelled" | "fault"): Promise<void> {}
}
