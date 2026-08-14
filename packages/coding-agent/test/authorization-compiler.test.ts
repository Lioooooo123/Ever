import { createHash } from "node:crypto";
import { type Context, fauxAssistantMessage } from "@lioooooo123/ever-ai";
import { describe, expect, it, vi } from "vitest";
import { ModelAuthorizationCompiler } from "../src/core/authorization-compiler.ts";

describe("ModelAuthorizationCompiler", () => {
	it("accepts only candidates entailed by user-authored evidence bytes", async () => {
		const text = "修复后推到 origin，创建 PR，检查通过后合并。";
		const complete = vi.fn(async (_context: Context) =>
			fauxAssistantMessage(
				JSON.stringify({
					schemaVersion: 1,
					candidates: [
						{
							action: "git_push",
							targets: { repository: "current", remote: "origin", branch: "current" },
							limits: { force: false },
							lifetime: "task",
							maxUses: 1,
							confidence: 0.99,
							evidenceSpans: [{ startByte: 0, endByte: Buffer.byteLength(text, "utf8") }],
						},
					],
				}),
			),
		);
		const candidates = await new ModelAuthorizationCompiler(complete).compile({
			id: "goal:task-1",
			taskId: "task-1",
			kind: "goal",
			text,
			textSha256: createHash("sha256").update(text).digest("hex"),
			state: "pending",
			createdAt: "2026-08-14T00:00:00.000Z",
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({ action: "git_push", targets: { remote: "origin" } });
		expect(complete.mock.calls[0]![0].tools).toEqual([]);
	});

	it.each([
		["不要推送到 origin", "git_push", { repository: "current", remote: "origin", branch: "current" }],
		["推到 origin", "git_push", { repository: "current", remote: "upstream", branch: "current" }],
	])("rejects denied or invented authority from %s", async (text, action, targets) => {
		const compiler = new ModelAuthorizationCompiler(async () =>
			fauxAssistantMessage(
				JSON.stringify({
					schemaVersion: 1,
					candidates: [
						{
							action,
							targets,
							limits: { force: false },
							lifetime: "task",
							maxUses: 1,
							confidence: 0.99,
							evidenceSpans: [{ startByte: 0, endByte: Buffer.byteLength(text, "utf8") }],
						},
					],
				}),
			),
		);
		await expect(
			compiler.compile({
				id: "goal:task-1",
				taskId: "task-1",
				kind: "goal",
				text,
				textSha256: createHash("sha256").update(text).digest("hex"),
				state: "pending",
				createdAt: "2026-08-14T00:00:00.000Z",
			}),
		).rejects.toThrow("not explicitly authorized");
	});

	it("requires an explicit finite count before compiling multiple uses", async () => {
		const compile = (text: string) =>
			new ModelAuthorizationCompiler(async () =>
				fauxAssistantMessage(
					JSON.stringify({
						schemaVersion: 1,
						candidates: [
							{
								action: "git_push",
								targets: { repository: "current", remote: "origin", branch: "current" },
								limits: { force: false },
								lifetime: "task",
								maxUses: 2,
								confidence: 0.99,
								evidenceSpans: [{ startByte: 0, endByte: Buffer.byteLength(text, "utf8") }],
							},
						],
					}),
				),
			).compile({
				id: `goal:${text}`,
				taskId: "task-1",
				kind: "goal",
				text,
				textSha256: createHash("sha256").update(text).digest("hex"),
				state: "pending",
				createdAt: "2026-08-14T00:00:00.000Z",
			});

		await expect(compile("推到 origin")).rejects.toThrow("use count");
		await expect(compile("推到 origin 2 次")).resolves.toHaveLength(1);
	});

	it("rejects model-invented force or bypass limits", async () => {
		const text = "推到 origin";
		const compiler = new ModelAuthorizationCompiler(async () =>
			fauxAssistantMessage(
				JSON.stringify({
					schemaVersion: 1,
					candidates: [
						{
							action: "git_push",
							targets: { repository: "current", remote: "origin", branch: "current" },
							limits: { force: true },
							lifetime: "task",
							maxUses: 1,
							confidence: 0.99,
							evidenceSpans: [{ startByte: 0, endByte: Buffer.byteLength(text, "utf8") }],
						},
					],
				}),
			),
		);
		await expect(
			compiler.compile({
				id: "goal:task-1",
				taskId: "task-1",
				kind: "goal",
				text,
				textSha256: createHash("sha256").update(text).digest("hex"),
				state: "pending",
				createdAt: "2026-08-14T00:00:00.000Z",
			}),
		).rejects.toThrow("force=true");
	});
});
