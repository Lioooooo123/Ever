import type { AgentMessage } from "@lioooooo123/ever-agent-core";
import type { AssistantMessage } from "@lioooooo123/ever-ai/compat";
import { type Container, type MarkdownTheme, Spacer, Text, type TUI } from "@lioooooo123/ever-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { CACHE_TTL_MS, type CacheMiss, collectCacheMisses } from "../../core/cache-stats.ts";
import type { MarkdownTransformer } from "../../core/extensions/types.ts";
import { type SessionEntry, sessionEntryToContextMessages } from "../../core/session-manager.ts";
import type { TruncationResult } from "../../core/tools/truncate.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CustomEntryComponent } from "./components/custom-entry.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { formatTokens } from "./components/footer.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { getUserMessageText, UserSessionMessageComponent } from "./components/user-session-message.ts";
import { theme } from "./theme/theme.ts";

type RenderSessionItem = AgentMessage | Extract<SessionEntry, { type: "custom" }>;

function isCustomSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "custom" }> {
	return "type" in item && item.type === "custom";
}

export interface SessionPresentationOptions {
	container: Container;
	ui: TUI;
	pendingTools: Map<string, ToolExecutionComponent>;
	getSession(): AgentSession;
	getMarkdownTheme(): MarkdownTheme;
	getMarkdownTransformers(): readonly MarkdownTransformer[];
	getOutputPad(): number;
	getToolsExpanded(): boolean;
	getHideThinkingBlock(): boolean;
	getHiddenThinkingLabel(): string;
	getRetryAttempt(): number;
	addHistory(text: string): void;
	updateFooter(): void;
	updateEditorBorder(): void;
}

/** Owns composition of durable Session entries into transcript modules. */
export class SessionPresentation {
	private readonly options: SessionPresentationOptions;

	constructor(options: SessionPresentationOptions) {
		this.options = options;
	}

	createCustomEntry(entry: Extract<SessionEntry, { type: "custom" }>): CustomEntryComponent | undefined {
		const session = this.options.getSession();
		const renderer = session.extensionRunner.getEntryRenderer(entry.customType);
		if (!renderer) return undefined;
		const rendered = new CustomEntryComponent(entry, renderer);
		rendered.setExpanded(this.options.getToolsExpanded());
		return rendered.hasContent() ? rendered : undefined;
	}

	appendCustomEntry(entry: Extract<SessionEntry, { type: "custom" }>): void {
		const { container } = this.options;
		const rendered = this.createCustomEntry(entry);
		if (rendered) container.addChild(rendered);
	}

	appendMessage(message: AgentMessage, populateHistory = false): void {
		const { container, ui } = this.options;
		const session = this.options.getSession();
		switch (message.role) {
			case "bashExecution": {
				const rendered = new BashExecutionComponent(message.command, ui, message.excludeFromContext);
				if (message.output) rendered.appendOutput(message.output);
				rendered.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				container.addChild(rendered);
				return;
			}
			case "custom": {
				if (!message.display) return;
				const rendered = new CustomMessageComponent(
					message,
					session.extensionRunner.getMessageRenderer(message.customType),
					this.options.getMarkdownTheme(),
					this.options.getOutputPad(),
				);
				rendered.setExpanded(this.options.getToolsExpanded());
				container.addChild(rendered);
				return;
			}
			case "compactionSummary": {
				container.addChild(new Spacer(1));
				const rendered = new CompactionSummaryMessageComponent(message, this.options.getMarkdownTheme());
				rendered.setExpanded(this.options.getToolsExpanded());
				container.addChild(rendered);
				return;
			}
			case "branchSummary": {
				container.addChild(new Spacer(1));
				const rendered = new BranchSummaryMessageComponent(message, this.options.getMarkdownTheme());
				rendered.setExpanded(this.options.getToolsExpanded());
				container.addChild(rendered);
				return;
			}
			case "user": {
				const text = getUserMessageText(message);
				if (!text) return;
				if (container.children.length > 0) container.addChild(new Spacer(1));
				container.addChild(
					new UserSessionMessageComponent(
						text,
						this.options.getMarkdownTheme(),
						this.options.getOutputPad(),
						this.options.getMarkdownTransformers(),
						this.options.getToolsExpanded(),
					),
				);
				if (populateHistory) this.options.addHistory(text);
				return;
			}
			case "assistant":
				container.addChild(
					new AssistantMessageComponent(
						message,
						this.options.getHideThinkingBlock(),
						this.options.getMarkdownTheme(),
						this.options.getHiddenThinkingLabel(),
						this.options.getOutputPad(),
						this.options.getMarkdownTransformers(),
					),
				);
				return;
			case "toolResult":
				return;
		}
	}

	render(entries: SessionEntry[], options: { updateFooter?: boolean; populateHistory?: boolean } = {}): void {
		const session = this.options.getSession();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		this.options.pendingTools.clear();
		const cacheMisses = session.settingsManager.getShowCacheMissNotices()
			? collectCacheMisses(session.sessionManager.getEntries(), session.modelRuntime)
			: new Map<AssistantMessage, CacheMiss>();
		if (options.updateFooter) {
			this.options.updateFooter();
			this.options.updateEditorBorder();
		}
		const items = entries.flatMap((entry): RenderSessionItem[] =>
			entry.type === "custom" ? [entry] : sessionEntryToContextMessages(entry),
		);
		for (const item of items) {
			if (isCustomSessionEntry(item)) {
				this.appendCustomEntry(item);
				continue;
			}
			if (item.role === "assistant") {
				this.appendMessage(item);
				for (const content of item.content) {
					if (content.type !== "toolCall") continue;
					const rendered = new ToolExecutionComponent(
						content.name,
						content.id,
						content.arguments,
						{
							showImages: session.settingsManager.getShowImages(),
							imageWidthCells: session.settingsManager.getImageWidthCells(),
						},
						session.getToolDefinition(content.name),
						this.options.ui,
						session.sessionManager.getCwd(),
					);
					rendered.setExpanded(this.options.getToolsExpanded());
					this.options.container.addChild(rendered);
					if (item.stopReason === "aborted" || item.stopReason === "error") {
						const retryAttempt = this.options.getRetryAttempt();
						const error =
							item.stopReason === "aborted"
								? retryAttempt > 0
									? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
									: "Operation aborted"
								: item.errorMessage || "Error";
						rendered.updateResult({ content: [{ type: "text", text: error }], isError: true });
					} else {
						renderedPendingTools.set(content.id, rendered);
					}
				}
				if (item.stopReason !== "aborted" && item.stopReason !== "error") {
					const miss = cacheMisses.get(item);
					if (miss) this.appendCacheMiss(miss);
				}
			} else if (item.role === "toolResult") {
				const rendered = renderedPendingTools.get(item.toolCallId);
				if (rendered) {
					rendered.updateResult(item);
					renderedPendingTools.delete(item.toolCallId);
				}
			} else {
				this.appendMessage(item, options.populateHistory === true);
			}
		}
		for (const [toolCallId, rendered] of renderedPendingTools) {
			this.options.pendingTools.set(toolCallId, rendered);
		}
		this.options.ui.requestRender();
	}

	appendCacheMiss(miss: CacheMiss): void {
		if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return;
		const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
		let label = "Cache miss";
		if (miss.modelChanged) label = "Cache miss after model switch";
		else if (miss.idleMs >= CACHE_TTL_MS) label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
		this.options.container.addChild(new Spacer(1));
		this.options.container.addChild(
			new Text(theme.fg("warning", `${label}: ${formatTokens(miss.missedTokens)} tokens re-billed${cost}`), 1, 0),
		);
	}
}
