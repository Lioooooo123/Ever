#!/usr/bin/env node

/**
 * Validates lockstep versions for published packages, then synchronizes
 * internal dependency versions in all workspace packages, including private ones.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

const GENERATED_PACKAGE_SUFFIXES = [join("coding-agent", "install-lock")];

const packageRoot = process.argv[2] ?? "packages";
const workspacePackages = findPackageDirectories(packageRoot)
	.filter((directory) => !GENERATED_PACKAGE_SUFFIXES.some((suffix) => directory.endsWith(suffix)))
	.map((directory) => {
		const path = join(directory, "package.json");
		return { data: JSON.parse(readFileSync(path, "utf8")), path };
	});
const publishedPackages = workspacePackages.filter((pkg) => pkg.data.private !== true);
const lockstepPackages = publishedPackages.filter((pkg) => pkg.data.everVersionPolicy !== "independent");
const independentPackages = publishedPackages.filter((pkg) => pkg.data.everVersionPolicy === "independent");
const versionMap = new Map(workspacePackages.map((pkg) => [pkg.data.name, pkg.data.version]));

console.log("Current versions:");
for (const pkg of [...publishedPackages].sort((a, b) => a.data.name.localeCompare(b.data.name))) {
	const policy = pkg.data.everVersionPolicy === "independent" ? " (independent)" : "";
	console.log(`  ${pkg.data.name}: ${pkg.data.version}${policy}`);
}

const versions = new Set(lockstepPackages.map((pkg) => pkg.data.version));
if (versions.size > 1) {
	console.error("\nERROR: Published packages without an independent version policy are not in lockstep.");
	process.exit(1);
}

console.log("\nPublished library packages are lockstep versioned.");
if (independentPackages.length > 0) {
	console.log(`Independent packages: ${independentPackages.map((pkg) => pkg.data.name).join(", ")}.`);
}

let totalUpdates = 0;
const updatedPackages = new Set();
for (const pkg of workspacePackages) {
	for (const dependencyType of ["dependencies", "devDependencies"]) {
		const dependencies = pkg.data[dependencyType];
		if (!dependencies) {
			continue;
		}

		for (const [dependencyName, currentSpecifier] of Object.entries(dependencies)) {
			// Registry aliases such as `npm:@lioooooo123/ever-ai@0.1.2` are never workspace-linked,
			// so lockstep bumping them would point at a version that is not published yet.
			const version = versionMap.get(dependencyName);
			const newSpecifier = version ? `^${version}` : null;
			if (!newSpecifier || currentSpecifier === newSpecifier) {
				continue;
			}

			console.log(`\n${pkg.data.name}:`);
			console.log(
				`  ${dependencyName}: ${currentSpecifier} → ${newSpecifier}${dependencyType === "devDependencies" ? " (devDependencies)" : ""}`,
			);
			dependencies[dependencyName] = newSpecifier;
			updatedPackages.add(pkg);
			totalUpdates++;
		}
	}
}

for (const pkg of updatedPackages) {
	writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
}

if (totalUpdates === 0) {
	console.log("\nAll inter-package dependencies are already in sync.");
} else {
	console.log(`\nUpdated ${totalUpdates} dependency version(s).`);
}
