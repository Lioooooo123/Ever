import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DaemonServiceDefinition {
	platform: "darwin" | "linux";
	path: string;
	label: string;
	content: string;
}

export type ServiceCommandRunner = (command: string, args: string[], tolerateFailure?: boolean) => Promise<void>;
export type ServiceStatusRunner = (command: string, args: string[]) => Promise<boolean>;

function xml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function createDaemonServiceDefinition(options: {
	platform: NodeJS.Platform;
	homeDirectory: string;
	agentDirectory: string;
	agentDirectoryEnvironmentName: string;
	nodePath: string;
	cliEntry: string;
}): DaemonServiceDefinition {
	const label = "com.ever.agent";
	if (options.platform === "darwin") {
		return {
			platform: "darwin",
			label,
			path: join(options.homeDirectory, "Library/LaunchAgents", `${label}.plist`),
			content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(options.nodePath)}</string><string>${xml(options.cliEntry)}</string><string>daemon</string><string>serve</string></array>
<key>WorkingDirectory</key><string>${xml(options.agentDirectory)}</string>
<key>EnvironmentVariables</key><dict><key>${xml(options.agentDirectoryEnvironmentName)}</key><string>${xml(options.agentDirectory)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string>
</dict></plist>
`,
		};
	}
	if (options.platform !== "linux") throw new Error(`Daemon service is unsupported on ${options.platform}`);
	return {
		platform: "linux",
		label,
		path: join(options.homeDirectory, ".config/systemd/user/ever.service"),
		content: `[Unit]
Description=Ever durable task daemon
After=default.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(options.agentDirectory)}
Environment=${systemdQuote(`${options.agentDirectoryEnvironmentName}=${options.agentDirectory}`)}
ExecStart=${systemdQuote(options.nodePath)} ${systemdQuote(options.cliEntry)} daemon serve
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`,
	};
}

export const runServiceCommand: ServiceCommandRunner = (command, args, tolerateFailure = false) =>
	new Promise((resolve, reject) => {
		execFile(command, args, (error) => {
			if (!error || tolerateFailure) resolve();
			else reject(error);
		});
	});

export const runServiceStatus: ServiceStatusRunner = (command, args) =>
	new Promise((resolve) => {
		execFile(command, args, (error) => resolve(!error));
	});

export async function isDaemonServiceLoaded(
	definition: DaemonServiceDefinition,
	runner: ServiceStatusRunner = runServiceStatus,
	uid = process.getuid?.(),
): Promise<boolean> {
	if (definition.platform === "darwin") {
		if (uid === undefined) throw new Error("Cannot determine uid for launchd user domain");
		return runner("launchctl", ["print", `gui/${uid}/${definition.label}`]);
	}
	return runner("systemctl", ["--user", "is-active", "--quiet", "ever.service"]);
}

export async function installDaemonService(
	definition: DaemonServiceDefinition,
	runner: ServiceCommandRunner = runServiceCommand,
	uid = process.getuid?.(),
): Promise<void> {
	mkdirSync(dirname(definition.path), { recursive: true, mode: 0o700 });
	writeFileSync(definition.path, definition.content, { mode: 0o600 });
	if (definition.platform === "darwin") {
		if (uid === undefined) throw new Error("Cannot determine uid for launchd user domain");
		const serviceTarget = `gui/${uid}/${definition.label}`;
		await runner("launchctl", ["bootout", serviceTarget], true);
		await runner("launchctl", ["bootstrap", `gui/${uid}`, definition.path]);
		await runner("launchctl", ["enable", serviceTarget]);
		await runner("launchctl", ["kickstart", "-k", serviceTarget]);
		return;
	}
	await runner("systemctl", ["--user", "daemon-reload"]);
	await runner("systemctl", ["--user", "enable", "--now", "ever.service"]);
}

export async function uninstallDaemonService(
	definition: DaemonServiceDefinition,
	runner: ServiceCommandRunner = runServiceCommand,
	uid = process.getuid?.(),
): Promise<void> {
	if (definition.platform === "darwin") {
		if (uid === undefined) throw new Error("Cannot determine uid for launchd user domain");
		await runner("launchctl", ["bootout", `gui/${uid}/${definition.label}`], true);
		rmSync(definition.path, { force: true });
		return;
	}
	await runner("systemctl", ["--user", "disable", "--now", "ever.service"], true);
	rmSync(definition.path, { force: true });
	await runner("systemctl", ["--user", "daemon-reload"]);
}
