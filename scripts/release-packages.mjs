import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

export function getWorkspacePackages(root = "packages") {
	return findPackageDirectories(root)
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.map(({ directory, name, version, private: isPrivate, everRelease, everVersionPolicy }) => ({
			directory,
			name,
			version,
			private: isPrivate,
			everRelease,
			everVersionPolicy,
		}));
}

export function getLockstepWorkspacePackages(root = "packages") {
	return getWorkspacePackages(root)
		.filter((pkg) => pkg.private !== true && pkg.everVersionPolicy !== "independent")
		.map(({ directory, name, version }) => ({ directory, name, version }));
}

export function getReleasePackages(root = "packages") {
	return getWorkspacePackages(root)
		.filter((pkg) => pkg.everRelease === true)
		.map(({ directory, name, version }) => ({ directory, name, version }));
}
