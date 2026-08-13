import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExternalBenchmarkRunner } from "../../src/external-evals/harbor-runner.ts";
import { digestPath } from "../../src/external-evals/hash.ts";

async function fakeHarbor(root: string): Promise<string> {
	const path = join(root, "harbor");
	await writeFile(
		path,
		`#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "harbor 0.21.0"
  exit 0
fi
if [ "$1" = "run" ]; then
  config="$3"
  job_dir=$(node -e 'const c=require(process.argv[1]); process.stdout.write(c.jobs_dir+"/"+c.job_name)' "$config")
else
  job_dir="$4"
fi
mkdir -p "$job_dir"
mkdir -p "$job_dir/local-task.1"
printf '%s\n' '{"n_total_trials":1,"stats":{"n_completed_trials":1}}' > "$job_dir/result.json"
printf '%s\n' '{"task_name":"local-task","trial_name":"local-task.1","task_checksum":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","agent_info":{"name":"oracle","version":"1.0.0"},"agent_result":{"n_input_tokens":10,"n_output_tokens":5,"cost_usd":0.01},"verifier_result":{"rewards":{"reward":1,"quality":0.9}},"started_at":"2026-01-01T00:00:00Z","finished_at":"2026-01-01T00:00:01.234Z"}' > "$job_dir/local-task.1/result.json"
`,
		{ mode: 0o700 },
	);
	await chmod(path, 0o700);
	return path;
}

describe("ExternalBenchmarkRunner", () => {
	it("keeps Ever credentials behind the native unattended Task sandbox", async () => {
		const shim = await readFile(join(import.meta.dirname, "../../harbor_agent/ever_agent.py"), "utf8");
		expect(shim).toContain('"EVER_UNATTENDED_SANDBOX": "1"');
		expect(shim).toContain('["task", "submit"');
		expect(shim).not.toContain('"--mode",\n            "json"');
	});

	it("runs and resumes a generic Harbor job into normalized artifacts", async () => {
		const root = await mkdtemp(join(tmpdir(), "ever-external-eval-"));
		const artifactRoot = join(root, "artifacts");
		const taskPath = join(root, "task");
		await mkdir(taskPath);
		const harbor = await fakeHarbor(root);
		const configPath = join(root, "config.json");
		const taskDigest = await digestPath(taskPath);
		await writeFile(
			configPath,
			JSON.stringify({
				schemaVersion: 1,
				engine: { name: "harbor", version: "0.21.0", executable: harbor },
				benchmark: { kind: "local", path: "./task", sha256: taskDigest },
				agent: { kind: "harbor", name: "oracle", version: "1.0.0", env: ["EVER_EXTERNAL_EVAL_TEST_TOKEN"] },
				execution: {
					environment: "docker",
					repetitions: 1,
					concurrency: 1,
					maxTrials: 1,
					maxWallTimeMinutes: 1,
					maxCostUsd: 1,
				},
				acceptance: { metrics: { reward: 1, quality: 0.8 }, allowIncomplete: false },
			}),
		);
		process.env.EVER_EXTERNAL_EVAL_TEST_TOKEN = "must-not-be-persisted";
		const runner = new ExternalBenchmarkRunner(artifactRoot);
		const first = await runner.run(configPath);
		delete process.env.EVER_EXTERNAL_EVAL_TEST_TOKEN;
		expect(first.results).toEqual([
			expect.objectContaining({ taskName: "local-task", completed: true, metrics: { reward: 1, quality: 0.9 } }),
		]);
		expect(JSON.parse(await readFile(join(first.jobDirectory, "acceptance.json"), "utf8"))).toMatchObject({
			passed: true,
		});
		expect(JSON.parse(await readFile(join(first.jobDirectory, "report.json"), "utf8"))).toMatchObject({
			summary: { totalRuns: 1, successfulRuns: 1 },
		});
		const persistedConfig = await readFile(join(first.jobDirectory, "harbor-config.json"), "utf8");
		expect(persistedConfig).not.toContain("must-not-be-persisted");
		expect(persistedConfig).toContain('"n_tasks": 1');
		expect(persistedConfig).toContain("benchmark-snapshot");
		process.env.EVER_EXTERNAL_EVAL_TEST_TOKEN = "must-not-be-persisted";
		const resumed = await runner.resume(first.jobId);
		delete process.env.EVER_EXTERNAL_EVAL_TEST_TOKEN;
		expect(resumed.results).toHaveLength(1);
	});
});
