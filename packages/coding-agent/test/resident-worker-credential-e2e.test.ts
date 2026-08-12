import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "@karissa/long-tasks";
import { expect, it } from "vitest";
import { requestDaemon } from "../src/cli/daemon-command.ts";
import { workerSocketDirectory } from "../src/core/worker-socket.ts";

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) =>
			code === 0 ? resolve(stdout) : reject(new Error(`CLI exited ${code}: ${stderr || stdout}`)),
		);
	});
}

async function waitForTaskState(agentDir: string, taskId: string, expected: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	let observed = "store unavailable";
	while (Date.now() < deadline) {
		try {
			const store = SqliteTaskStore.open({ databasePath: join(agentDir, "long-tasks.sqlite") });
			try {
				const task = store.requireTask(taskId);
				if (task.state === expected) return;
				observed = JSON.stringify({
					state: task.state,
					stateReason: task.stateReason,
					events: store.listEvents(taskId, 0, 200).slice(-8),
				});
			} finally {
				store.close();
			}
		} catch {
			// Daemon may still be opening the store.
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const logPath = join(agentDir, "tasks", taskId, "daemon.log");
	const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "daemon log unavailable";
	throw new Error(`Task ${taskId} did not reach ${expected}: ${observed}\nWorker log:\n${log}`);
}

async function waitForDaemonExit(agentDir: string): Promise<void> {
	const pidPath = join(agentDir, "run", "karissa.pid");
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (!existsSync(pidPath)) return;
		const pid = Number(readFileSync(pidPath, "utf8").trim());
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Temporary Karissa daemon did not exit");
}

it("runs a durable Task with only its provider credential delivered over the Worker startup channel", async () => {
	const root = mkdtempSync(join(tmpdir(), "karissa-resident-e2e-"));
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	mkdirSync(agentDir);
	mkdirSync(workspace);
	writeFileSync(join(workspace, "proof.txt"), "verified\n");
	let observedAuthorization: string | undefined;
	const server = createServer(async (request, response) => {
		observedAuthorization = request.headers.authorization;
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
		const afterTool = parsed.messages?.some((message) => message.role === "tool") === true;
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const delta = afterTool
			? { role: "assistant", content: "completed" }
			: {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "call_complete",
							type: "function",
							function: {
								name: "task_update",
								arguments: JSON.stringify({
									action: "complete",
									summary: "local provider completed the Task",
									evidence: [{ id: "proof", kind: "file", ref: "proof.txt" }],
								}),
							},
						},
					],
				};
		response.write(
			`data: ${JSON.stringify({ id: "chatcmpl-local", object: "chat.completion.chunk", created: 0, model: "local-model", choices: [{ index: 0, delta, finish_reason: afterTool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
		);
		response.write("data: [DONE]\n\n");
		response.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Local provider did not bind a TCP port");
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"local-test": {
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					api: "openai-completions",
					models: [
						{
							id: "local-model",
							name: "Local Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 16_000,
							maxTokens: 1_000,
						},
					],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({ "local-test": { type: "api_key", key: "channel-secret" } }),
		{ mode: 0o600 },
	);

	try {
		const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
		const output = await run(
			join(repositoryRoot, "node_modules", ".bin", "tsx"),
			[
				"--tsconfig",
				join(repositoryRoot, "tsconfig.json"),
				join(repositoryRoot, "packages", "coding-agent", "src", "cli.ts"),
				"finish using the provided proof",
				"--yes",
				"--unsafe-no-sandbox",
				"--provider",
				"local-test",
				"--model",
				"local-model",
				"--json",
			],
			{ cwd: workspace, env: { ...process.env, KARISSA_CODING_AGENT_DIR: agentDir } },
		);
		const result = JSON.parse(output.trim().split("\n").at(-1)!) as { taskId: string };
		await waitForTaskState(agentDir, result.taskId, "completed");
		expect(observedAuthorization).toBe("Bearer channel-secret");
	} finally {
		try {
			await requestDaemon(agentDir, { command: "stop" });
		} catch {
			// The daemon may already have exited after a startup failure.
		}
		await waitForDaemonExit(agentDir);
		server.close();
		await once(server, "close");
		rmSync(workerSocketDirectory(agentDir), { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});
