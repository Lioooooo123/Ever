export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.EVER_EXPERIMENTAL === "1";
}
