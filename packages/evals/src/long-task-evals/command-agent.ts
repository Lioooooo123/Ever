import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter, AgentRunOutcome, EnvironmentCommand, EvalEnvironment } from "./contracts.ts";
import type { AgentIdentity, EvalCase } from "./schemas.ts";

export interface AgentPreparation {
	copyIn?: Array<{ source: string; destination: string }>;
	commands?: EnvironmentCommand[];
}

async function prepareAgent(environment: EvalEnvironment, preparation: AgentPreparation | undefined): Promise<void> {
	for (const item of preparation?.copyIn ?? []) await environment.copyIn(item.source, item.destination);
	for (const command of preparation?.commands ?? []) {
		const result = await environment.exec(command);
		if (result.exitCode !== 0 || result.timedOut) {
			throw new Error(`Agent setup failed: ${result.stderr.trim() || result.stdout.trim()}`);
		}
	}
}

export interface CommandAgentConfig {
	identity: AgentIdentity;
	command: string[];
	environment?: Record<string, string> | (() => Record<string, string>);
	preparation?: AgentPreparation;
}

export class CommandAgentAdapter implements AgentAdapter {
	readonly identity: AgentIdentity;
	readonly #config: CommandAgentConfig;

	constructor(config: CommandAgentConfig) {
		this.identity = config.identity;
		this.#config = config;
	}

	async run(
		testCase: EvalCase,
		environment: EvalEnvironment,
		runDirectory: string,
		budget: { maxCostUsd?: number },
	): Promise<AgentRunOutcome> {
		await prepareAgent(environment, this.#config.preparation);
		const args = this.#config.command.map((value) =>
			value
				.replaceAll("{instruction}", testCase.instruction)
				.replaceAll("{maxCostUsd}", budget.maxCostUsd === undefined ? "" : String(budget.maxCostUsd)),
		);
		if (!this.#config.command.some((value) => value.includes("{instruction}"))) args.push(testCase.instruction);
		const result = await environment.exec({
			args,
			cwd: testCase.environment.workingDirectory,
			env: {
				...(typeof this.#config.environment === "function" ? this.#config.environment() : this.#config.environment),
				...(budget.maxCostUsd === undefined ? {} : { EVER_EVAL_MAX_COST_USD: String(budget.maxCostUsd) }),
			},
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
								source: "agent",
								code: result.timedOut ? "timeout" : "nonzero_exit",
								message: result.stderr.trim() || `Agent exited with ${result.exitCode ?? "unknown"}`,
							},
						],
		};
	}

	async stop(_reason: "timeout" | "cancelled" | "fault"): Promise<void> {
		// The environment adapter enforces the process timeout and destroys the trial container.
	}
}

export class CodexAgentAdapter extends CommandAgentAdapter {}

export class TerminusAgentAdapter extends CommandAgentAdapter {}
