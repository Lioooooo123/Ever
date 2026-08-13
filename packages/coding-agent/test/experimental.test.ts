import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalEverExperimental = process.env.EVER_EXPERIMENTAL;

	afterEach(() => {
		if (originalEverExperimental === undefined) {
			delete process.env.EVER_EXPERIMENTAL;
		} else {
			process.env.EVER_EXPERIMENTAL = originalEverExperimental;
		}
	});

	it("returns false when EVER_EXPERIMENTAL is unset", () => {
		delete process.env.EVER_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when EVER_EXPERIMENTAL is empty", () => {
		process.env.EVER_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when EVER_EXPERIMENTAL is set to 1", () => {
		process.env.EVER_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when EVER_EXPERIMENTAL is set to 0", () => {
		process.env.EVER_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when EVER_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.EVER_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
