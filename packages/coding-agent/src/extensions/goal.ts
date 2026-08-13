import { Text } from "@lioooooo123/ever-tui";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";

const GOAL_ENTRY_TYPE = "session-goal";
const GOAL_START_MESSAGE_TYPE = "session-goal-start";
const GOAL_CONTINUE_MESSAGE_TYPE = "session-goal-continue";
const UPDATE_GOAL_TOOL = "update_goal";
const DEFAULT_MAX_AUTOMATIC_TURNS = 25;
const DEFAULT_MAX_WALL_TIME_MINUTES = 240;
const MAX_GOAL_BYTES = 8192;

type GoalStatus = "active" | "paused" | "completed" | "blocked" | "cleared";

interface GoalState {
	version: 1;
	objective?: string;
	status: GoalStatus;
	createdAt: string;
	updatedAt: string;
	turns: number;
	automaticTurns: number;
	totalTokens: number;
	maxAutomaticTurns: number;
	maxWallTimeMinutes: number;
	maxTokens?: number;
	lastProgress?: string;
	evidence: string[];
	blocker?: string;
	consecutiveBlockedTurns: number;
	lastBlockedAtTurn?: number;
	reason?: string;
}

function normalizeGoal(value: string): string {
	return value.replace(/\r\n?/gu, "\n").trim();
}

function validateGoal(value: string): string {
	const objective = normalizeGoal(value);
	if (!objective) throw new Error("Goal cannot be empty.");
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(objective))
		throw new Error("Goal cannot contain terminal control characters.");
	if (new TextEncoder().encode(objective).byteLength > MAX_GOAL_BYTES)
		throw new Error(`Goal cannot exceed ${MAX_GOAL_BYTES} UTF-8 bytes.`);
	return objective;
}

function positiveInteger(value: string, label: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
	return parsed;
}

function newGoal(objective: string): GoalState {
	const now = new Date().toISOString();
	return {
		version: 1,
		objective,
		status: "active",
		createdAt: now,
		updatedAt: now,
		turns: 0,
		automaticTurns: 0,
		totalTokens: 0,
		maxAutomaticTurns: DEFAULT_MAX_AUTOMATIC_TURNS,
		maxWallTimeMinutes: DEFAULT_MAX_WALL_TIME_MINUTES,
		evidence: [],
		consecutiveBlockedTurns: 0,
	};
}

function restoreGoal(ctx: ExtensionContext): GoalState | undefined {
	const entry = ctx.sessionManager
		.getBranch()
		.filter((candidate) => candidate.type === "custom" && candidate.customType === GOAL_ENTRY_TYPE)
		.at(-1);
	if (!entry || entry.type !== "custom" || !entry.data || typeof entry.data !== "object") return undefined;
	const data = entry.data as Partial<GoalState>;
	if (!data.objective) return undefined;
	if (data.version === 1 && data.status) return { ...data, objective: normalizeGoal(data.objective) } as GoalState;
	return newGoal(normalizeGoal(data.objective));
}

function elapsedMinutes(state: GoalState): number {
	return Math.max(0, Math.floor((Date.now() - Date.parse(state.createdAt)) / 60_000));
}

function statusDetails(state: GoalState): string {
	const tokenBudget = state.maxTokens === undefined ? "unlimited" : state.maxTokens.toLocaleString();
	const details = [
		`GOAL ${state.status}`,
		state.objective ?? "",
		"",
		`Turns: ${state.turns} (${state.automaticTurns}/${state.maxAutomaticTurns} automatic)`,
		`Elapsed: ${elapsedMinutes(state)}/${state.maxWallTimeMinutes} minutes`,
		`Tokens: ${state.totalTokens.toLocaleString()}/${tokenBudget}`,
	];
	if (state.lastProgress) details.push(`Latest progress: ${state.lastProgress}`);
	if (state.blocker) details.push(`Blocker: ${state.blocker} (${state.consecutiveBlockedTurns}/3 reports)`);
	if (state.reason) details.push(`Reason: ${state.reason}`);
	if (state.evidence.length > 0) details.push(`Evidence:\n${state.evidence.map((item) => `- ${item}`).join("\n")}`);
	return details.join("\n");
}

function continuationPrompt(state: GoalState): string {
	return `Continue working autonomously toward the active session Goal.\n\nGoal: ${state.objective}\nLatest progress: ${state.lastProgress ?? "No progress report yet."}\nDo not repeat completed work. Verify concrete results before calling update_goal with status=completed. If the same blocker remains, report it with update_goal; the Goal becomes blocked only after three consecutive Goal turns report that blocker.`;
}

export default function goalExtension(ever: ExtensionAPI): void {
	let state: GoalState | undefined;
	let continuationScheduled = false;
	let goalRunActive = false;

	function updateTools(): void {
		const active = ever.getActiveTools().filter((name) => name !== UPDATE_GOAL_TOOL);
		if (state?.status === "active") active.push(UPDATE_GOAL_TOOL);
		ever.setActiveTools(active);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!state) {
			ctx.ui.setStatus(GOAL_ENTRY_TYPE, undefined);
			return;
		}
		const color =
			state.status === "active"
				? "accent"
				: state.status === "paused"
					? "warning"
					: state.status === "blocked"
						? "error"
						: "success";
		const objective = state.objective?.split("\n", 1)[0]?.trim() ?? "";
		ctx.ui.setStatus(
			GOAL_ENTRY_TYPE,
			`${ctx.ui.theme.fg(color, `GOAL ${state.status}`)}${ctx.ui.theme.fg("dim", `  ${objective}`)}`,
		);
	}

	function persist(ctx: ExtensionContext, next: GoalState | undefined): void {
		state = next;
		ever.appendEntry<GoalState | { status: "cleared" }>(GOAL_ENTRY_TYPE, next ?? { status: "cleared" });
		updateTools();
		updateStatus(ctx);
	}

	function mutate(ctx: ExtensionContext, update: (current: GoalState) => GoalState): GoalState {
		if (!state?.objective) throw new Error("No session Goal is active.");
		const next = update(state);
		persist(ctx, { ...next, updatedAt: new Date().toISOString() });
		return next;
	}

	function startGoalTurn(): void {
		if (!state?.objective || state.status !== "active") return;
		ever.sendMessage(
			{
				customType: GOAL_START_MESSAGE_TYPE,
				content: state.objective,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function continueGoalTurn(): void {
		if (!state?.objective || state.status !== "active") return;
		ever.sendMessage(
			{ customType: GOAL_CONTINUE_MESSAGE_TYPE, content: continuationPrompt(state), display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function exhaustedBudgetReason(current: GoalState): string | undefined {
		let reason: string | undefined;
		if (current.automaticTurns >= current.maxAutomaticTurns) reason = "automatic turn budget exhausted";
		else if (elapsedMinutes(current) >= current.maxWallTimeMinutes) reason = "wall-time budget exhausted";
		else if (current.maxTokens !== undefined && current.totalTokens >= current.maxTokens)
			reason = "token budget exhausted";
		return reason;
	}

	function pauseForBudget(ctx: ExtensionContext): string | undefined {
		if (!state || state.status !== "active") return undefined;
		const reason = exhaustedBudgetReason(state);
		if (!reason) return undefined;
		persist(ctx, { ...state, status: "paused", reason, updatedAt: new Date().toISOString() });
		ctx.ui.notify(`Goal paused: ${reason}. Use /goal resume to continue.`, "warning");
		return reason;
	}

	function abortRunningTurn(ctx: ExtensionContext): boolean {
		if (ctx.isIdle()) return false;
		ctx.abort();
		return true;
	}

	ever.registerMessageRenderer(GOAL_START_MESSAGE_TYPE, (message, { outputPad }, theme) => {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("\n");
		return new Text(`${theme.bold(theme.fg("accent", "GOAL"))}  ${content}`, outputPad, 0);
	});

	ever.registerTool({
		name: UPDATE_GOAL_TOOL,
		label: "Update Goal",
		description:
			"Report progress on the active session Goal, mark it completed with concrete evidence, or report a blocker. A blocker pauses the Goal only after the same blocker is reported on three consecutive Goal turns.",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("progress"), Type.Literal("completed"), Type.Literal("blocked")]),
			summary: Type.String({ minLength: 1 }),
			evidence: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			blocker: Type.Optional(Type.String({ minLength: 1 })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (!state?.objective || state.status !== "active") {
				return { content: [{ type: "text", text: "No active session Goal." }], details: {}, terminate: true };
			}
			if (params.status === "completed") {
				if (!params.evidence?.length) {
					return {
						content: [{ type: "text", text: "Completion rejected: provide concrete verification evidence." }],
						details: {},
					};
				}
				mutate(ctx, (current) => ({
					...current,
					status: "completed",
					lastProgress: params.summary,
					evidence: params.evidence ?? [],
					blocker: undefined,
					consecutiveBlockedTurns: 0,
					lastBlockedAtTurn: undefined,
					reason: "verified completion reported",
				}));
				return {
					content: [{ type: "text", text: "Goal completed and automatic continuation stopped." }],
					details: {},
					terminate: true,
				};
			}
			if (params.status === "blocked") {
				if (!params.blocker) {
					return { content: [{ type: "text", text: "Blocked status requires a concrete blocker." }], details: {} };
				}
				if (state.lastBlockedAtTurn === state.turns) {
					return {
						content: [{ type: "text", text: "A blocker was already reported during this Goal turn." }],
						details: {},
					};
				}
				const previousCount =
					state.blocker === params.blocker && state.lastBlockedAtTurn === state.turns - 1
						? state.consecutiveBlockedTurns
						: 0;
				const reports = previousCount + 1;
				const next = mutate(ctx, (current) => ({
					...current,
					status: reports >= 3 ? "blocked" : "active",
					lastProgress: params.summary,
					blocker: params.blocker,
					consecutiveBlockedTurns: reports,
					lastBlockedAtTurn: current.turns,
					reason: reports >= 3 ? "same blocker reported on three consecutive Goal turns" : undefined,
				}));
				return {
					content: [
						{
							type: "text",
							text:
								next.status === "blocked"
									? "Goal blocked after three consecutive reports; automatic continuation stopped."
									: `Blocker recorded (${reports}/3). Try another useful path before reporting it again.`,
						},
					],
					details: {},
					terminate: next.status === "blocked",
				};
			}
			mutate(ctx, (current) => ({
				...current,
				lastProgress: params.summary,
				evidence: params.evidence ?? current.evidence,
				blocker: undefined,
				consecutiveBlockedTurns: 0,
				lastBlockedAtTurn: undefined,
				reason: undefined,
			}));
			return { content: [{ type: "text", text: "Goal progress recorded." }], details: {} };
		},
	});

	ever.registerCommand("goal", {
		description: "Start or manage a long-running Goal in the current Session",
		getArgumentCompletions: (prefix) =>
			["status", "pause", "resume", "complete", "blocked", "limit", "clear"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const input = normalizeGoal(args);
			const [command, ...rest] = input.split(/\s+/u);
			if (input === "clear") {
				if (!state) {
					ctx.ui.notify("No session Goal to clear.", "info");
					return;
				}
				persist(ctx, undefined);
				const stopped = abortRunningTurn(ctx);
				ctx.ui.notify(stopped ? "Goal cleared. Current turn stopped." : "Goal cleared.", "info");
				return;
			}
			if (input === "status" || (!input && state)) {
				ctx.ui.notify(state ? statusDetails(state) : "No session Goal.", "info");
				return;
			}
			if (input === "pause") {
				if (state?.status === "paused") {
					ctx.ui.notify("Goal is already paused. Use /goal resume to continue.", "info");
					return;
				}
				if (state?.status === "completed") throw new Error("Completed Goal cannot be paused.");
				if (state?.status === "blocked") {
					ctx.ui.notify("Goal is blocked. Use /goal resume after resolving the blocker.", "warning");
					return;
				}
				mutate(ctx, (current) => ({ ...current, status: "paused", reason: "paused by user" }));
				const stopped = abortRunningTurn(ctx);
				ctx.ui.notify(
					stopped
						? "Goal paused. Current turn stopped. Use /goal resume to continue."
						: "Goal paused. Use /goal resume to continue.",
					"info",
				);
				return;
			}
			if (input === "resume") {
				if (state?.status === "active") {
					ctx.ui.notify("Goal is already running.", "info");
					return;
				}
				if (state?.status === "completed")
					throw new Error("Completed Goal cannot be resumed. Start a new Goal instead.");
				if (state) {
					const budgetReason = exhaustedBudgetReason(state);
					if (budgetReason)
						throw new Error(`Goal cannot resume: ${budgetReason}. Increase the matching limit first.`);
				}
				mutate(ctx, (current) => ({
					...current,
					status: "active",
					blocker: undefined,
					consecutiveBlockedTurns: 0,
					lastBlockedAtTurn: undefined,
					reason: undefined,
				}));
				ctx.ui.notify("Goal resumed.", "info");
				continueGoalTurn();
				return;
			}
			if (input === "complete") {
				mutate(ctx, (current) => ({ ...current, status: "completed", reason: "completed by user" }));
				const stopped = abortRunningTurn(ctx);
				ctx.ui.notify(stopped ? "Goal completed. Current turn stopped." : "Goal completed.", "info");
				return;
			}
			if (command === "blocked") {
				const reason = rest.join(" ").trim();
				if (!reason) throw new Error("Usage: /goal blocked <reason>");
				mutate(ctx, (current) => ({ ...current, status: "blocked", blocker: reason, reason: "blocked by user" }));
				const stopped = abortRunningTurn(ctx);
				ctx.ui.notify(`Goal blocked${stopped ? "; current turn stopped" : ""}: ${reason}`, "warning");
				return;
			}
			if (command === "limit") {
				const [kind, rawValue] = rest;
				if (!kind || !rawValue || !["turns", "minutes", "tokens"].includes(kind))
					throw new Error(
						"Usage: /goal limit <turns|minutes> <positive integer> | /goal limit tokens <positive integer|off>",
					);
				mutate(ctx, (current) => {
					if (kind === "tokens" && rawValue === "off") return { ...current, maxTokens: undefined };
					const value = positiveInteger(rawValue, `${kind} limit`);
					if (kind === "turns") return { ...current, maxAutomaticTurns: value };
					if (kind === "minutes") return { ...current, maxWallTimeMinutes: value };
					return { ...current, maxTokens: value };
				});
				if (pauseForBudget(ctx)) {
					abortRunningTurn(ctx);
					return;
				}
				ctx.ui.notify(`Goal ${kind} limit updated to ${rawValue}.`, "info");
				return;
			}
			let objective = input;
			if (!objective) {
				if (!ctx.hasUI) {
					ctx.ui.notify("No session Goal. Use /goal <text> to start one.", "info");
					return;
				}
				objective = normalizeGoal((await ctx.ui.editor("Set a long-running Goal for this Session:", "")) ?? "");
				if (!objective) return;
			}
			if (state && state.status !== "completed")
				throw new Error(`A Goal is already ${state.status}. Complete or clear it before starting another.`);
			persist(ctx, newGoal(validateGoal(objective)));
			startGoalTurn();
		},
	});

	function restore(ctx: ExtensionContext): void {
		state = restoreGoal(ctx);
		continuationScheduled = false;
		goalRunActive = false;
		updateTools();
		updateStatus(ctx);
	}

	ever.on("session_start", (_event, ctx) => restore(ctx));
	ever.on("session_tree", (_event, ctx) => restore(ctx));
	ever.on("agent_start", () => {
		goalRunActive = false;
	});
	ever.on("message_start", (event) => {
		if (
			event.message.role === "custom" &&
			(event.message.customType === GOAL_START_MESSAGE_TYPE ||
				event.message.customType === GOAL_CONTINUE_MESSAGE_TYPE)
		) {
			goalRunActive = true;
		}
	});

	ever.on("message_end", (event) => {
		if (!goalRunActive || !state || state.status !== "active" || event.message.role !== "assistant") return;
		state = { ...state, totalTokens: state.totalTokens + event.message.usage.totalTokens };
	});

	ever.on("agent_end", (_event, ctx) => {
		const completedGoalRun = goalRunActive;
		goalRunActive = false;
		if (!completedGoalRun || !state || state.status !== "active") return;
		persist(ctx, { ...state, turns: state.turns + 1, updatedAt: new Date().toISOString() });
		if (pauseForBudget(ctx) || continuationScheduled || !state) return;
		continuationScheduled = true;
		state = {
			...state,
			automaticTurns: state.automaticTurns + 1,
			updatedAt: new Date().toISOString(),
		};
		ever.appendEntry<GoalState>(GOAL_ENTRY_TYPE, state);
		continuationScheduled = false;
		continueGoalTurn();
	});

	ever.on("before_agent_start", () => {
		if (!state?.objective || state.status !== "active") return;
		return {
			message: {
				customType: "session-goal-context",
				content: `[SESSION GOAL]\n${statusDetails(state)}\n\nThis Goal is the opt-in long-running mode for the current Session. Continue until verified completion, a budget pause, or the same blocker has been reported on three consecutive Goal turns. Use update_goal to record progress, completion evidence, or a blocker. Never claim completion without concrete evidence.`,
				display: false,
			},
		};
	});
}
