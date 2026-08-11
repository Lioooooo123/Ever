import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashDirectory } from "../../src/long-task-evals/hash.ts";
import { exportRedactedJob } from "../../src/long-task-evals/redaction.ts";
import { TerminalBench21Adapter } from "../../src/long-task-evals/terminal-bench-2-1.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Eval artifact redaction", () => {
	it("redacts configured and conventional credentials while omitting binary files", async () => {
		const root = await mkdtemp(join(tmpdir(), "eval-redaction-"));
		temporaryDirectories.push(root);
		const source = join(root, "job");
		const destination = join(root, "shared");
		await mkdir(source);
		await writeFile(join(source, "trace.jsonl"), "Authorization: Bearer abc\nOPENAI_API_KEY=secret-value\n");
		await writeFile(join(source, "binary.bin"), Buffer.from([0, 1, 2]));

		const report = await exportRedactedJob(source, destination, ["secret-value"]);
		const shared = await readFile(join(destination, "trace.jsonl"), "utf8");
		expect(shared).not.toContain("abc");
		expect(shared).not.toContain("secret-value");
		expect(report.omittedBinaryFiles).toEqual(["binary.bin"]);
		await expect(readFile(join(destination, "binary.bin"))).rejects.toThrow();
	});
});

async function createTask(root: string): Promise<void> {
	const taskRoot = join(root, "nested", "task-one");
	await mkdir(join(taskRoot, "environment"), { recursive: true });
	await mkdir(join(taskRoot, "tests"));
	await mkdir(join(taskRoot, "solution"));
	await writeFile(join(taskRoot, "instruction.md"), "Make the command pass.\n");
	await writeFile(
		join(taskRoot, "task.toml"),
		`schema_version = "1.3"

[task]
name = "terminal-bench/task-one"

[agent]
timeout_sec = 42
network_mode = "public"

[verifier]
timeout_sec = 17

[environment]
cpus = 3
memory_mb = 2048
`,
	);
	await writeFile(join(taskRoot, "environment", "Dockerfile"), "FROM alpine:3.22\nWORKDIR /app\n");
	await writeFile(join(taskRoot, "tests", "test.sh"), "#!/bin/sh\necho 1 > /logs/verifier/reward.txt\n");
	await writeFile(join(taskRoot, "solution", "solve.sh"), "#!/bin/sh\ntouch /app/done\n");
}

describe("Terminal-Bench 2.1 adapter", () => {
	it("loads the official instruction file and declared limits without exposing solution paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "terminal-bench-adapter-"));
		temporaryDirectories.push(root);
		await createTask(root);

		const [testCase] = await new TerminalBench21Adapter(root).listCases();
		expect(testCase).toMatchObject({
			id: "terminal-bench/task-one",
			instruction: "Make the command pass.",
			environment: { network: "benchmark_declared" },
			verifier: { timeoutSeconds: 17 },
			limits: { trialTimeoutSeconds: 42 },
			metadata: { cpus: 3, memoryMb: 2048 },
		});
		expect(JSON.stringify(testCase)).not.toContain("solution");
	});

	it("rejects symlinks in immutable benchmark sources", async () => {
		const root = await mkdtemp(join(tmpdir(), "terminal-bench-adapter-"));
		temporaryDirectories.push(root);
		await writeFile(join(root, "target"), "secret");
		await symlink(join(root, "target"), join(root, "link"));

		await expect(hashDirectory(root)).rejects.toThrow("symlinks");
	});
});
