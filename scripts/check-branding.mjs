#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_TOKEN = ["p", "i"].join("");
const PRODUCT_TITLE = `${PRODUCT_TOKEN[0].toUpperCase()}${PRODUCT_TOKEN[1]}`;
const TEXT_EXTENSIONS = new Set([
	".c",
	".css",
	".html",
	".js",
	".json",
	".jsonl",
	".md",
	".mjs",
	".sh",
	".ts",
	".tsx",
	".yaml",
	".yml",
]);
const IGNORED_DIRECTORIES = new Set([".git", "dist", "node_modules"]);
const IGNORED_PATHS = new Set([
	"LICENSE",
	"packages/coding-agent/src/core/export-html/vendor/highlight.min.js",
	"packages/tui/src/latex.ts",
	"packages/tui/test/latex.test.ts",
]);
const FORBIDDEN_PATTERNS = [
	new RegExp(`\\.${PRODUCT_TOKEN}(?:/|\\b)`, "u"),
	new RegExp(`(?:^|_)${PRODUCT_TOKEN}(?:_|$)`, "u"),
	new RegExp(`(?<![A-Z])${PRODUCT_TOKEN.toUpperCase()}_[A-Z][A-Z_]*`, "u"),
	new RegExp(`${PRODUCT_TOKEN}Config`, "u"),
	new RegExp(`@mariozechner/${PRODUCT_TOKEN}-[a-z-]+`, "u"),
	new RegExp(`(?:badlogic|earendil-works)/${PRODUCT_TOKEN}(?:-mono)?`, "u"),
	new RegExp(`\\b${PRODUCT_TITLE}\\b`, "u"),
	new RegExp(`\\b${PRODUCT_TOKEN}\\b`, "u"),
	new RegExp(`${PRODUCT_TITLE}[A-Z]`, "u"),
	new RegExp(`[a-z]${PRODUCT_TITLE}[A-Z]`, "u"),
];

function* walk(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
		const absolutePath = join(directory, entry.name);
		if (entry.isDirectory()) yield* walk(absolutePath);
		else if (entry.isFile()) yield absolutePath;
	}
}

function currentChangelogSection(content) {
	const releasedVersion = content.indexOf("\n## [", content.indexOf("## [") + 1);
	return releasedVersion === -1 ? content : content.slice(0, releasedVersion);
}

const violations = [];
for (const absolutePath of walk(REPOSITORY_ROOT)) {
	const path = relative(REPOSITORY_ROOT, absolutePath);
	if (IGNORED_PATHS.has(path) || !TEXT_EXTENSIONS.has(extname(path))) continue;
	let content = readFileSync(absolutePath, "utf8");
	if (path.endsWith("CHANGELOG.md")) content = currentChangelogSection(content);
	if (path.endsWith("package-lock.json") || path.endsWith("npm-shrinkwrap.json")) {
		content = content
			.split("\n")
			.filter((line) => !line.includes('"integrity"'))
			.join("\n");
	}
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const brandableLine = lines[index].replaceAll("\\pi", "").replaceAll("\\Pi", "");
		if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(brandableLine))) {
			violations.push(`${path}:${index + 1}:${lines[index].trim()}`);
		}
	}
}

if (violations.length > 0) {
	console.error("Legacy branding remains:\n" + violations.join("\n"));
	process.exit(1);
}

console.log("Branding check passed.");
