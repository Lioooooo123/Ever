#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const packageJson = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
const bundledDependencies = packageJson.bundledDependencies ?? packageJson.bundleDependencies ?? [];
const workspaceLocations = new Map([
	["@lioooooo123/ever-long-tasks", join(repoRoot, "packages/long-tasks")],
	["@lioooooo123/ever-agent-core", join(repoRoot, "packages/agent")],
	["@lioooooo123/ever-ai", join(repoRoot, "packages/ai")],
	["@lioooooo123/ever-client", join(repoRoot, "packages/client")],
	["@lioooooo123/ever-protocol", join(repoRoot, "packages/protocol")],
	["@lioooooo123/ever-telemetry", join(repoRoot, "packages/telemetry")],
	["@lioooooo123/ever-tui", join(repoRoot, "packages/tui")],
]);
const cleanOnly = process.argv.slice(2).includes("--clean");
const codingAgentRuntimeDependencies = {
	...packageJson.dependencies,
	...packageJson.optionalDependencies,
};

for (const [packageName, sourceDir] of workspaceLocations) {
	const workspacePackageJson = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8"));
	const workspaceRuntimeDependencies = {
		...workspacePackageJson.dependencies,
		...workspacePackageJson.optionalDependencies,
	};
	for (const [dependencyName, dependencyVersion] of Object.entries(workspaceRuntimeDependencies)) {
		if (workspaceLocations.has(dependencyName)) continue;
		if (codingAgentRuntimeDependencies[dependencyName] !== dependencyVersion) {
			throw new Error(
				`${packageName} requires ${dependencyName}@${dependencyVersion}; mirror it in the Ever package runtime dependencies`,
			);
		}
	}
}

for (const packageName of bundledDependencies) {
	const sourceDir = workspaceLocations.get(packageName);
	if (!sourceDir) {
		throw new Error(`No workspace staging rule for bundled dependency ${packageName}`);
	}

	const targetDir = join(codingAgentDir, "node_modules", ...packageName.split("/"));
	rmSync(targetDir, { recursive: true, force: true });
	if (cleanOnly) continue;
	mkdirSync(targetDir, { recursive: true, mode: 0o755 });
	cpSync(join(sourceDir, "package.json"), join(targetDir, "package.json"));
	cpSync(join(sourceDir, "dist"), join(targetDir, "dist"), { recursive: true });
}

console.log(
	cleanOnly
		? `Cleaned ${bundledDependencies.length} coding-agent bundled workspace package(s).`
		: `Staged ${bundledDependencies.length} coding-agent bundled workspace package(s).`,
);
