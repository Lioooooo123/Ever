import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

function getWorkspacePackages(root) {
	return findPackageDirectories(root)
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}));
}

export function getLockstepWorkspacePackages(root = "packages") {
	return getWorkspacePackages(root)
		.filter((pkg) => pkg.private !== true)
		.map(({ directory, name, version }) => ({ directory, name, version }));
}

export function getReleasePackages(root = "packages") {
	return getWorkspacePackages(root)
		.filter((pkg) => pkg.everRelease === true)
		.map(({ directory, name, version }) => ({ directory, name, version }));
}
