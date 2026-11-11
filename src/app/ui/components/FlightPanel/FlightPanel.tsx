import React, {useCallback, useContext} from "react";
import {useRecoilValue} from "recoil";
import styles from './FlightPanel.scss';
import {ActionsContext, AtomsContext} from "~/app/ui/UI";
import {
	mphToSlider,
	sliderToMph,
	SpeedSliderSteps
} from "~/app/utils/AdaptiveSpeed";

const CompassPoints = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Free-fly HUD, in the same style as the driving HUD: current speed,
// heading, height above ground in feet, and the speed slider whose
// upper bound is the live altitude cap (100 mph at ground level,
// scaling to 10,000 mph at high altitude). Inactive states render
// nothing: the ✈ Fly button lives with the ▶ Drive button in the
// driving panel's idle state, and this panel takes over the same spot
// on screen while flying.
const FlightPanel: React.FC = () => {
	const atoms = useContext(AtomsContext);
	const actions = useContext(ActionsContext);
	const flight = useRecoilValue(atoms.flight);

	const active = flight?.active ?? false;

	// The speed slider's upper bound is the live altitude cap, so the
	// slider can never ask for more than the camera may fly at its
	// altitude. The cap rises as you climb and falls as you descend.
	const maxSpeedCapMph = flight?.maxSpeedCapMph ?? 100;

	const onSpeedSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
		actions.setFlightMaxSpeedMph(sliderToMph(Number(e.target.value), maxSpeedCapMph));
	}, [actions, maxSpeedCapMph]);

	const onMaxSpeedInput = useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
		const value = parseInt(e.target.value, 10);

		if (!Number.isNaN(value)) {
			actions.setFlightMaxSpeedMph(value);
		}
	}, [actions]);

	if (!active) {
		return null;
	}

	const headingDeg = flight?.headingDeg ?? 0;
	const compass = CompassPoints[Math.round(headingDeg / 45) % 8];
	const maxSpeedMph = flight?.maxSpeedMph ?? 100;
	const altitudeFt = flight?.altitudeFt ?? 0;
	const dataLoadedPct = flight?.dataLoadedPct ?? null;

	return (
		<div className={styles.flight}>
			<div className={styles.flight__speedo}>
				<div className={styles.flight__speedo__mph}>{Math.round(flight?.speedMph ?? 0)}</div>
				<div className={styles.flight__speedo__unit}>MPH</div>
				<div className={styles.flight__speedo__sub}>
					{compass} {Math.round(headingDeg)}°
				</div>
				<div className={styles.flight__speedo__sub}>
					ALT {altitudeFt.toLocaleString()} ft AGL
					{dataLoadedPct !== null && dataLoadedPct < 100 ? ` · DATA ${dataLoadedPct}%` : ''}
				</div>
			</div>
			<div className={styles.flight__speed}>
				<label className={styles.flight__speed__label} htmlFor="flight-max-speed">
					MAX SPEED
				</label>
				<input
					id="flight-max-speed"
					className={styles.flight__speed__slider}
					type="range"
					min={0}
					max={SpeedSliderSteps}
					value={mphToSlider(maxSpeedMph, maxSpeedCapMph)}
					onChange={onSpeedSliderChange}
					aria-label="Maximum flight speed in miles per hour"
				/>
				<input
					className={styles.flight__speed__value}
					type="number"
					min={0}
					max={maxSpeedCapMph}
					value={maxSpeedMph}
					onChange={onMaxSpeedInput}
					aria-label="Maximum flight speed, exact miles per hour"
				/>
				<span className={styles.flight__speed__unit}>mph</span>
				<span className={styles.flight__speed__cap}>CAP {maxSpeedCapMph.toLocaleString()} mph</span>
			</div>
			<div className={styles.flight__footer}>
				<button
					className={styles.flight__stopButton}
					onClick={(): void => actions.setFlightMode(false)}
				>
					✕ Stop flying
				</button>
				<span className={styles.flight__hint}>Tab to return to ground · W A S D to fly · Shift = full speed · Q E turn · R F pitch</span>
			</div>
		</div>
	);
};

export default React.memo(FlightPanel);
