import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentPreparation } from "./command-agent.ts";
import type { AgentAdapter, AgentRunOutcome, EvalEnvironment } from "./contracts.ts";
import {
	type DurableEventSource,
	type EvalDurableEvent,
	EverDurableEventProjector,
	type EverTaskEvent,
} from "./durable-events.ts";
import type { AgentIdentity, EvalCase, EvalRunResult } from "./schemas.ts";
import type { EnvironmentFaultEvent, EnvironmentFaultEventSource, SemanticFaultTrigger } from "./semantic-faults.ts";

interface EverTaskJson {
	schemaVersion: 1;
	id: string;
	state: string;
	totalTurns: number;
	totalCostUsd: number;
}

interface EverEventJson extends EverTaskEvent {
	schemaVersion: 1;
	seq: number;
	type: string;
	createdAt: string;
	payload: Record<string, unknown>;
}

export interface EverAgentConfig {
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

function parseTask(text: string): EverTaskJson {
	const value = parseObject(text, "ever task show");
	if (
		typeof value.id !== "string" ||
		typeof value.state !== "string" ||
		typeof value.totalTurns !== "number" ||
		typeof value.totalCostUsd !== "number"
	) {
		throw new Error("ever task show returned an invalid payload");
	}
	return value as unknown as EverTaskJson;
}

function parseEvents(text: string): EverEventJson[] {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const value = parseObject(line, "ever task events");
			if (
				typeof value.seq !== "number" ||
				typeof value.taskId !== "string" ||
				typeof value.type !== "string" ||
				typeof value.createdAt !== "string" ||
				typeof value.payload !== "object" ||
				value.payload === null ||
				Array.isArray(value.payload)
			) {
				throw new Error("ever task events returned an invalid payload");
			}
			return value as unknown as EverEventJson;
		});
}

async function wait(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class EverAgentAdapter implements AgentAdapter, DurableEventSource, EnvironmentFaultEventSource {
	readonly identity: AgentIdentity;
	readonly #config: EverAgentConfig;
	#projector = new EverDurableEventProjector();
	#activeEnvironment?: EvalEnvironment;
	#armedEnvironmentTrigger?: SemanticFaultTrigger;
	#gateDirectory?: string;
	#gateSecret?: string;

	constructor(config: EverAgentConfig) {
		this.identity = config.identity;
		this.#config = config;
	}

	readDurableEvents(afterSeq: number): readonly EvalDurableEvent[] {
		return this.#projector.read(afterSeq);
	}

	armEnvironmentTrigger(trigger: SemanticFaultTrigger): void {
		if (trigger.source !== "environment_event" || trigger.type !== "EffectCommitted") {
			throw new Error("Ever controlled side-effect gate only supports EffectCommitted environment events");
		}
		if (
			typeof trigger.where.effect !== "string" ||
			!["reconcilable_write", "external_side_effect", "process"].includes(trigger.where.effect)
		)
			throw new Error("Ever controlled side-effect gate requires a supported effect");
		if (
			typeof trigger.where.toolName !== "string" &&
			typeof trigger.where.targetPath !== "string" &&
			typeof trigger.where.commandMarker !== "string"
		)
			throw new Error("Ever controlled side-effect gate requires a task-domain selector");
		if (typeof trigger.where.domainCommitId !== "string" || typeof trigger.where.evidencePath !== "string")
			throw new Error("Ever controlled side-effect gate requires domain commit evidence");
		this.#armedEnvironmentTrigger = trigger;
		this.#gateDirectory = `/tmp/ever-eval-gate-${randomUUID()}`;
		this.#gateSecret = randomBytes(32).toString("hex");
	}

	async readEnvironmentEvents(afterSeq: number): Promise<readonly EnvironmentFaultEvent[]> {
		if (this.#activeEnvironment === undefined) return [];
		if (this.#gateDirectory === undefined) return [];
		if (this.#gateSecret === undefined) throw new Error("Controlled effect gate has no authentication secret");
		const text = await this.#activeEnvironment.readFile(`${this.#gateDirectory}/events.jsonl`);
		if (text === undefined) return [];
		const lines = text.split("\n");
		if (!text.endsWith("\n")) lines.pop();
		return lines
			.filter((line) => line !== "")
			.map((line, index) => {
				const value = JSON.parse(line) as unknown;
				if (
					typeof value !== "object" ||
					value === null ||
					Array.isArray(value) ||
					Reflect.get(value, "schemaVersion") !== 1 ||
					Reflect.get(value, "type") !== "EffectCommitted" ||
					typeof Reflect.get(value, "operationId") !== "string" ||
					typeof Reflect.get(value, "idempotencyKey") !== "string" ||
					typeof Reflect.get(value, "toolCallId") !== "string" ||
					typeof Reflect.get(value, "createdAt") !== "string" ||
					typeof Reflect.get(value, "toolName") !== "string" ||
					typeof Reflect.get(value, "toolErrored") !== "boolean" ||
					typeof Reflect.get(value, "domainCommitId") !== "string" ||
					typeof Reflect.get(value, "evidencePath") !== "string" ||
					!/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "evidenceDigest"))) ||
					!["reconcilable_write", "external_side_effect", "process"].includes(
						String(Reflect.get(value, "effect")),
					) ||
					!/^[a-f0-9]{64}$/.test(String(Reflect.get(value, "payloadDigest")))
				) {
					throw new Error(`Invalid controlled EffectCommitted event at line ${index + 1}`);
				}
				const operationId = String(Reflect.get(value, "operationId"));
				const authenticationPayload = [
					operationId,
					String(Reflect.get(value, "idempotencyKey")),
					String(Reflect.get(value, "toolCallId")),
					String(Reflect.get(value, "effect")),
					String(Reflect.get(value, "toolName")),
					String(Reflect.get(value, "toolErrored")),
					String(Reflect.get(value, "domainCommitId")),
					String(Reflect.get(value, "evidencePath")),
					String(Reflect.get(value, "evidenceDigest")),
					typeof Reflect.get(value, "evidenceIncludes") === "string"
						? String(Reflect.get(value, "evidenceIncludes"))
						: "",
					typeof Reflect.get(value, "targetPath") === "string" ? String(Reflect.get(value, "targetPath")) : "",
					typeof Reflect.get(value, "commandMarker") === "string"
						? String(Reflect.get(value, "commandMarker"))
						: "",
					String(Reflect.get(value, "payloadDigest")),
					String(Reflect.get(value, "createdAt")),
				].join("\0");
				const expectedMac = createHmac("sha256", this.#gateSecret!).update(authenticationPayload).digest();
				const actualMacText = Reflect.get(value, "mac");
				if (typeof actualMacText !== "string" || !/^[a-f0-9]{64}$/.test(actualMacText))
					throw new Error(`Unauthenticated controlled EffectCommitted event at line ${index + 1}`);
				if (!timingSafeEqual(Buffer.from(actualMacText, "hex"), expectedMac))
					throw new Error(`Unauthenticated controlled EffectCommitted event at line ${index + 1}`);
				return { ...(value as Omit<EnvironmentFaultEvent, "seq">), seq: index + 1 };
			})
			.filter((event) => event.seq > afterSeq);
	}

	async releaseEnvironmentEvent(event: EnvironmentFaultEvent): Promise<void> {
		if (this.#activeEnvironment === undefined || this.#gateDirectory === undefined || this.#gateSecret === undefined)
			return;
		const releaseToken = createHmac("sha256", this.#gateSecret).update(event.operationId).digest("hex");
		const result = await this.#activeEnvironment.exec({
			args: ["touch", `${this.#gateDirectory}/release-${releaseToken}`],
			timeoutSeconds: 30,
		});
		if (result.exitCode !== 0 || result.timedOut) throw new Error("Cannot release controlled effect gate");
	}

	async #exec(environment: EvalEnvironment, args: string[], timeoutSeconds = 30) {
		return await environment.exec({
			args: [this.#config.command ?? "ever", ...args],
			cwd: "/app",
			env: {
				EVER_CODING_AGENT_DIR: "/tmp/ever-agent",
				EVER_UNATTENDED_SANDBOX: "1",
				...(this.#armedEnvironmentTrigger?.source === "environment_event"
					? {
							EVER_EVAL_EFFECT_GATE_DIR: this.#gateDirectory!,
							EVER_EVAL_EFFECT_GATE_EFFECT: String(this.#armedEnvironmentTrigger.where.effect),
							EVER_EVAL_EFFECT_GATE_SECRET: this.#gateSecret!,
							EVER_EVAL_EFFECT_GATE_DOMAIN_COMMIT_ID: String(this.#armedEnvironmentTrigger.where.domainCommitId),
							EVER_EVAL_EFFECT_GATE_EVIDENCE_PATH: String(this.#armedEnvironmentTrigger.where.evidencePath),
							...(typeof this.#armedEnvironmentTrigger.where.evidenceIncludes === "string"
								? {
										EVER_EVAL_EFFECT_GATE_EVIDENCE_INCLUDES:
											this.#armedEnvironmentTrigger.where.evidenceIncludes,
									}
								: {}),
							...(typeof this.#armedEnvironmentTrigger.where.toolErrored === "boolean"
								? {
										EVER_EVAL_EFFECT_GATE_EXPECTED_TOOL_ERROR: this.#armedEnvironmentTrigger.where.toolErrored
											? "1"
											: "0",
									}
								: {}),
							...(typeof this.#armedEnvironmentTrigger.where.toolName === "string"
								? { EVER_EVAL_EFFECT_GATE_TOOL_NAME: this.#armedEnvironmentTrigger.where.toolName }
								: {}),
							...(typeof this.#armedEnvironmentTrigger.where.targetPath === "string"
								? { EVER_EVAL_EFFECT_GATE_TARGET_PATH: this.#armedEnvironmentTrigger.where.targetPath }
								: {}),
							...(typeof this.#armedEnvironmentTrigger.where.commandMarker === "string"
								? {
										EVER_EVAL_EFFECT_GATE_COMMAND_INCLUDES: this.#armedEnvironmentTrigger.where.commandMarker,
									}
								: {}),
						}
					: {}),
				...(typeof this.#config.environment === "function" ? this.#config.environment() : this.#config.environment),
			},
			timeoutSeconds,
		});
	}

	async #stopDaemon(environment: EvalEnvironment): Promise<void> {
		const stop = await this.#exec(environment, ["daemon", "stop", "--json"], 30);
		if (stop.exitCode !== 0 || stop.timedOut) throw new Error(`Ever daemon stop failed: ${stop.stderr.trim()}`);
		const deadline = Date.now() + 35_000;
		while (Date.now() < deadline) {
			await wait(250);
			const status = await this.#exec(environment, ["daemon", "status", "--json"], 5);
			if (status.exitCode !== 0) return;
		}
		throw new Error("Ever daemon still accepts requests after stop timeout");
	}

	async run(
		testCase: EvalCase,
		environment: EvalEnvironment,
		runDirectory: string,
		budget: { maxCostUsd?: number },
	): Promise<AgentRunOutcome> {
		this.#activeEnvironment = environment;
		this.#projector = new EverDurableEventProjector();
		for (const item of this.#config.preparation?.copyIn ?? [])
			await environment.copyIn(item.source, item.destination);
		for (const command of this.#config.preparation?.commands ?? []) {
			const setup = await environment.exec(command);
			if (setup.exitCode !== 0 || setup.timedOut) throw new Error(`Ever setup failed: ${setup.stderr.trim()}`);
		}
		const manifestPath = join(runDirectory, "ever-task.json");
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
		await environment.copyIn(manifestPath, "/tmp/ever-eval-task.json");
		const submit = await this.#exec(
			environment,
			["task", "submit", "--manifest", "/tmp/ever-eval-task.json", "--yes", "--json"],
			60,
		);
		if (submit.exitCode !== 0 || submit.timedOut) throw new Error(`Ever task submit failed: ${submit.stderr.trim()}`);
		const submission = parseObject(submit.stdout, "ever task submit");
		if (typeof submission.taskId !== "string") throw new Error("ever task submit returned no taskId");
		const taskId = submission.taskId;
		const trajectoryPath = join(runDirectory, "trajectory.jsonl");
		await mkdir(runDirectory, { recursive: true, mode: 0o700 });
		let lastSeq = 0;
		let delayMs = 250;
		const deadline = Date.now() + testCase.limits.trialTimeoutSeconds * 1000;
		const events: EverEventJson[] = [];
		let task: EverTaskJson | undefined;
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
				throw new Error(`Ever task events failed: ${eventResult.stderr.trim()}`);
			const batch = parseEvents(eventResult.stdout);
			if (batch.length > 0) {
				for (const event of batch) await appendFile(trajectoryPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
				this.#projector.append(batch);
				events.push(...batch);
				lastSeq = batch.at(-1)!.seq;
			}
			const show = await this.#exec(environment, ["task", "show", taskId, "--json"]);
			if (show.exitCode !== 0 || show.timedOut) throw new Error(`Ever task show failed: ${show.stderr.trim()}`);
			task = parseTask(show.stdout);
			if (terminalStates.has(task.state)) break;
			await wait(delayMs);
			delayMs = Math.min(delayMs * 2, 5000);
		}

		const timedOut = task === undefined || !terminalStates.has(task.state);
		await this.#stopDaemon(environment);
		this.#activeEnvironment = undefined;
		this.#armedEnvironmentTrigger = undefined;
		this.#gateDirectory = undefined;
		this.#gateSecret = undefined;
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
		const durableEvents = this.#projector.read(0);
		return {
			outcome,
			usage: task === undefined ? {} : { estimatedCostUsd: task.totalCostUsd },
			ever: {
				taskId,
				terminalState: state,
				turns: task?.totalTurns ?? 0,
				checkpoints: durableEvents.filter((event) => event.type === "CheckpointSettled").length,
				recoveries: durableEvents.filter((event) => event.type === "RecoveryFinished").length,
				unknownToolOutcomes: events.filter((event) => event.type === "ToolOutcomeUnknown").length,
				duplicateSideEffects: events.filter((event) => event.type === "DuplicateSideEffectDetected").length,
			},
			errors: outcome === "completed" ? [] : [{ source: "ever", code: state, message: `Ever ended in ${state}` }],
		};
	}

	async stop(_reason: "timeout" | "cancelled" | "fault"): Promise<void> {
		if (this.#activeEnvironment === undefined) return;
		await this.#stopDaemon(this.#activeEnvironment);
		this.#activeEnvironment = undefined;
		this.#gateSecret = undefined;
	}
}
