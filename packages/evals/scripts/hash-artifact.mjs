import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const target = process.argv[2];
if (target === undefined) throw new Error("Usage: node scripts/hash-artifact.mjs <file-or-directory>");
const absoluteTarget = resolve(target);
const targetStat = await stat(absoluteTarget);
const digest = createHash("sha256");

async function files(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const paths = [];
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) paths.push(...(await files(path)));
		else if (entry.isFile()) paths.push(path);
		else if (entry.isSymbolicLink()) throw new Error(`Artifact symlinks are not allowed: ${path}`);
	}
	return paths;
}

if (targetStat.isFile()) digest.update(await readFile(absoluteTarget));
else if (targetStat.isDirectory()) {
	const paths = await files(absoluteTarget);
	paths.sort((left, right) =>
		Buffer.compare(
			Buffer.from(relative(absoluteTarget, left).replaceAll("\\", "/")),
			Buffer.from(relative(absoluteTarget, right).replaceAll("\\", "/")),
		),
	);
	for (const path of paths) {
		digest.update(relative(absoluteTarget, path).replaceAll("\\", "/"));
		digest.update("\0");
		digest.update(await readFile(path));
	}
} else throw new Error("Artifact must be a regular file or directory");

process.stdout.write(`${digest.digest("hex")}\n`);
