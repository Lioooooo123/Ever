import type { Message } from "@lioooooo123/ever-ai/compat";
import { Container, type MarkdownTheme, Spacer } from "@lioooooo123/ever-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { parseSkillBlock } from "../../../core/skill-block.ts";
import { getMarkdownTheme } from "../theme/theme.ts";
import { SkillInvocationMessageComponent } from "./skill-invocation-message.ts";
import { UserMessageComponent } from "./user-message.ts";

/** Extract text content from a user message. */
export function getUserMessageText(message: Message): string {
	if (message.role !== "user") return "";
	const textBlocks =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.filter((content: { type: string }) => content.type === "text");
	return textBlocks.map((content) => (content as { text: string }).text).join("");
}

/** Renders a user message, including the collapsed skill invocation block when present. */
export class UserSessionMessageComponent extends Container {
	private readonly text: string;
	private readonly markdownTheme: MarkdownTheme;
	private outputPad: number;
	private readonly markdownTransformers: readonly MarkdownTransformer[];
	private expanded: boolean;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		expanded = false,
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.expanded = expanded;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const skillBlock = parseSkillBlock(this.text);
		if (!skillBlock) {
			this.addChild(
				new UserMessageComponent(this.text, this.markdownTheme, this.outputPad, this.markdownTransformers),
			);
			return;
		}

		const skillComponent = new SkillInvocationMessageComponent(skillBlock, this.markdownTheme);
		skillComponent.setExpanded(this.expanded);
		this.addChild(skillComponent);

		if (skillBlock.userMessage) {
			this.addChild(new Spacer(1));
			this.addChild(
				new UserMessageComponent(
					skillBlock.userMessage,
					this.markdownTheme,
					this.outputPad,
					this.markdownTransformers,
				),
			);
		}
	}
}
