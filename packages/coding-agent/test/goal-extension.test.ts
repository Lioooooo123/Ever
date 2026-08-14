import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	DurableGoalHost,
	DurableGoalSnapshot,
	DurablePermissionGrantSummary,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageRenderer,
	ToolDefinition,
} from "../src/core/extensions/index.ts";
import goalExtension from "../src/extensions/goal.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type EventHandler = (event: never, ctx: ExtensionContext) => Promise<unknown> | unknown;

function runningGoal(overrides: Partial<DurableGoalSnapshot> = {}): DurableGoalSnapshot {
	return {
		taskId: "12345678-1234-1234-1234-123456789abc",
		goal: "finish the durable migration",
		state: "running",
		totalTurns: 2,
		totalCostUsd: 0.25,
		maxTurns: 25,
		maxWallTimeMinutes: 240,
		...overrides,
	};
}

function setup(
	options: {
		legacyEntry?: boolean;
		initialGoal?: DurableGoalSnapshot;
		permissionGrants?: DurablePermissionGrantSummary[];
	} = {},
) {
	let activeTools = ["read"];
	let current = options.initialGoal;
	const commands = new Map<string, CommandHandler>();
	const handlers = new Map<string, EventHandler[]>();
	let taskUpdate: ToolDefinition | undefined;
	let renderer: MessageRenderer | undefined;
	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
	const notify = vi.fn();
	const setStatus = vi.fn();
	const update = vi.fn(async (_toolCallId: string, input: Parameters<DurableGoalHost["update"]>[1]) => {
		if (input.action === "wait" && current)
			current = { ...current, state: "waiting_input", stateReason: input.reason };
		return { accepted: true, state: current?.state };
	});
	const host: DurableGoalHost = {
		status: () => current,
		start: vi.fn(async (goal: string) => {
			current = runningGoal({ goal });
			return current;
		}),
		pause: vi.fn(async () => {
			if (!current) throw new Error("No Task");
			current = { ...current, state: "paused", stateReason: "paused by user" };
			return current;
		}),
		resume: vi.fn(async () => {
			if (!current) throw new Error("No Task");
			current = { ...current, state: "running", stateReason: undefined };
			return current;
		}),
		cancel: vi.fn(async () => {
			if (!current) throw new Error("No Task");
			current = { ...current, state: "cancelled", stateReason: "cancelled by user" };
			return current;
		}),
		update,
		listPermissionGrants: () => options.permissionGrants ?? [],
		revokePermissionGrant: vi.fn((grantId: string) => {
			const grant = options.permissionGrants?.find((candidate) => candidate.id === grantId);
			if (!grant) throw new Error("Grant not found");
			return { ...grant, state: "revoked" as const };
		}),
	};
	const api = {
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		registerTool(tool: ToolDefinition) {
			if (tool.name === "task_update") taskUpdate = tool;
		},
		registerMessageRenderer(type: string, next: MessageRenderer) {
			if (type === "durable-goal-start") renderer = next;
		},
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage,
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		durableGoal: host,
		ui: {
			notify,
			setStatus,
			editor: vi.fn(async () => undefined),
			theme: { fg: (_color: string, text: string) => text },
		},
		sessionManager: {
			getBranch: () =>
				options.legacyEntry ? [{ type: "custom", customType: "session-goal", data: { objective: "old" } }] : [],
		},
	} as unknown as ExtensionCommandContext;
	goalExtension(api);

	return {
		activeTools: () => activeTools,
		host,
		notify,
		renderer: () => renderer,
		sendMessage,
		setStatus,
		update,
		async emit(event: string): Promise<void> {
			for (const handler of handlers.get(event) ?? []) await handler({ type: event } as never, ctx);
		},
		async runGoal(args: string): Promise<void> {
			const command = commands.get("goal");
			if (!command) throw new Error("Missing /goal command");
			await command(args, ctx);
		},
		async runTaskUpdate(input: Record<string, unknown>) {
			if (!taskUpdate) throw new Error("Missing task_update tool");
			return taskUpdate.execute("tool-1", input, undefined, undefined, ctx);
		},
	};
}

afterEach(() => vi.restoreAllMocks());

describe("durable Goal adapter", () => {
	it("rejects Task creation inside an already running Session", async () => {
		const runtime = setup();
		await runtime.emit("session_start");
		expect(runtime.activeTools()).toEqual(["read"]);

		await expect(runtime.runGoal("ship the unified execution chain")).rejects.toThrow(
			"Create Tasks from Task Home or ever <goal>",
		);

		expect(runtime.host.start).not.toHaveBeenCalled();
		expect(runtime.activeTools()).toEqual(["read"]);
		expect(runtime.renderer()).toBeDefined();
	});

	it("does not schedule continuation from extension lifecycle events", async () => {
		const runtime = setup({ initialGoal: runningGoal() });
		await runtime.emit("session_start");
		await runtime.emit("agent_settled");
		expect(runtime.sendMessage).not.toHaveBeenCalled();
	});

	it("delegates Task progress and evidence without storing extension Goal state", async () => {
		const runtime = setup({ initialGoal: runningGoal() });
		await runtime.emit("session_start");
		const update = {
			action: "checkpoint",
			summary: "migration is half complete",
			completedItems: ["schema"],
			nextActions: ["runtime"],
			evidence: [],
		};

		await runtime.runTaskUpdate(update);

		expect(runtime.update).toHaveBeenCalledWith("tool-1", update);
	});

	it("maps pause, resume, blocked, and cancel commands to Task controls", async () => {
		const runtime = setup({ initialGoal: runningGoal() });
		await runtime.emit("session_start");
		await runtime.runGoal("pause");
		expect(runtime.host.pause).toHaveBeenCalledOnce();
		await runtime.runGoal("resume");
		expect(runtime.host.resume).toHaveBeenCalledOnce();
		await runtime.runGoal("blocked approval required");
		expect(runtime.update).toHaveBeenLastCalledWith(
			expect.stringMatching(/^user-blocked-/),
			expect.objectContaining({ action: "wait", waitKind: "user", reason: "approval required" }),
		);
		await runtime.runGoal("cancel");
		expect(runtime.host.cancel).toHaveBeenCalledOnce();
		expect(runtime.activeTools()).toEqual(["read"]);
	});

	it("lists and revokes durable permission grants through the Task host", async () => {
		const grant: DurablePermissionGrantSummary = {
			id: "grant-12345678",
			lifetime: "task",
			state: "active",
			tools: ["bash"],
			effects: ["process"],
			paths: [process.cwd()],
			createdAt: "2026-08-14T00:00:00.000Z",
		};
		const runtime = setup({ initialGoal: runningGoal(), permissionGrants: [grant] });

		await runtime.runGoal(`permissions revoke ${grant.id}`);

		expect(runtime.host.revokePermissionGrant).toHaveBeenCalledWith(grant.id);
		expect(runtime.notify).toHaveBeenCalledWith(expect.stringContaining("Revoked permission"), "info");
	});

	it("shows legacy Goal entries only as a migration notice", async () => {
		const runtime = setup({ legacyEntry: true });
		await runtime.emit("session_start");
		expect(runtime.notify).toHaveBeenCalledWith(expect.stringContaining("legacy Goal record"), "warning");
		expect(runtime.sendMessage).not.toHaveBeenCalled();
	});

	it("does not expose a second Goal creation syntax", async () => {
		const runtime = setup();
		await expect(runtime.runGoal("new objective")).rejects.toThrow("Usage: /goal status");
		expect(runtime.host.start).not.toHaveBeenCalled();
	});
});
