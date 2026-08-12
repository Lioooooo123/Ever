import { describe, expect, it } from "vitest";
import { getEverUserAgent } from "../src/utils/ever-user-agent.ts";

describe("getEverUserAgent", () => {
	it("formats the Ever runtime user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getEverUserAgent("1.2.3");

		expect(userAgent).toBe(`ever/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^ever\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
