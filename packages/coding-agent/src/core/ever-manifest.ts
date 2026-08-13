import { readFileSync } from "node:fs";

export interface EverManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the Ever package manifest. */
export function readEverManifest(packageJsonPath: string): EverManifest | null {
	try {
		const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		if (!isObject(pkg)) return null;
		const source = isObject(pkg.ever) ? pkg.ever : undefined;
		if (!source) return null;

		const manifest: EverManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = source[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
