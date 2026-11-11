// Shared speed rules for driving and flying: unit conversions, the
// altitude-dependent speed cap, and the log-scale slider mapping both
// HUDs use. One module so the car and the free camera can never disagree
// about what the speed limit is.
//
// Adaptive cap: at ground level (or max zoom-in, like driving the car)
// the fastest you may go is 100 mph. The cap scales up logarithmically
// with height above ground, reaching 10,000 mph at 10,000 m AGL
// (airliner cruise altitude): 100 mph at <=10 m, ~464 mph at 100 m,
// ~2,154 mph at 1,000 m, 10,000 mph at >=10,000 m. A log scale keeps the
// steps feeling sensible — doubling your altitude is always worth the
// same extra speed, instead of the cap exploding near the ground or
// crawling at altitude.
export const MphToMps = 0.44704; // exact: 1 mph in m/s
export const MpsToMph = 2.23694;
export const MetersToFeet = 3.28084;

export const GroundSpeedCapMph = 100; // max speed at ground level, mph
export const HighAltitudeSpeedCapMph = 10000; // max speed at high altitude, mph
const LowAltitudeM = 10; // at or below this AGL, the ground cap applies
const HighAltitudeM = 10000; // at or above this AGL, the high cap applies

export function capMphForAltitudeAgl(aglMeters: number): number {
	if (!Number.isFinite(aglMeters) || aglMeters <= LowAltitudeM) {
		return GroundSpeedCapMph;
	}

	if (aglMeters >= HighAltitudeM) {
		return HighAltitudeSpeedCapMph;
	}

	// Log interpolation over the three decades between the anchors:
	// cap = 100 * 100^t, t = log10(agl / 10) / 3.
	const t = Math.log10(aglMeters / LowAltitudeM) / Math.log10(HighAltitudeM / LowAltitudeM);
	return Math.round(GroundSpeedCapMph * Math.pow(HighAltitudeSpeedCapMph / GroundSpeedCapMph, t));
}

// Log-scale slider mapping, parameterized by the slider's upper bound
// (the current altitude cap). A plain linear 0–limit slider makes low
// speeds fiddly (25 mph would be a sliver of the range); on this scale
// the slider quarters land near limit/1000, limit/100, limit/10 and the
// limit itself, so low speeds are easy to pick, and the exact value is
// always shown next to the slider. The number input gives exact entry.
export const SpeedSliderSteps = 1000;

export function mphToSlider(mph: number, limitMph: number): number {
	const limit = Math.max(limitMph, 1);
	const value = Math.max(mph, 0);
	return Math.round(Math.log10(value / limit * 9999 + 1) / 4 * SpeedSliderSteps);
}

export function sliderToMph(t: number, limitMph: number): number {
	const limit = Math.max(limitMph, 1);
	const value = Math.round((Math.pow(10, t / SpeedSliderSteps * 4) - 1) / 9999 * limit);
	return Math.max(value, 0);
}
