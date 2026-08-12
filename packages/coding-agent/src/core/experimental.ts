export function areExperimentalFeaturesEnabled(): boolean {
	return (process.env.EVER_EXPERIMENTAL ?? process.env.PI_EXPERIMENTAL) === "1";
}
