export function getEverUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `ever/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
