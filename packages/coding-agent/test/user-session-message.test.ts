import { beforeAll, describe, expect, it } from "vitest";
import { UserSessionMessageComponent } from "../src/modes/interactive/components/user-session-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("UserSessionMessageComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("forwards transcript expansion changes to a nested Skill invocation", () => {
		const component = new UserSessionMessageComponent(
			'<skill name="review" location="/tmp/review.md">\nFULL_SKILL_CONTENT\n</skill>',
			getMarkdownTheme(),
		);
		expect(stripAnsi(component.render(100).join("\n"))).not.toContain("FULL_SKILL_CONTENT");
		component.setExpanded(true);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("FULL_SKILL_CONTENT");
	});
});
