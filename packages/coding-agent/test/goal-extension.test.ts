import { fauxAssistantMessage } from "@lioooooo123/ever-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageRenderer,
	ToolDefinition,
} from "../src/core/extensions/index.ts";
import goalExtension from "../src/extensions/goal.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: never, ctx: ExtensionContext) => Promise<unknown> | unknown;

afterEach(() => {
	vi.useRealTimers();
});

function setup(initialEntries: Array<Record<string, unknown>> = []) {
	let entries = initialEntries;
	let activeTools = ["read"];
	const commands = new Map<string, CommandHandler>();
	const handlers = new Map<string, EventHandler[]>();
	let updateGoalTool: ToolDefinition | undefined;
	let goalStartRenderer: MessageRenderer | undefined;
	const appendEntry = vi.fn((customType: string, data: unknown) => {
		entries = [...entries, { type: "custom", customType, data }];
	});
	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
	const notify = vi.fn();
	const setStatus = vi.fn();
	const editor = vi.fn(async () => undefined);
	const isIdle = vi.fn(() => true);
	const abort = vi.fn();
	const api = {
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
		registerTool(tool: ToolDefinition) {
			if (tool.name === "update_goal") updateGoalTool = tool;
		},
		registerMessageRenderer(customType: string, renderer: MessageRenderer) {
			if (customType === "session-goal-start") goalStartRenderer = renderer;
		},
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry,
		sendMessage,
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		isIdle,
		abort,
		ui: {
			notify,
			setStatus,
			editor,
			theme: { fg: (_color: string, text: string) => text },
		},
		sessionManager: { getBranch: () => entries },
	} as unknown as ExtensionCommandContext;
	goalExtension(api);

	async function emit(event: string, payload: Record<string, unknown> = {}): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler({ type: event, ...payload } as never, ctx));
		}
		return results;
	}

	async function runGoal(args: string): Promise<void> {
		const command = commands.get("goal");
		if (!command) throw new Error("Missing /goal command");
		await command(args, ctx);
	}

	async function runUpdateGoal(params: Record<string, unknown>) {
		if (!updateGoalTool) throw new Error("Missing update_goal tool");
		return updateGoalTool.execute("tool-call", params, undefined, undefined, ctx);
	}

	return {
		activeTools: () => activeTools,
		appendEntry,
		abort,
		editor,
		emit,
		notify,
		runGoal,
		runUpdateGoal,
		sendMessage,
		setIdle(idle: boolean) {
			isIdle.mockReturnValue(idle);
		},
		setEntries(next: Array<Record<string, unknown>>) {
			entries = next;
		},
		setStatus,
		goalStartRenderer: () => goalStartRenderer,
	};
}

function activeGoal(objective: string, overrides: Record<string, unknown> = {}) {
	return {
		type: "custom",
		customType: "session-goal",
		data: {
			version: 1,
			objective,
			status: "active",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			turns: 0,
			automaticTurns: 0,
			totalTokens: 0,
			maxAutomaticTurns: 25,
			maxWallTimeMinutes: 240,
			evidence: [],
			consecutiveBlockedTurns: 0,
			...overrides,
		},
	};
}

describe("goal extension", () => {
	it("keeps ordinary Sessions idle and enables Goal control only after /goal", async () => {
		const runtime = setup();
		await runtime.emit("session_start", { reason: "startup" });

		expect(runtime.activeTools()).toEqual(["read"]);
		expect(runtime.sendMessage).not.toHaveBeenCalled();

		await runtime.runGoal("ship the session-native flow");

		expect(runtime.activeTools()).toEqual(["read", "update_goal"]);
		expect(runtime.appendEntry).toHaveBeenLastCalledWith(
			"session-goal",
			expect.objectContaining({ objective: "ship the session-native flow", status: "active" }),
		);
		expect(runtime.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "session-goal-start",
				content: "ship the session-native flow",
				display: true,
			}),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		expect(runtime.goalStartRenderer()).toBeDefined();
	});

	it("automatically continues after settlement and pauses at the turn budget", async () => {
		vi.useFakeTimers();
		const runtime = setup([activeGoal("finish the migration", { maxAutomaticTurns: 1 })]);
		await runtime.emit("session_start", { reason: "startup" });
		await runtime.emit("agent_end");
		await vi.runAllTimersAsync();

		expect(runtime.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ customType: "session-goal-continue", display: false }),
			{ triggerTurn: true, deliverAs: "followUp" },
		);

		await runtime.emit("agent_end");
		expect(runtime.appendEntry).toHaveBeenLastCalledWith(
			"session-goal",
			expect.objectContaining({ status: "paused", reason: "automatic turn budget exhausted" }),
		);
		expect(runtime.activeTools()).toEqual(["read"]);
	});

	it("requires evidence for completion and stops continuation when verified", async () => {
		const runtime = setup([activeGoal("verify the result")]);
		await runtime.emit("session_start", { reason: "startup" });

		expect(await runtime.runUpdateGoal({ status: "completed", summary: "done" })).toMatchObject({
			content: [{ text: expect.stringContaining("rejected") }],
		});

		expect(
			await runtime.runUpdateGoal({ status: "completed", summary: "tests pass", evidence: ["npm run check"] }),
		).toMatchObject({ terminate: true });
		expect(runtime.appendEntry).toHaveBeenLastCalledWith(
			"session-goal",
			expect.objectContaining({ status: "completed", evidence: ["npm run check"] }),
		);
		expect(runtime.activeTools()).toEqual(["read"]);
	});

	it("blocks only after the same blocker is reported on three consecutive Goal turns", async () => {
		vi.useFakeTimers();
		const runtime = setup([activeGoal("publish safely")]);
		await runtime.emit("session_start", { reason: "startup" });
		for (let report = 1; report <= 3; report++) {
			const result = await runtime.runUpdateGoal({
				status: "blocked",
				summary: "still waiting",
				blocker: "approval required",
			});
			expect(result).toMatchObject({ terminate: report === 3 });
			if (report < 3) await runtime.emit("agent_end");
		}
		expect(runtime.appendEntry).toHaveBeenLastCalledWith(
			"session-goal",
			expect.objectContaining({ status: "blocked", consecutiveBlockedTurns: 3 }),
		);
	});

	it("reconstructs the Goal when navigating the Session tree", async () => {
		const runtime = setup([activeGoal("branch A")]);
		await runtime.emit("session_start", { reason: "startup" });
		runtime.setEntries([activeGoal("branch B")]);
		await runtime.emit("session_tree", { newLeafId: "branch-b", oldLeafId: "branch-a" });
		const [context] = await runtime.emit("before_agent_start", { prompt: "continue" });

		expect(context).toEqual({
			message: expect.objectContaining({ content: expect.stringContaining("branch B") }),
		});
		expect(runtime.setStatus).toHaveBeenLastCalledWith("session-goal", expect.stringContaining("branch B"));
	});

	it("tracks tokens and exposes lifecycle state through /goal status", async () => {
		const runtime = setup([activeGoal("measure work")]);
		await runtime.emit("session_start", { reason: "startup" });
		const message = fauxAssistantMessage("working");
		await runtime.emit("message_end", { message });
		await runtime.emit("agent_end");
		await runtime.runGoal("status");

		expect(runtime.notify).toHaveBeenLastCalledWith(
			expect.stringContaining(`Tokens: ${message.usage.totalTokens}`),
			"info",
		);
		expect(runtime.notify).toHaveBeenLastCalledWith(expect.stringContaining("Turns: 1"), "info");
	});

	it("supports pause, resume, limits, completion, and clear without replacing the Session", async () => {
		const runtime = setup([activeGoal("manage lifecycle")]);
		await runtime.emit("session_start", { reason: "startup" });
		await runtime.runGoal("limit tokens 1000");
		await runtime.runGoal("pause");
		expect(runtime.activeTools()).toEqual(["read"]);
		await runtime.runGoal("resume");
		expect(runtime.activeTools()).toEqual(["read", "update_goal"]);
		await runtime.runGoal("complete");
		expect(runtime.activeTools()).toEqual(["read"]);
		await runtime.runGoal("clear");
		expect(runtime.appendEntry).toHaveBeenLastCalledWith("session-goal", { status: "cleared" });
	});

	it("stops an in-flight turn when the user pauses the Goal", async () => {
		const runtime = setup([activeGoal("stop expensive work")]);
		await runtime.emit("session_start", { reason: "startup" });
		runtime.setIdle(false);

		await runtime.runGoal("pause");

		expect(runtime.abort).toHaveBeenCalledOnce();
		expect(runtime.appendEntry).toHaveBeenLastCalledWith(
			"session-goal",
			expect.objectContaining({ status: "paused" }),
		);
		expect(runtime.notify).toHaveBeenLastCalledWith(
			"Goal paused. Current turn stopped. Use /goal resume to continue.",
			"info",
		);
	});

	it("does not queue duplicate work when an active Goal is resumed", async () => {
		const runtime = setup([activeGoal("avoid duplicate turns")]);
		await runtime.emit("session_start", { reason: "startup" });

		await runtime.runGoal("resume");

		expect(runtime.sendMessage).not.toHaveBeenCalled();
		expect(runtime.notify).toHaveBeenLastCalledWith("Goal is already running.", "info");
	});

	it("resumes a paused Goal without repeating its visible transcript entry", async () => {
		const runtime = setup([activeGoal("keep the transcript quiet", { status: "paused" })]);
		await runtime.emit("session_start", { reason: "startup" });

		await runtime.runGoal("resume");

		expect(runtime.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "session-goal-continue", display: false }),
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	it("requires an exhausted budget to be raised before resume", async () => {
		const runtime = setup([
			activeGoal("respect the hard limit", {
				status: "paused",
				automaticTurns: 2,
				maxAutomaticTurns: 2,
			}),
		]);
		await runtime.emit("session_start", { reason: "startup" });

		await expect(runtime.runGoal("resume")).rejects.toThrow(
			"Goal cannot resume: automatic turn budget exhausted. Increase the matching limit first.",
		);
		expect(runtime.sendMessage).not.toHaveBeenCalled();
	});

	it("starts a fresh blocker audit when a blocked Goal resumes", async () => {
		const runtime = setup([
			activeGoal("recover after approval", {
				status: "blocked",
				turns: 3,
				blocker: "approval required",
				consecutiveBlockedTurns: 3,
				lastBlockedAtTurn: 3,
			}),
		]);
		await runtime.emit("session_start", { reason: "startup" });

		await runtime.runGoal("resume");

		expect(runtime.appendEntry).toHaveBeenLastCalledWith(
			"session-goal",
			expect.objectContaining({
				status: "active",
				blocker: undefined,
				consecutiveBlockedTurns: 0,
				lastBlockedAtTurn: undefined,
			}),
		);
	});

	it("protects an unfinished Goal from accidental replacement", async () => {
		const runtime = setup([activeGoal("finish the current migration")]);
		await runtime.emit("session_start", { reason: "startup" });

		await expect(runtime.runGoal("start an unrelated migration")).rejects.toThrow(
			"A Goal is already active. Complete or clear it before starting another.",
		);
		expect(runtime.sendMessage).not.toHaveBeenCalled();
	});

	it("treats lifecycle words with additional text as a Goal objective", async () => {
		const runtime = setup();
		await runtime.emit("session_start", { reason: "startup" });

		await runtime.runGoal("complete the migration and verify it");

		expect(runtime.appendEntry).toHaveBeenLastCalledWith(
			"session-goal",
			expect.objectContaining({ objective: "complete the migration and verify it", status: "active" }),
		);
	});

	it("stops immediately when a new limit is already exhausted", async () => {
		const runtime = setup([activeGoal("stay within budget", { automaticTurns: 3 })]);
		await runtime.emit("session_start", { reason: "startup" });
		runtime.setIdle(false);

		await runtime.runGoal("limit turns 2");

		expect(runtime.abort).toHaveBeenCalledOnce();
		expect(runtime.appendEntry).toHaveBeenLastCalledWith(
			"session-goal",
			expect.objectContaining({ status: "paused", reason: "automatic turn budget exhausted" }),
		);
	});

	it("rejects oversized and terminal-control Goal input", async () => {
		const runtime = setup();
		await expect(runtime.runGoal(`bad\u001bgoal`)).rejects.toThrow("control characters");
		await expect(runtime.runGoal("x".repeat(8193))).rejects.toThrow("8192");
	});
});
