import { chmod, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export interface RedactionReport {
	schemaVersion: 1;
	redactedFiles: string[];
	omittedBinaryFiles: string[];
}

function redactText(text: string, secrets: readonly string[]): { text: string; changed: boolean } {
	let redacted = text;
	for (const secret of secrets) {
		if (secret !== "") redacted = redacted.replaceAll(secret, "[REDACTED]");
	}
	redacted = redacted
		.replaceAll(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
		.replaceAll(/((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*)[^\s,"']+/gi, "$1[REDACTED]");
	return { text: redacted, changed: redacted !== text };
}

export async function exportRedactedJob(
	source: string,
	destination: string,
	secrets: readonly string[],
): Promise<RedactionReport> {
	const sourceRoot = resolve(source);
	const destinationRoot = resolve(destination);
	if (destinationRoot === sourceRoot || destinationRoot.startsWith(sourceRoot + sep)) {
		throw new Error("Redacted export destination must be outside the source job directory");
	}
	const report: RedactionReport = { schemaVersion: 1, redactedFiles: [], omittedBinaryFiles: [] };

	async function visit(sourceDirectory: string, destinationDirectory: string): Promise<void> {
		await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
		await chmod(destinationDirectory, 0o700);
		const children = await readdir(sourceDirectory, { withFileTypes: true });
		children.sort((left, right) => left.name.localeCompare(right.name));
		for (const child of children) {
			const sourcePath = join(sourceDirectory, child.name);
			const destinationPath = join(destinationDirectory, child.name);
			const stat = await lstat(sourcePath);
			if (stat.isSymbolicLink()) throw new Error(`Eval artifact may not be a symlink: ${sourcePath}`);
			if (stat.isDirectory()) {
				await visit(sourcePath, destinationPath);
				continue;
			}
			if (!stat.isFile()) throw new Error(`Unsupported Eval artifact: ${sourcePath}`);
			const contents = await readFile(sourcePath);
			const artifactPath = relative(sourceRoot, sourcePath);
			if (contents.includes(0)) {
				report.omittedBinaryFiles.push(artifactPath);
				continue;
			}
			const redaction = redactText(contents.toString("utf8"), secrets);
			if (redaction.changed) report.redactedFiles.push(artifactPath);
			await writeFile(destinationPath, redaction.text, { mode: 0o600, flag: "wx" });
		}
	}

	await visit(sourceRoot, destinationRoot);
	await writeFile(join(destinationRoot, "redaction-report.json"), `${JSON.stringify(report, null, 2)}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	return report;
}
