import React, {useCallback, useContext} from "react";
import {useRecoilValue} from "recoil";
import styles from './DrivingPanel.scss';
import {ActionsContext, AtomsContext} from "~/app/ui/UI";
import {DrivingTouchInput} from "~/app/systems/DrivingSystem";

const CompassPoints = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const DrivingPanel: React.FC = () => {
	const atoms = useContext(AtomsContext);
	const actions = useContext(ActionsContext);
	const driving = useRecoilValue(atoms.driving);

	const active = driving?.active ?? false;

	const setButton = useCallback((button: keyof DrivingTouchInput, pressed: boolean): void => {
		actions.setDrivingTouchButton(button, pressed);
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

	return (
		<div className={styles.driving}>
			<div className={styles.driving__speedo}>
				<div className={styles.driving__speedo__mph}>{Math.round(driving?.speedMph ?? 0)}</div>
				<div className={styles.driving__speedo__unit}>MPH</div>
				<div className={styles.driving__speedo__sub}>
					{Math.round(driving?.speedKmh ?? 0)} km/h · {compass} {Math.round(headingDeg)}°
				</div>
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
