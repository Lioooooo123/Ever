#!/usr/bin/env tsx

/**
 * Simple Agent
 *
 * A small, embeddable coding agent built with the Ever SDK.
 *
 * Usage:
 *   cd packages/coding-agent
 *   npx tsx examples/sdk/14-simple-agent.ts "Inspect this repo and suggest one improvement"
 *   npx tsx examples/sdk/14-simple-agent.ts --read-only --cwd ../../ "Summarize the repository"
 */

import { createAgentSession, defineTool, SessionManager } from "@lioooooo123/ever";
import { Type } from "typebox";

interface CliOptions {
	cwd: string;
	prompt: string;
	readOnly: boolean;
}

const parseArgs = (args: string[]): CliOptions => {
	let cwd = process.cwd();
	let readOnly = false;
	const promptParts: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--cwd") {
			const value = args[index + 1];
			if (!value) {
				throw new Error("--cwd requires a path");
			}
			cwd = value;
			index += 1;
		} else if (arg === "--read-only") {
			readOnly = true;
		} else {
			promptParts.push(arg);
		}
	}

	return {
		cwd,
		prompt: promptParts.join(" ").trim(),
		readOnly,
	};
};

const scratchpad: string[] = [];

const rememberNoteTool = defineTool({
	name: "remember_note",
	label: "Remember Note",
	description: "Store a short note in this agent run's in-memory scratchpad.",
	parameters: Type.Object({
		note: Type.String({ description: "Short note to remember for the current run" }),
	}),
	execute: async (_toolCallId, params) => {
		scratchpad.push(params.note);
		return {
			content: [{ type: "text", text: `Remembered note ${scratchpad.length}: ${params.note}` }],
			details: { count: scratchpad.length },
		};
	},
});

const options = parseArgs(process.argv.slice(2));

if (!options.prompt) {
	console.error("Usage: npx tsx examples/sdk/14-simple-agent.ts [--read-only] [--cwd path] <prompt>");
	process.exitCode = 1;
} else {
	const tools = options.readOnly
		? ["read", "grep", "find", "ls", "remember_note"]
		: ["read", "bash", "edit", "write", "grep", "find", "ls", "remember_note"];

	const { session } = await createAgentSession({
		cwd: options.cwd,
		customTools: [rememberNoteTool],
		sessionManager: SessionManager.inMemory(options.cwd),
		tools,
	});

	try {
		session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta);
			}
			if (event.type === "tool_execution_start") {
				console.error(`\n[tool] ${event.toolName}`);
			}
		});

		await session.prompt(
			`You are a concise autonomous coding agent. Work in ${options.cwd}.\n\nUser request: ${options.prompt}`,
		);
		if (scratchpad.length > 0) {
			console.error("\nScratchpad:");
			for (const [index, note] of scratchpad.entries()) {
				console.error(`${index + 1}. ${note}`);
			}
		}
		console.log();
	} finally {
		session.dispose();
	}
}
