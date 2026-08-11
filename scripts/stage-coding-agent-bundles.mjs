#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const packageJson = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
const bundledDependencies = packageJson.bundledDependencies ?? packageJson.bundleDependencies ?? [];
const workspaceLocations = new Map([["@karissa/long-tasks", join(repoRoot, "packages/long-tasks")]]);
const cleanOnly = process.argv.slice(2).includes("--clean");

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
