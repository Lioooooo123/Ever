import { describe, expect, it } from "vitest";
import { sanitizeUnattendedShellEnvironment } from "../src/core/tools/bash.ts";

describe("unattended shell environment", () => {
	it("removes ambient credentials from model-controlled subprocesses", () => {
		const input: NodeJS.ProcessEnv = {
			PATH: "/usr/bin",
			OPENAI_API_KEY: "provider-secret",
			ANTHROPIC_OAUTH_TOKEN: "oauth-secret",
			AWS_ACCESS_KEY_ID: "access-key",
			AWS_SECRET_ACCESS_KEY: "secret-key",
			GITHUB_TOKEN: "github-secret",
			SSH_AUTH_SOCK: "/tmp/agent.sock",
			GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google.json",
			KARISSA_TASK_ID: "task-1",
		};

		expect(sanitizeUnattendedShellEnvironment(input, true)).toEqual({
			PATH: "/usr/bin",
			KARISSA_TASK_ID: "task-1",
		});
		expect(input.OPENAI_API_KEY).toBe("provider-secret");
	});

	it("preserves the normal interactive Session environment", () => {
		const input = { PATH: "/usr/bin", OPENAI_API_KEY: "provider-secret" };
		expect(sanitizeUnattendedShellEnvironment(input, false)).toEqual(input);
	});
});
