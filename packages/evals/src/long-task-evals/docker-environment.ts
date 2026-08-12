import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { EnvironmentAdapter, EnvironmentCommand, EnvironmentCommandResult, EvalEnvironment } from "./contracts.ts";
import { runProcess } from "./process.ts";
import type { EnvironmentIdentity, EvalCase } from "./schemas.ts";

async function requireSuccess(label: string, result: EnvironmentCommandResult): Promise<void> {
	if (result.exitCode === 0 && !result.timedOut) return;
	throw new Error(
		`${label} failed (${result.timedOut ? "timeout" : `exit ${result.exitCode ?? "unknown"}`}): ${result.stderr.trim()}`,
	);
}

class DockerEvalEnvironment implements EvalEnvironment {
	readonly identity: EnvironmentIdentity;
	readonly #containerId: string;
	#destroyed = false;

	constructor(containerId: string, identity: EnvironmentIdentity) {
		this.#containerId = containerId;
		this.identity = identity;
	}

	async exec(command: EnvironmentCommand): Promise<EnvironmentCommandResult> {
		if (this.#destroyed) throw new Error("Eval environment has already been destroyed");
		const args = ["exec"];
		if (command.cwd !== undefined) args.push("--workdir", command.cwd);
		for (const [key, value] of Object.entries(command.env ?? {})) args.push("--env", `${key}=${value}`);
		args.push(this.#containerId, ...command.args);
		return await runProcess("docker", args, { timeoutSeconds: command.timeoutSeconds });
	}

	async copyIn(source: string, destination: string): Promise<void> {
		if (this.#destroyed) throw new Error("Eval environment has already been destroyed");
		const result = await runProcess("docker", ["cp", resolve(source), `${this.#containerId}:${destination}`], {
			timeoutSeconds: 120,
		});
		await requireSuccess(`docker cp ${source}`, result);
	}

	async copyOut(source: string, destination: string): Promise<void> {
		if (this.#destroyed) throw new Error("Eval environment has already been destroyed");
		const result = await runProcess("docker", ["cp", `${this.#containerId}:${source}`, resolve(destination)], {
			timeoutSeconds: 120,
		});
		await requireSuccess(`docker cp ${source}`, result);
	}

	async readFile(path: string): Promise<string | undefined> {
		const result = await this.exec({ args: ["cat", path], timeoutSeconds: 30 });
		return result.exitCode === 0 && !result.timedOut ? result.stdout : undefined;
	}

	async destroy(): Promise<void> {
		if (this.#destroyed) return;
		this.#destroyed = true;
		const result = await runProcess("docker", ["rm", "--force", this.#containerId], { timeoutSeconds: 60 });
		if (result.exitCode !== 0 && !result.stderr.includes("No such container")) {
			throw new Error(`Failed to remove eval container ${this.#containerId}: ${result.stderr.trim()}`);
		}
	}
}

export class DockerEnvironmentAdapter implements EnvironmentAdapter {
	async preflight(): Promise<void> {
		const result = await runProcess("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutSeconds: 30 });
		await requireSuccess("Docker preflight", result);
	}

	async create(testCase: EvalCase, _runDirectory: string): Promise<EvalEnvironment> {
		const build = await runProcess("docker", ["build", "--quiet", testCase.environment.buildContext], {
			timeoutSeconds: Math.max(300, testCase.limits.trialTimeoutSeconds),
		});
		await requireSuccess(`Docker build for ${testCase.id}`, build);
		const imageDigest = build.stdout.trim().split("\n").at(-1);
		if (imageDigest === undefined || imageDigest === "")
			throw new Error(`Docker build for ${testCase.id} returned no image digest`);

		if (testCase.environment.imageDigest !== undefined && imageDigest !== testCase.environment.imageDigest) {
			throw new Error(
				`Docker image drift for ${testCase.id}: expected ${testCase.environment.imageDigest}, got ${imageDigest}`,
			);
		}

		const name = `ever-eval-${randomUUID()}`;
		const network = testCase.environment.network === "none" ? "none" : "bridge";
		const cpus = typeof testCase.metadata.cpus === "number" ? testCase.metadata.cpus : 2;
		const memoryMb = typeof testCase.metadata.memoryMb === "number" ? testCase.metadata.memoryMb : 4096;
		const create = await runProcess(
			"docker",
			[
				"create",
				"--name",
				name,
				"--network",
				network,
				"--cpus",
				String(cpus),
				"--memory",
				`${Math.ceil(memoryMb)}m`,
				"--pids-limit",
				"512",
				"--workdir",
				testCase.environment.workingDirectory,
				imageDigest,
				"sh",
				"-c",
				"trap 'exit 0' TERM INT; while :; do sleep 3600; done",
			],
			{ timeoutSeconds: 60 },
		);
		await requireSuccess(`Docker create for ${testCase.id}`, create);
		const containerId = create.stdout.trim();
		const identity: EnvironmentIdentity = { kind: "docker", imageDigest, network: testCase.environment.network };
		const environment = new DockerEvalEnvironment(containerId, identity);
		try {
			const start = await runProcess("docker", ["start", containerId], { timeoutSeconds: 60 });
			await requireSuccess(`Docker start for ${testCase.id}`, start);
			await requireSuccess(
				`Create verifier log directory for ${testCase.id}`,
				await environment.exec({ args: ["mkdir", "-p", "/logs/verifier"], timeoutSeconds: 30 }),
			);
			return environment;
		} catch (error) {
			await environment.destroy();
			throw error;
		}
	}
}
