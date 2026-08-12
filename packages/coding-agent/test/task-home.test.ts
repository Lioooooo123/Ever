import type { Credential, CredentialStore } from "@lioooooo123/ever-ai";
import type { TaskRecord } from "@lioooooo123/ever-long-tasks";
import { describe, expect, it } from "vitest";
import { getProviderSetupOptions } from "../src/cli/provider-setup.ts";
import { formatTaskHomeTaskLabel, formatTaskHomeTitle, needsFirstRunSetup } from "../src/cli/task-home.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function task(state: TaskRecord["state"], title = "修复恢复流程"): TaskRecord {
	return {
		id: "12345678-abcd-4321-abcd-1234567890ab",
		title,
		goal: title,
		acceptance: [],
		constraints: {},
		budget: { maxTurns: 20, maxWallTimeMinutes: 45 },
		state,
		workspaceRoot: "/tmp/workspace",
		workspaceFingerprint: "fingerprint",
		totalTurns: 3,
		totalCostUsd: 0.12,
		createdAt: "2026-08-13T00:00:00.000Z",
		updatedAt: "2026-08-13T00:00:00.000Z",
	};
}

describe("Task Home presentation", () => {
	it("shows active Task count and the pinned model", () => {
		const title = formatTaskHomeTitle(
			[task("running"), task("waiting_input"), task("completed")],
			"openai-codex/gpt-5.4",
		);

		expect(title).toContain("EVER / TASK HOME");
		expect(title).toContain("2 个进行中  ·  3 个 Task");
		expect(title).toContain("openai-codex/gpt-5.4");
	});

	it("uses a compact localized state label without ellipsis truncation", () => {
		const label = formatTaskHomeTaskLabel(task("unknown_outcome", "这是一个很长的任务标题".repeat(8)));

		expect(label).toContain("[结果待确认]  12345678");
		expect(label).not.toContain("…");
		expect(label.length).toBeLessThanOrEqual(70);
	});

	it("opens Provider setup before an empty first-run Home", () => {
		expect(needsFirstRunSetup(0, false)).toBe(true);
		expect(needsFirstRunSetup(1, false)).toBe(false);
		expect(needsFirstRunSetup(0, true)).toBe(false);
	});
});

describe("Provider setup", () => {
	it("offers the native OAuth and API-key login methods", async () => {
		const stored = new Map<string, Credential>();
		const credentials: CredentialStore = {
			async read(providerId) {
				return stored.get(providerId);
			},
			async list() {
				return [...stored].map(([providerId, credential]) => ({ providerId, type: credential.type }));
			},
			async modify(providerId, update) {
				const next = await update(stored.get(providerId));
				if (next) stored.set(providerId, next);
				return next;
			},
			async delete(providerId) {
				stored.delete(providerId);
			},
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });

		const options = getProviderSetupOptions(runtime);

		expect(options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "anthropic", authType: "oauth" }),
				expect.objectContaining({ id: "anthropic", authType: "api_key" }),
				expect.objectContaining({ id: "openai-codex", authType: "oauth" }),
			]),
		);
	});
});
