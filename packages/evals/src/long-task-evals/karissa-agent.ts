import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentPreparation } from "./command-agent.ts";
import type { AgentAdapter, AgentRunOutcome, EvalEnvironment } from "./contracts.ts";
import type { AgentIdentity, EvalCase, EvalRunResult } from "./schemas.ts";

interface KarissaTaskJson {
	schemaVersion: 1;
	id: string;
	state: string;
	totalTurns: number;
	totalCostUsd: number;
}

interface KarissaEventJson {
	schemaVersion: 1;
	seq: number;
	type: string;
	createdAt: string;
	[key: string]: unknown;
}

export interface KarissaAgentConfig {
	identity: AgentIdentity;
	command?: string;
	environment?: Record<string, string> | (() => Record<string, string>);
	preparation?: AgentPreparation;
	maxTurns?: number;
	maxCostUsd: number;
}

function parseObject(text: string, label: string): Record<string, unknown> {
	const value = JSON.parse(text) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${label} is not a JSON object`);
	if (Reflect.get(value, "schemaVersion") !== 1) throw new Error(`${label} has an unsupported schemaVersion`);
	return value as Record<string, unknown>;
}

function parseTask(text: string): KarissaTaskJson {
	const value = parseObject(text, "karissa task show");
	if (
		typeof value.id !== "string" ||
		typeof value.state !== "string" ||
		typeof value.totalTurns !== "number" ||
		typeof value.totalCostUsd !== "number"
	) {
		throw new Error("karissa task show returned an invalid payload");
	}
	return value as unknown as KarissaTaskJson;
}

function parseEvents(text: string): KarissaEventJson[] {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const value = parseObject(line, "karissa task events");
			if (typeof value.seq !== "number" || typeof value.type !== "string" || typeof value.createdAt !== "string") {
				throw new Error("karissa task events returned an invalid payload");
			}
			return value as unknown as KarissaEventJson;
		});
}

async function wait(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class KarissaAgentAdapter implements AgentAdapter {
	readonly identity: AgentIdentity;
	readonly #config: KarissaAgentConfig;
	#activeEnvironment?: EvalEnvironment;

	constructor(config: KarissaAgentConfig) {
		this.identity = config.identity;
		this.#config = config;
	}

	async #exec(environment: EvalEnvironment, args: string[], timeoutSeconds = 30) {
		return await environment.exec({
			args: [this.#config.command ?? "karissa", ...args],
			cwd: "/app",
			env: {
				KARISSA_CODING_AGENT_DIR: "/tmp/karissa-agent",
				KARISSA_UNATTENDED_SANDBOX: "1",
				...(typeof this.#config.environment === "function" ? this.#config.environment() : this.#config.environment),
			},
			timeoutSeconds,
		});
	}

	async #stopDaemon(environment: EvalEnvironment): Promise<void> {
		const stop = await this.#exec(environment, ["daemon", "stop", "--json"], 30);
		if (stop.exitCode !== 0 || stop.timedOut) throw new Error(`Karissa daemon stop failed: ${stop.stderr.trim()}`);
		const deadline = Date.now() + 35_000;
		while (Date.now() < deadline) {
			await wait(250);
			const status = await this.#exec(environment, ["daemon", "status", "--json"], 5);
			if (status.exitCode !== 0) return;
		}
		throw new Error("Karissa daemon still accepts requests after stop timeout");
	}

	async run(
		testCase: EvalCase,
		environment: EvalEnvironment,
		runDirectory: string,
		budget: { maxCostUsd?: number },
	): Promise<AgentRunOutcome> {
		this.#activeEnvironment = environment;
		for (const item of this.#config.preparation?.copyIn ?? [])
			await environment.copyIn(item.source, item.destination);
		for (const command of this.#config.preparation?.commands ?? []) {
			const setup = await environment.exec(command);
			if (setup.exitCode !== 0 || setup.timedOut) throw new Error(`Karissa setup failed: ${setup.stderr.trim()}`);
		}

		const manifestPath = join(runDirectory, "karissa-task.json");
		await writeFile(
			manifestPath,
			`${JSON.stringify(
				{
					schemaVersion: 1,
					goal: testCase.instruction,
					title: `Eval: ${testCase.id}`,
					workspaceRoot: "/app",
					unattendedApproved: true,
					model: { provider: this.identity.modelProvider, id: this.identity.modelId },
					limits: {
						maxTurns: this.#config.maxTurns ?? 200,
						maxWallTimeMinutes: Math.ceil(testCase.limits.trialTimeoutSeconds / 60),
						maxCostUsd: Math.min(
							this.#config.maxCostUsd,
							testCase.limits.maxCostUsd ?? this.#config.maxCostUsd,
							budget.maxCostUsd ?? this.#config.maxCostUsd,
						),
					},
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
		await environment.copyIn(manifestPath, "/tmp/karissa-eval-task.json");
		const submit = await this.#exec(
			environment,
			["task", "submit", "--manifest", "/tmp/karissa-eval-task.json", "--yes", "--json"],
			60,
		);
		if (submit.exitCode !== 0 || submit.timedOut)
			throw new Error(`Karissa task submit failed: ${submit.stderr.trim()}`);
		const submission = parseObject(submit.stdout, "karissa task submit");
		if (typeof submission.taskId !== "string") throw new Error("karissa task submit returned no taskId");
		const taskId = submission.taskId;
		const trajectoryPath = join(runDirectory, "trajectory.jsonl");
		await mkdir(runDirectory, { recursive: true, mode: 0o700 });
		let lastSeq = 0;
		let delayMs = 250;
		const deadline = Date.now() + testCase.limits.trialTimeoutSeconds * 1000;
		const events: KarissaEventJson[] = [];
		let task: KarissaTaskJson | undefined;
		const attentionStates = new Set(["waiting_input", "waiting_external", "paused", "unknown_outcome"]);
		const terminalStates = new Set(["completed", "failed", "cancelled", ...attentionStates]);
		while (Date.now() < deadline) {
			const eventResult = await this.#exec(environment, [
				"task",
				"events",
				taskId,
				"--after",
				String(lastSeq),
				"--json",
			]);
			if (eventResult.exitCode !== 0 || eventResult.timedOut)
				throw new Error(`Karissa task events failed: ${eventResult.stderr.trim()}`);
			const batch = parseEvents(eventResult.stdout);
			if (batch.length > 0) {
				for (const event of batch) await appendFile(trajectoryPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
				events.push(...batch);
				lastSeq = batch.at(-1)!.seq;
			}
			const show = await this.#exec(environment, ["task", "show", taskId, "--json"]);
			if (show.exitCode !== 0 || show.timedOut) throw new Error(`Karissa task show failed: ${show.stderr.trim()}`);
			task = parseTask(show.stdout);
			if (terminalStates.has(task.state)) break;
			await wait(delayMs);
			delayMs = Math.min(delayMs * 2, 5000);
		}

		const timedOut = task === undefined || !terminalStates.has(task.state);
		await this.#stopDaemon(environment);
		this.#activeEnvironment = undefined;
		const state = timedOut ? "timed_out" : (task?.state ?? "unknown_outcome");
		const outcome: EvalRunResult["outcome"] = timedOut
			? "timed_out"
			: state === "completed"
				? "completed"
				: state === "waiting_input" ||
						state === "waiting_external" ||
						state === "paused" ||
						state === "unknown_outcome"
					? state
					: "failed";
		const eventCount = (pattern: RegExp): number => events.filter((event) => pattern.test(event.type)).length;
		return {
			outcome,
			usage: task === undefined ? {} : { estimatedCostUsd: task.totalCostUsd },
			karissa: {
				taskId,
				terminalState: state,
				turns: task?.totalTurns ?? 0,
				checkpoints: eventCount(/checkpoint/i),
				recoveries: eventCount(/recover(?:y|ed|ing)/i),
				unknownToolOutcomes: eventCount(/unknown.*tool|tool.*unknown/i),
				duplicateSideEffects: eventCount(/duplicate.*side.?effect/i),
			},
			errors:
				outcome === "completed" ? [] : [{ source: "karissa", code: state, message: `Karissa ended in ${state}` }],
		};
	}

	async stop(_reason: "timeout" | "cancelled" | "fault"): Promise<void> {
		if (this.#activeEnvironment === undefined) return;
		await this.#stopDaemon(this.#activeEnvironment);
		this.#activeEnvironment = undefined;
	}
}
