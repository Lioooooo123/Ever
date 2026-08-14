import { createInterface } from "node:readline";
import { TaskApplication } from "../core/task-application.ts";
import { resolveTaskModel } from "../core/task-model.ts";
import { requestDaemon, startDaemon } from "./daemon-command.ts";

interface RpcRequest {
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
	return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
	return value as number;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		throw new Error(`${label} must be a non-negative integer`);
	return value as number;
}

function parseRequest(line: string): RpcRequest {
	const value: unknown = JSON.parse(line);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("request must be an object");
	const record = value as Record<string, unknown>;
	if ((typeof record.id !== "string" && typeof record.id !== "number") || typeof record.method !== "string")
		throw new Error("request requires id and method");
	if (
		record.params !== undefined &&
		(typeof record.params !== "object" || record.params === null || Array.isArray(record.params))
	)
		throw new Error("params must be an object");
	return {
		id: record.id,
		method: record.method,
		...(record.params === undefined ? {} : { params: record.params as Record<string, unknown> }),
	};
}

async function executeRequest(
	request: RpcRequest,
	application: TaskApplication,
	agentDir: string,
	cwd: string,
): Promise<unknown> {
	const params = request.params ?? {};
	if (request.method === "task.list") return application.list();
	if (request.method === "task.get") return application.snapshot(requireString(params.taskId, "taskId"));
	if (request.method === "task.events") {
		return application.events(
			requireString(params.taskId, "taskId"),
			optionalNonNegativeInteger(params.afterSeq, "afterSeq") ?? 0,
			params.limit === undefined ? 200 : optionalPositiveInteger(params.limit, "limit")!,
		);
	}
	if (request.method === "task.bundle") return application.bundle(requireString(params.taskId, "taskId"));
	if (request.method === "task.submit") {
		if (params.approved !== true) throw new Error("task.submit requires params.approved=true");
		const unsafeNoSandbox = params.unsafeNoSandbox === true;
		const maxTurns = optionalPositiveInteger(params.maxTurns, "maxTurns");
		const workspaceRoot = typeof params.workspaceRoot === "string" ? params.workspaceRoot : cwd;
		const model = await resolveTaskModel({
			agentDir,
			cwd: workspaceRoot,
			provider: typeof params.provider === "string" ? params.provider : undefined,
			model: typeof params.model === "string" ? params.model : undefined,
		});
		const task = application.submit({
			kind: "unattended",
			workspaceRoot,
			goal: requireString(params.goal, "goal"),
			model,
			...(typeof params.title === "string" ? { title: params.title } : {}),
			...(typeof params.verificationCommand === "string" ? { verificationCommand: params.verificationCommand } : {}),
			...(maxTurns === undefined ? {} : { maxTurns }),
			unsafeNoSandbox,
		});
		await startDaemon(agentDir, unsafeNoSandbox);
		const wake = await requestDaemon(agentDir, { command: "wake", taskId: task.id });
		if (!wake.ok) throw new Error(wake.message ?? "Daemon rejected Task submission");
		const mainAgent = application.snapshot(task.id).agents.find((agent) => agent.kind === "main");
		return { taskId: task.id, state: task.state, agentId: mainAgent?.id ?? null };
	}
	if (request.method === "task.pause" || request.method === "task.resume" || request.method === "task.cancel") {
		const action = request.method === "task.pause" ? "pause" : request.method === "task.resume" ? "resume" : "cancel";
		return application.control(
			{ action, taskRef: requireString(params.taskId, "taskId") },
			{
				clientId: typeof params.clientId === "string" ? params.clientId : "ever-rpc",
				...(typeof params.commandId === "string" ? { commandId: params.commandId } : {}),
			},
		);
	}
	if (request.method === "task.steer") {
		return application.control(
			{
				action: "steer",
				taskRef: requireString(params.taskId, "taskId"),
				agentRef: requireString(params.agentId, "agentId"),
				message: requireString(params.message, "message"),
			},
			{
				clientId: typeof params.clientId === "string" ? params.clientId : "ever-rpc",
				...(typeof params.commandId === "string" ? { commandId: params.commandId } : {}),
			},
		);
	}
	throw new Error(`unsupported method: ${request.method}`);
}

export async function runTaskRpc(agentDir: string, cwd: string): Promise<void> {
	const application = new TaskApplication(agentDir);
	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of input) {
		if (line.trim() === "") continue;
		let request: RpcRequest | undefined;
		try {
			request = parseRequest(line);
			const result = await executeRequest(request, application, agentDir, cwd);
			process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
		} catch (error) {
			process.stdout.write(
				`${JSON.stringify({ id: request?.id ?? null, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
			);
		}
	}
}
