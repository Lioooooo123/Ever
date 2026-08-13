import { spawn } from "node:child_process";

export interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export async function runProcess(
	command: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutSeconds?: number; input?: string },
): Promise<ProcessResult> {
	const timeoutSeconds = options.timeoutSeconds ?? 30;
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
		throw new Error("Process timeoutSeconds must be a positive finite number");
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		if (child.stdout === null || child.stderr === null) throw new Error("Process output pipes were not created");
		const stdoutPipe = child.stdout;
		const stderrPipe = child.stderr;
		stdoutPipe.setEncoding("utf8");
		stderrPipe.setEncoding("utf8");
		stdoutPipe.on("data", (chunk: string) => {
			stdout += chunk;
		});
		stderrPipe.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutSeconds * 1000);
		child.on("close", (exitCode) => {
			clearTimeout(timeout);
			resolve({ exitCode, stdout, stderr, timedOut });
		});
		if (options.input !== undefined) {
			if (child.stdin === null) throw new Error("Process input pipe was not created");
			child.stdin.end(options.input);
		}
	});
}
