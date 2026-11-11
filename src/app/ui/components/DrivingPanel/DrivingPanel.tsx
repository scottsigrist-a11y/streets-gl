import React, {useCallback, useContext} from "react";
import {useRecoilValue} from "recoil";
import styles from './DrivingPanel.scss';
import {ActionsContext, AtomsContext} from "~/app/ui/UI";
import {DrivingTouchInput} from "~/app/systems/DrivingSystem";

const CompassPoints = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const SpeedSliderMax = 1000;
const SpeedLimitMph = 10000;

// Log scale: a plain 0–10,000 slider makes city speeds fiddly (25 mph
// would be 0.25% of the range). On this scale the slider quarters land
// near 9 / 99 / 999 / 10,000 mph, so low speeds are easy to pick, and
// the exact value is always shown next to it.
const mphToSlider = (mph: number): number => Math.round(Math.log10(mph / SpeedLimitMph * 9999 + 1) / 4 * SpeedSliderMax);
const sliderToMph = (t: number): number => Math.round((Math.pow(10, t / SpeedSliderMax * 4) - 1) / 9999 * SpeedLimitMph);

const DrivingPanel: React.FC = () => {
	const atoms = useContext(AtomsContext);
	const actions = useContext(ActionsContext);
	const driving = useRecoilValue(atoms.driving);

	const active = driving?.active ?? false;

	const setButton = useCallback((button: keyof DrivingTouchInput, pressed: boolean): void => {
		actions.setDrivingTouchButton(button, pressed);
	}, [actions]);

	const onSpeedSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
		actions.setDrivingMaxSpeedMph(sliderToMph(Number(e.target.value)));
	}, [actions]);

	const onMaxSpeedInput = useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
		const value = parseInt(e.target.value, 10);

		if (!Number.isNaN(value)) {
			actions.setDrivingMaxSpeedMph(value);
		}
	}, [actions]);

	// Hold-to-drive buttons: press and hold to drive, release to let go.
	// preventDefault on mousedown keeps the button from taking keyboard
	// focus (so Space stays the brake instead of re-clicking the button).
	const bindButton = (button: keyof DrivingTouchInput): {
		onPointerDown: (e: React.PointerEvent) => void;
		onPointerUp: () => void;
		onPointerLeave: () => void;
		onPointerCancel: () => void;
		onMouseDown: (e: React.MouseEvent) => void;
		onContextMenu: (e: React.MouseEvent) => void;
	} => ({
		onPointerDown: (e: React.PointerEvent): void => {
			e.preventDefault();
			setButton(button, true);
		},
		onPointerUp: (): void => setButton(button, false),
		onPointerLeave: (): void => setButton(button, false),
		onPointerCancel: (): void => setButton(button, false),
		onMouseDown: (e: React.MouseEvent): void => e.preventDefault(),
		onContextMenu: (e: React.MouseEvent): void => e.preventDefault()
	});

	if (!active) {
		return (
			<div className={styles.driving}>
				<button
					className={styles.driving__driveButton}
					onClick={(): void => actions.setDrivingEnabled(true)}
				>
					▶ Drive
				</button>
			</div>
		);
	}

	const headingDeg = driving?.headingDeg ?? 0;
	const compass = CompassPoints[Math.round(headingDeg / 45) % 8];
	const maxSpeedMph = driving?.maxSpeedMph ?? 70;
	const altitudeFt = driving?.altitudeFt ?? 0;
	const dataLoadedPct = driving?.dataLoadedPct ?? null;

	return (
		<div className={styles.driving}>
			<div className={styles.driving__speedo}>
				<div className={styles.driving__speedo__mph}>{Math.round(driving?.speedMph ?? 0)}</div>
				<div className={styles.driving__speedo__unit}>MPH</div>
				<div className={styles.driving__speedo__sub}>
					{Math.round(driving?.speedKmh ?? 0)} km/h · {compass} {Math.round(headingDeg)}°
				</div>
				<div className={styles.driving__speedo__sub}>
					ALT {altitudeFt.toLocaleString()} ft
					{dataLoadedPct !== null && dataLoadedPct < 100 ? ` · DATA ${dataLoadedPct}%` : ''}
				</div>
			</div>
			<div className={styles.driving__speed}>
				<label className={styles.driving__speed__label} htmlFor="driving-max-speed">
					MAX SPEED
				</label>
				<input
					id="driving-max-speed"
					className={styles.driving__speed__slider}
					type="range"
					min={0}
					max={SpeedSliderMax}
					value={mphToSlider(maxSpeedMph)}
					onChange={onSpeedSliderChange}
					aria-label="Maximum speed in miles per hour"
				/>
				<input
					className={styles.driving__speed__value}
					type="number"
					min={0}
					max={SpeedLimitMph}
					value={maxSpeedMph}
					onChange={onMaxSpeedInput}
					aria-label="Maximum speed, exact miles per hour"
				/>
				<span className={styles.driving__speed__unit}>mph</span>
			</div>
			<div className={styles.driving__controls}>
				<button className={styles.driving__button} {...bindButton('left')}>◀<span>LEFT</span></button>
				<button className={styles.driving__button} {...bindButton('gas')}>▲<span>GAS</span></button>
				<button className={styles.driving__button} {...bindButton('brake')}>■<span>BRAKE</span></button>
				<button className={styles.driving__button} {...bindButton('reverse')}>▼<span>REV</span></button>
				<button className={styles.driving__button} {...bindButton('right')}>▶<span>RIGHT</span></button>
			</div>
			<div className={styles.driving__footer}>
				<button
					className={styles.driving__stopButton}
					onClick={(): void => actions.setDrivingEnabled(false)}
				>
					✕ Stop driving
				</button>
				<span className={styles.driving__hint}>W A S D / arrows to drive · Space to brake · Esc to stop</span>
			</div>
		</div>
	);
};

export default React.memo(DrivingPanel);
