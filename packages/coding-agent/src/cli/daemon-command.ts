import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { resolveAgentExecutionContext, SqliteTaskStore, TaskNotificationDispatcher } from "@karissa/long-tasks";
import chalk from "chalk";
import { recoverExpiredLongTaskExecutions } from "../core/long-task-runtime.ts";
import { DesktopNotificationAdapter } from "./desktop-notifier.ts";

interface DaemonResponse {
	schemaVersion: 1;
	ok: boolean;
	pid?: number;
	runningTaskIds?: string[];
	message?: string;
}

function paths(agentDir: string) {
	const runDir = join(agentDir, "run");
	return { runDir, socketPath: join(runDir, "karissa.sock"), pidPath: join(runDir, "karissa.pid") };
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readPid(pidPath: string): number | undefined {
	try {
		const pid = Number(readFileSync(pidPath, "utf8").trim());
		return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

export function requestDaemon(agentDir: string, request: Record<string, unknown>): Promise<DaemonResponse> {
	const { socketPath } = paths(agentDir);
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let response = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk) => {
			response += chunk;
		});
		socket.on("error", reject);
		socket.on("end", () => {
			try {
				const parsed = JSON.parse(response.trim()) as DaemonResponse;
				if (parsed.schemaVersion !== 1) throw new Error("Daemon returned an unsupported schemaVersion");
				resolve(parsed);
			} catch {
				reject(new Error("Daemon returned an invalid response"));
			}
		});
	});
}

async function waitForDaemon(agentDir: string, attempts = 20): Promise<DaemonResponse> {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await requestDaemon(agentDir, { command: "status" });
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Daemon did not start");
}

async function serve(agentDir: string, unsafeNoSandbox: boolean): Promise<void> {
	const { runDir, socketPath, pidPath } = paths(agentDir);
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	chmodSync(runDir, 0o700);
	const previousPid = readPid(pidPath);
	if (previousPid && isProcessAlive(previousPid)) throw new Error(`Daemon already running with PID ${previousPid}`);
	if (existsSync(pidPath)) rmSync(pidPath);
	if (existsSync(socketPath)) rmSync(socketPath);
	const pidFd = openSync(pidPath, "wx", 0o600);
	writeFileSync(pidFd, `${process.pid}\n`);
	closeSync(pidFd);

	const store = SqliteTaskStore.open({
		databasePath: join(agentDir, "long-tasks.sqlite"),
		artifactsRoot: join(agentDir, "tasks"),
	});
	const notifications = new TaskNotificationDispatcher(store, new DesktopNotificationAdapter());
	const workers = new Map<string, { child: ReturnType<typeof spawn>; taskId: string }>();
	let stopping = false;
	const cliEntry = process.argv[1];

	let scheduling = false;
	const schedule = async (): Promise<void> => {
		if (scheduling) return;
		scheduling = true;
		try {
			await recoverExpiredLongTaskExecutions(store);
			await notifications.dispatchPending();
			if (stopping || workers.size >= 4 || !cliEntry) return;
			const activeTaskId = workers.values().next().value?.taskId as string | undefined;
			const task = store
				.listRunnableTasks(100)
				.find((candidate) => activeTaskId === undefined || candidate.id === activeTaskId);
			if (!task) return;
			if (!unsafeNoSandbox && process.env.KARISSA_UNATTENDED_SANDBOX !== "1") {
				if (task.state === "queued") {
					store.transitionTask(task.id, "paused", "sandbox_required");
					store.appendTaskEvent(task.id, "SecurityPolicyDenied", {
						reason: "background execution requires a sandbox",
						schemaVersion: 1,
					});
				}
				return;
			}
			const agent = store.listRunnableAgents(task.id, 4)[0];
			if (!agent || workers.has(agent.id)) return;
			const executionContext = resolveAgentExecutionContext(store, task.id, agent.id);
			const logDir = join(agentDir, "tasks", task.id);
			mkdirSync(logDir, { recursive: true, mode: 0o700 });
			const logFd = openSync(join(logDir, "daemon.log"), "a", 0o600);
			const workerArgs =
				agent.kind === "main"
					? [cliEntry, "task", "run", task.id, "--print"]
					: [cliEntry, "task", "agent", "run", task.id, agent.id, "--print"];
			const child = spawn(process.execPath, workerArgs, {
				cwd: executionContext.canonicalWorkspaceRoot,
				detached: true,
				stdio: ["ignore", logFd, logFd],
				env: {
					...process.env,
					KARISSA_DAEMON_WORKER: "1",
					...(unsafeNoSandbox ? { KARISSA_UNSAFE_NO_SANDBOX: "1" } : {}),
				},
			});
			closeSync(logFd);
			workers.set(agent.id, { child, taskId: task.id });
			child.once("exit", (code) => {
				workers.delete(agent.id);
				if (code && code !== 0) {
					const currentTask = store.requireTask(task.id);
					const currentAgent = store.requireAgent(agent.id);
					if (["queued", "running"].includes(currentTask.state) && currentAgent.state === "queued") {
						store.transitionAgent(agent.id, "paused", "worker_failed");
						store.transitionTask(task.id, "waiting_input", "worker_failed");
					}
				}
				void schedule();
			});
		} finally {
			scheduling = false;
		}
	};

	const interval = setInterval(() => void schedule(), 1000);
	const server = createServer((socket) => {
		let input = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			input += chunk;
		});
		socket.on("end", () => {
			let command: string | undefined;
			try {
				command = (JSON.parse(input.trim()) as { command?: string }).command;
			} catch {
				socket.end(JSON.stringify({ schemaVersion: 1, ok: false, message: "invalid request" }));
				return;
			}
			if (command === "status" || command === "wake") {
				void schedule();
				socket.end(
					JSON.stringify({
						schemaVersion: 1,
						ok: true,
						pid: process.pid,
						runningTaskIds: [...new Set([...workers.values()].map((worker) => worker.taskId))],
					}),
				);
			} else if (command === "stop") {
				stopping = true;
				socket.end(JSON.stringify({ schemaVersion: 1, ok: true, pid: process.pid, message: "stopping" }));
				server.close();
			} else {
				socket.end(
					JSON.stringify({ schemaVersion: 1, ok: false, message: `unknown command: ${command ?? "missing"}` }),
				);
			}
		});
	});

	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				chmodSync(socketPath, 0o600);
				resolve();
			});
		});
		await schedule();
		await new Promise<void>((resolve) => server.once("close", resolve));
		const deadline = Date.now() + 30_000;
		while (workers.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
		for (const worker of workers.values()) {
			try {
				process.kill(-worker.child.pid!, "SIGTERM");
			} catch {
				worker.child.kill("SIGTERM");
			}
		}
	} finally {
		clearInterval(interval);
		store.close();
		if (existsSync(socketPath)) rmSync(socketPath);
		if (existsSync(pidPath)) rmSync(pidPath);
	}
}

function serviceDefinition(agentDir: string): { path: string; content: string } {
	const cliEntry = process.argv[1] ?? "karissa";
	if (process.platform === "darwin") {
		const path = join(process.env.HOME ?? agentDir, "Library/LaunchAgents/com.karissa.agent.plist");
		const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.karissa.agent</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${cliEntry}</string><string>daemon</string><string>serve</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`;
		return { path, content };
	}
	const path = join(process.env.HOME ?? agentDir, ".config/systemd/user/karissa.service");
	const content = `[Unit]\nDescription=Karissa durable task daemon\n\n[Service]\nExecStart=${process.execPath} ${cliEntry} daemon serve\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
	return { path, content };
}

function printHelp(): void {
	console.log(
		`karissa daemon commands:\n  karissa daemon start [--unsafe-no-sandbox]\n  karissa daemon status\n  karissa daemon stop\n  karissa daemon install\n  karissa daemon uninstall\n  karissa daemon doctor`,
	);
}

export async function startDaemon(agentDir: string, unsafeNoSandbox = false): Promise<DaemonResponse> {
	try {
		const status = await requestDaemon(agentDir, { command: "status" });
		if (status.ok) return status;
	} catch {
		// Start a new daemon below.
	}
	const cliEntry = process.argv[1];
	if (!cliEntry) throw new Error("Cannot determine CLI entry point");
	const child = spawn(
		process.execPath,
		[cliEntry, "daemon", "serve", ...(unsafeNoSandbox ? ["--unsafe-no-sandbox"] : [])],
		{ detached: true, stdio: "ignore", env: process.env },
	);
	child.unref();
	return waitForDaemon(agentDir);
}

export async function handleDaemonCommand(args: string[], agentDir: string, enabled = true): Promise<boolean> {
	if (args[0] !== "daemon") return false;
	if (!enabled) {
		console.error(chalk.red("Error: Long Tasks are disabled by longTasks.enabled"));
		process.exitCode = 1;
		return true;
	}
	const command = args[1];
	try {
		if (!command || command === "help" || command === "--help") {
			printHelp();
		} else if (command === "serve") {
			await serve(agentDir, args.includes("--unsafe-no-sandbox"));
		} else if (command === "start") {
			console.log(JSON.stringify(await startDaemon(agentDir, args.includes("--unsafe-no-sandbox"))));
		} else if (command === "status" || command === "stop") {
			console.log(JSON.stringify(await requestDaemon(agentDir, { command })));
		} else if (command === "install") {
			const service = serviceDefinition(agentDir);
			mkdirSync(dirname(service.path), { recursive: true, mode: 0o700 });
			writeFileSync(service.path, service.content, { mode: 0o600 });
			console.log(service.path);
		} else if (command === "uninstall") {
			const service = serviceDefinition(agentDir);
			if (existsSync(service.path)) rmSync(service.path);
			console.log(service.path);
		} else if (command === "doctor") {
			const { socketPath, pidPath } = paths(agentDir);
			const pid = readPid(pidPath);
			const service = serviceDefinition(agentDir);
			console.log(
				JSON.stringify(
					{
						agentDir,
						socketPath,
						socketExists: existsSync(socketPath),
						pid,
						processAlive: pid ? isProcessAlive(pid) : false,
						servicePath: service.path,
						serviceInstalled: existsSync(service.path),
					},
					null,
					2,
				),
			);
		} else {
			throw new Error(`Unknown daemon command: ${command}`);
		}
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
	}
	return true;
}
