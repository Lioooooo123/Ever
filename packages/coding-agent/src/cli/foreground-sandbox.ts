import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Credential } from "@lioooooo123/ever-ai";
import { SqliteTaskStore, type TaskRecord } from "@lioooooo123/ever-long-tasks";
import chalk from "chalk";
import { SessionExecutionHost } from "../core/session-execution-host.ts";
import {
	probeUnattendedSandbox,
	type SandboxCapability,
	type SandboxProfileExtension,
} from "../core/unattended-sandbox.ts";
import { getWorkerStartupIfLoaded, type WorkerStartupEnvelope } from "../core/worker-startup.ts";
import { resolveWorkerCredential } from "./daemon-command.ts";

export interface ForegroundSandboxResult {
	/** True when the current process re-exec'd into a sandboxed child and should exit with `exitCode`. */
	replaced: boolean;
	exitCode: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function taskModelIdentity(model: unknown): { provider: string; id: string } | undefined {
	if (typeof model !== "object" || model === null || Array.isArray(model)) return undefined;
	const provider = Reflect.get(model, "provider");
	const id = Reflect.get(model, "id");
	if (typeof provider !== "string" || typeof id !== "string" || provider === "" || id === "") return undefined;
	return { provider, id };
}

function isUsableCredential(value: unknown): value is Credential {
	if (!isRecord(value)) return false;
	if (value.type === "api_key")
		return typeof value.key === "string" && value.key !== "" && value.key !== "<authenticated>";
	if (value.type === "oauth")
		return typeof value.access === "string" && typeof value.refresh === "string" && typeof value.expires === "number";
	return false;
}

/** Read the full credential map from auth.json so a sandboxed Session can switch models without reading the file. */
function readSessionCredentials(agentDir: string): Record<string, Credential> | undefined {
	let content: string;
	try {
		content = readFileSync(join(agentDir, "auth.json"), "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const credentials: Record<string, Credential> = {};
	for (const [provider, credential] of Object.entries(parsed)) {
		if (provider.trim() === "" || !isUsableCredential(credential)) continue;
		credentials[provider] = credential;
	}
	return Object.keys(credentials).length > 0 ? credentials : undefined;
}

function sandboxWarning(action: string, error: unknown): void {
	console.error(
		chalk.yellow(
			`Warning: foreground sandbox unavailable: ${action}: ${error instanceof Error ? error.message : String(error)}`,
		),
	);
}

/**
 * Re-exec a foreground Task inside the same sandboxed Session Execution Host
 * used by detached Workers, so the Small Model Judge can auto-approve eligible
 * process intents instead of falling back to a manual prompt for every command.
 *
 * Fails closed: when no sandbox is available, when the process is already
 * sandboxed, or when the Task has no pinned model/main Agent, it returns
 * `{ replaced: false }` and the caller continues unsandboxed with manual
 * confirmation (the existing behavior).
 */
export async function maybeReexecForegroundTask(
	input: { agentDir: string; taskId: string; print?: boolean; json?: boolean },
	probe: () => SandboxCapability = probeUnattendedSandbox,
): Promise<ForegroundSandboxResult> {
	if (getWorkerStartupIfLoaded()) return { replaced: false, exitCode: null };
	const capability = probe();
	if (!capability.available) return { replaced: false, exitCode: null };
	const cliEntry = process.argv[1];
	if (!cliEntry) return { replaced: false, exitCode: null };

	try {
		const store = SqliteTaskStore.open({
			databasePath: join(input.agentDir, "long-tasks.sqlite"),
			artifactsRoot: join(input.agentDir, "tasks"),
		});
		let task: TaskRecord;
		let agentId: string | undefined;
		try {
			task = store.requireTask(input.taskId);
			const mainAgents = store.listAgents(input.taskId).filter((agent) => agent.kind === "main");
			agentId = mainAgents.length === 1 ? mainAgents[0]!.id : undefined;
		} finally {
			store.close();
		}
		if (!agentId) return { replaced: false, exitCode: null };
		const model = taskModelIdentity(task.constraints.model);
		if (!model) return { replaced: false, exitCode: null };
		const credential = await resolveWorkerCredential(input.agentDir, model.provider);
		return await spawnSandboxedChild({
			agentDir: input.agentDir,
			cwd: task.workspaceRoot,
			args: [
				cliEntry,
				"task",
				"run",
				input.taskId,
				"--agent",
				agentId,
				...(input.print ? ["--print"] : []),
				...(input.json ? ["--json"] : []),
			],
			credentials: { [model.provider]: credential },
			logName: "foreground-task.log",
		});
	} catch (error) {
		sandboxWarning("Task re-exec", error);
		return { replaced: false, exitCode: null };
	}
}

/**
 * Re-exec a bare Session inside the sandboxed Session Execution Host at launch,
 * so `/goal` (and ordinary work) inherit `sandboxAvailable=true` without any
 * Task-specific sandbox handling.
 *
 * Fails closed: when no sandbox is available, when the process is already
 * sandboxed, or when no usable credentials exist (so the child could not make
 * model requests), it returns `{ replaced: false }` and the Session continues
 * unsandboxed.
 */
export async function maybeReexecSessionSandboxed(
	input: { agentDir: string; cwd: string },
	probe: () => SandboxCapability = probeUnattendedSandbox,
): Promise<ForegroundSandboxResult> {
	if (getWorkerStartupIfLoaded()) return { replaced: false, exitCode: null };
	const capability = probe();
	if (!capability.available) return { replaced: false, exitCode: null };
	const cliEntry = process.argv[1];
	if (!cliEntry) return { replaced: false, exitCode: null };
	const credentials = readSessionCredentials(input.agentDir);
	if (!credentials) return { replaced: false, exitCode: null };

	try {
		return await spawnSandboxedChild({
			agentDir: input.agentDir,
			cwd: input.cwd,
			args: [cliEntry, ...process.argv.slice(2)],
			credentials,
			logName: "foreground-session.log",
		});
	} catch (error) {
		sandboxWarning("Session re-exec", error);
		return { replaced: false, exitCode: null };
	}
}

function handleSandboxControl(message: unknown, host: SessionExecutionHost): void {
	if (typeof message !== "object" || message === null || Array.isArray(message)) return;
	const record = message as Record<string, unknown>;
	if (record.type !== "updateAllowedDomains") return;
	if (!Array.isArray(record.domains)) return;
	const domains = record.domains.filter((domain): domain is string => typeof domain === "string" && domain !== "");
	if (domains.length > 0) host.updateAllowedDomains(domains);
}

async function spawnSandboxedChild(input: {
	agentDir: string;
	cwd: string;
	args: string[];
	credentials: Record<string, Credential>;
	logName: string;
}): Promise<ForegroundSandboxResult> {
	const executionHost = new SessionExecutionHost(input.agentDir, false);
	await executionHost.initialize({ allowPty: true });
	const runDir = join(input.agentDir, "run");
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	const logFd = openSync(join(runDir, input.logName), "a", 0o600);
	try {
		const profile: SandboxProfileExtension = { allowPty: true };
		const hosted = await executionHost.start({
			command: process.execPath,
			args: [...process.execArgv, ...input.args],
			cwd: input.cwd,
			logFd,
			profile,
			foreground: true,
			env: { EVER_FOREGROUND_SANDBOX: "1" },
		});
		if (hosted.controlChannel) {
			let buffer = "";
			hosted.controlChannel.setEncoding("utf8");
			hosted.controlChannel.on("data", (chunk: string) => {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
					if (!line) continue;
					try {
						handleSandboxControl(JSON.parse(line) as unknown, executionHost);
					} catch {
						// Ignore malformed control messages; the sandbox stays restrictive.
					}
				}
			});
		}
		const envelope: WorkerStartupEnvelope = {
			schemaVersion: 1,
			token: `foreground-${randomUUID()}`,
			credentials: input.credentials,
			executionEnvironment: hosted.environment,
		};
		hosted.tokenChannel.end(`${JSON.stringify(envelope)}\n`);
		const exitCode = await new Promise<number | null>((resolve) => {
			hosted.child.once("error", () => resolve(null));
			hosted.child.once("exit", (code) => resolve(code));
		});
		return { replaced: true, exitCode };
	} finally {
		closeSync(logFd);
		await executionHost.close();
	}
}
