import { Text } from "@lioooooo123/ever-tui";
import { Type } from "typebox";
import type { DurableGoalSnapshot, ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";

const LEGACY_GOAL_ENTRY_TYPE = "session-goal";
const GOAL_START_MESSAGE_TYPE = "durable-goal-start";
const TASK_UPDATE_TOOL = "task_update";

function normalizeGoal(value: string): string {
	return value.replace(/\r\n?/gu, "\n").trim();
}

function statusDetails(goal: DurableGoalSnapshot): string {
	return [
		`TASK ${goal.taskId.slice(0, 8)}  ${goal.state}`,
		goal.goal,
		`Turns: ${goal.totalTurns}/${goal.maxTurns}`,
		`Wall time budget: ${goal.maxWallTimeMinutes} minutes`,
		`Cost: $${goal.totalCostUsd.toFixed(4)}`,
		...(goal.stateReason ? [`Reason: ${goal.stateReason}`] : []),
	].join("\n");
}

function isRunning(goal: DurableGoalSnapshot | undefined): boolean {
	return goal?.state === "queued" || goal?.state === "running";
}

export default function goalExtension(ever: ExtensionAPI): void {
	function updatePresentation(ctx: ExtensionContext): void {
		const goal = ctx.durableGoal.status();
		const tools = ever.getActiveTools().filter((name) => name !== TASK_UPDATE_TOOL);
		if (isRunning(goal)) tools.push(TASK_UPDATE_TOOL);
		ever.setActiveTools(tools);
		if (!ctx.hasUI) return;
		if (!goal) {
			ctx.ui.setStatus(LEGACY_GOAL_ENTRY_TYPE, undefined);
			return;
		}
		const color =
			goal.state === "running" || goal.state === "queued"
				? "accent"
				: goal.state === "paused" || goal.state.startsWith("waiting_")
					? "warning"
					: goal.state === "completed"
						? "success"
						: "error";
		ctx.ui.setStatus(
			LEGACY_GOAL_ENTRY_TYPE,
			`${ctx.ui.theme.fg(color, `TASK ${goal.state}`)}${ctx.ui.theme.fg("dim", `  ${goal.taskId.slice(0, 8)}`)}`,
		);
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
		name: TASK_UPDATE_TOOL,
		label: "Task Update",
		description: "Persist durable Task progress, wait, request evidence-backed completion, or fail the Task.",
		promptSnippet: "task_update: persist progress and request evidence-backed completion",
		durability: {
			effect: "reconcilable_write",
			idempotency: "reconcilable",
			requiresSandbox: false,
		},
		parameters: Type.Union([
			Type.Object({
				action: Type.Literal("checkpoint"),
				summary: Type.String({ maxLength: 4000 }),
				completedItems: Type.Array(Type.String()),
				currentItem: Type.Optional(Type.String()),
				nextActions: Type.Array(Type.String()),
				evidence: Type.Array(
					Type.Object({
						id: Type.String({ minLength: 1 }),
						kind: Type.Union([
							Type.Literal("command"),
							Type.Literal("file"),
							Type.Literal("artifact"),
							Type.Literal("event"),
						]),
						ref: Type.String({ minLength: 1 }),
						sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
						summary: Type.Optional(Type.String()),
					}),
				),
			}),
			Type.Object({
				action: Type.Literal("wait"),
				waitKind: Type.Union([Type.Literal("user"), Type.Literal("time"), Type.Literal("external")]),
				reason: Type.String(),
				resumeAt: Type.Optional(Type.String()),
			}),
			Type.Object({
				action: Type.Literal("complete"),
				summary: Type.String(),
				evidence: Type.Array(
					Type.Object({
						id: Type.String({ minLength: 1 }),
						kind: Type.Union([
							Type.Literal("command"),
							Type.Literal("file"),
							Type.Literal("artifact"),
							Type.Literal("event"),
						]),
						ref: Type.String({ minLength: 1 }),
						sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
						summary: Type.Optional(Type.String()),
					}),
				),
			}),
			Type.Object({ action: Type.Literal("fail"), code: Type.String(), reason: Type.String() }),
		]),
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			const result = await ctx.durableGoal.update(toolCallId, params);
			updatePresentation(ctx);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
				terminate: params.action === "complete" || params.action === "fail" || params.action === "wait",
			};
		},
	});

	ever.registerCommand("goal", {
		description: "Manage the durable Task attached to this Session",
		getArgumentCompletions: (prefix) =>
			["status", "pause", "resume", "cancel", "blocked", "permissions"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const input = normalizeGoal(args);
			const [command, ...rest] = input.split(/\s+/u);
			if (input === "status" || (!input && ctx.durableGoal.status())) {
				const goal = ctx.durableGoal.status();
				ctx.ui.notify(goal ? statusDetails(goal) : "No durable Goal Task is attached.", "info");
				return;
			}
			if (input === "pause") {
				ctx.ui.notify(statusDetails(await ctx.durableGoal.pause()), "info");
				updatePresentation(ctx);
				return;
			}
			if (input === "resume") {
				const goal = await ctx.durableGoal.resume();
				updatePresentation(ctx);
				ever.sendMessage(
					{
						customType: GOAL_START_MESSAGE_TYPE,
						content: `Resume durable Task ${goal.taskId.slice(0, 8)}: ${goal.goal}`,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				return;
			}
			if (input === "cancel" || input === "clear") {
				ctx.ui.notify(statusDetails(await ctx.durableGoal.cancel()), "info");
				updatePresentation(ctx);
				return;
			}
			if (command === "permissions") {
				const grants = ctx.durableGoal.listPermissionGrants().filter((grant) => grant.state === "active");
				if (rest[0] === "revoke") {
					const grantId = rest[1];
					if (!grantId) throw new Error("Usage: /goal permissions revoke <grant-id>");
					const revoked = ctx.durableGoal.revokePermissionGrant(grantId);
					ctx.ui.notify(`Revoked permission ${revoked.id.slice(0, 8)}.`, "info");
					return;
				}
				if (grants.length === 0) {
					ctx.ui.notify("No active durable permission grants.", "info");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify(
						grants
							.map(
								(grant) => `${grant.id}  ${grant.lifetime}  ${grant.tools.join(",")}  ${grant.paths.join(",")}`,
							)
							.join("\n"),
						"info",
					);
					return;
				}
				const labels = grants.map(
					(grant) =>
						`${grant.id.slice(0, 8)}  ${grant.lifetime}  ${grant.tools.join(",")}  ${grant.paths.join(",")}`,
				);
				const selected = await ctx.ui.select("Select a permission grant to revoke", [...labels, "Cancel"]);
				const index = selected ? labels.indexOf(selected) : -1;
				if (index < 0) return;
				const selectedGrant = grants[index];
				if (!selectedGrant) return;
				const revoked = ctx.durableGoal.revokePermissionGrant(selectedGrant.id);
				ctx.ui.notify(`Revoked permission ${revoked.id.slice(0, 8)}.`, "info");
				return;
			}
			if (command === "blocked") {
				const reason = rest.join(" ").trim();
				if (!reason) throw new Error("Usage: /goal blocked <reason>");
				await ctx.durableGoal.update(`user-blocked-${Date.now()}`, {
					action: "wait",
					waitKind: "user",
					reason,
				});
				updatePresentation(ctx);
				ctx.ui.notify(`Task is waiting for input: ${reason}`, "warning");
				return;
			}
			throw new Error(
				"Usage: /goal status|pause|resume|blocked <reason>|cancel|permissions. Create Tasks from Task Home or ever <goal>.",
			);
		},
	});

	ever.on("session_start", (_event, ctx) => {
		updatePresentation(ctx);
		if (ctx.durableGoal.status()) return;
		const legacy = ctx.sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom" && entry.customType === LEGACY_GOAL_ENTRY_TYPE);
		if (legacy && ctx.hasUI)
			ctx.ui.notify(
				"This Session contains a legacy Goal record. It is read-only; create a Task from Task Home or ever <goal>.",
				"warning",
			);
	});
	ever.on("session_tree", (_event, ctx) => updatePresentation(ctx));
}
