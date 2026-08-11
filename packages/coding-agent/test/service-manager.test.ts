import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDaemonServiceDefinition,
	installDaemonService,
	isDaemonServiceLoaded,
	type ServiceCommandRunner,
	uninstallDaemonService,
} from "../src/daemon/service-manager.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("daemon service manager", () => {
	it.each(["darwin", "linux"] as const)("installs, loads, unloads, and removes %s services", async (platform) => {
		const homeDirectory = mkdtempSync(join(tmpdir(), "karissa-service-"));
		directories.push(homeDirectory);
		const definition = createDaemonServiceDefinition({
			platform,
			homeDirectory,
			agentDirectory: "/tmp/karissa agent",
			agentDirectoryEnvironmentName: "KARISSA_CODING_AGENT_DIR",
			nodePath: "/usr/local/bin/node",
			cliEntry: "/tmp/karissa cli.js",
		});
		const commands: string[] = [];
		const runner: ServiceCommandRunner = async (command, args, tolerateFailure) => {
			commands.push(JSON.stringify({ command, args, tolerateFailure: tolerateFailure ?? false }));
		};
		await installDaemonService(definition, runner, 501);
		expect(readFileSync(definition.path, "utf8")).toContain("daemon");
		expect(commands.some((command) => command.includes(platform === "darwin" ? "bootstrap" : "enable"))).toBe(true);
		expect(await isDaemonServiceLoaded(definition, async () => true, 501)).toBe(true);
		await uninstallDaemonService(definition, runner, 501);
		expect(existsSync(definition.path)).toBe(false);
		expect(commands.some((command) => command.includes(platform === "darwin" ? "bootout" : "disable"))).toBe(true);
	});
});
