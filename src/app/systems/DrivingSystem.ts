import System from "../System";
import MathUtils from "~/lib/math/MathUtils";
import ControlsSystem, {NavigationMode} from "~/app/systems/ControlsSystem";
import TerrainSystem from "~/app/systems/TerrainSystem";
import TileSystem from "~/app/systems/TileSystem";
import VehicleSystem from "~/app/systems/VehicleSystem";
import UISystem from "~/app/systems/UISystem";
import Car from "~/app/vehicles/car/Car";

// Touch-button input from the driving HUD. Kept separate from the keyboard
// flags so several buttons can be held at once (e.g. GAS + LEFT).
export interface DrivingTouchInput {
	gas: boolean;
	reverse: boolean;
	brake: boolean;
	left: boolean;
	right: boolean;
}

// Arcade driving model, mirroring the MapLibre 3D Driving Map:
// W/Up gas, S/Down brake then reverse, A/D steer, Space hard brake.
const MaxReverseSpeed = 8; // m/s
const Acceleration = 9; // m/s^2
const BrakeDeceleration = 18; // m/s^2
const HardBrakeDeceleration = 25; // m/s^2 (Space)
const DragCoefficient = 0.4; // 1/s
const RollingResistance = 0.6; // m/s^2
const SteeringRate = 1.9; // rad/s at full steering authority
// Drone-style chase camera: ~9 m behind the car, ~3.5 m above it
// (9.7 m straight-line at 21° pitch), so a real-size car sits in one
// lane instead of reading as a toy on a tabletop.
const FollowDistance = 9.7; // chase camera distance, meters
const FollowPitchDeg = 21; // chase camera pitch, degrees
const FollowTargetHeightOffset = 0.7; // look at the car's mid-height, meters
const DefaultMaxSpeedMph = 70; // slider default, mph
const MaxSpeedMphLimit = 10000; // slider maximum, mph
const MphToMps = 0.44704; // exact: 1 mph in m/s
const MpsToMph = 2.23694;
const MetersToFeet = 3.28084;
const HudUpdateInterval = 0.1; // seconds between speedometer updates

export default class DrivingSystem extends System {
	public readonly car: Car = new Car();
	private driving: boolean = false;
	private touchInput: DrivingTouchInput = {
		gas: false,
		reverse: false,
		brake: false,
		left: false,
		right: false
	};
	private gasKeyPressed: boolean = false;
	private reverseKeyPressed: boolean = false;
	private brakeKeyPressed: boolean = false;
	private leftKeyPressed: boolean = false;
	private rightKeyPressed: boolean = false;
	private smoothedYaw: number = 0;
	private hudTimer: number = 0;
	// Maximum speed from the HUD slider (mph) and its m/s equivalent,
	// which is what the physics clamps against.
	private maxSpeedMph: number = DefaultMaxSpeedMph;
	private maxForwardSpeedMps: number = DefaultMaxSpeedMph * MphToMps;
	// Last terrain height that resolved successfully, anywhere. Used as a
	// spawn fallback while the height tile for a new area is still loading.
	private lastKnownHeight: number | null = null;
	// True once the car has a trustworthy height (fresh query, a previous
	// height, or the ground camera's target height). Until then the chase
	// camera stays off: aiming it at an unresolved height of 0 would put
	// it underground and blank the screen.
	private spawnHeightResolved: boolean = false;

	public postInit(): void {
		// Hand the car to the vehicle pipeline so the render passes pick it
		// up (GBuffer + shadows) alongside the aircraft parts.
		this.systemManager.getSystem(VehicleSystem).car = this.car;

		window.addEventListener('keydown', (e: KeyboardEvent): void => this.keyDownEvent(e));
		window.addEventListener('keyup', (e: KeyboardEvent): void => this.keyUpEvent(e));
	}

	public get isDriving(): boolean {
		return this.driving;
	}

	// Enter or exit driving mode. On entry the car drops where the camera is
	// looking, facing the way the camera looks; on exit it hides again and
	// the normal ground camera takes over.
	public setDrivingEnabled(enabled: boolean): void {
		if (enabled === this.driving) {
			return;
		}

		const controls = this.systemManager.getSystem(ControlsSystem);

		if (enabled) {
			const {lat, lon} = this.getSpawnLatLon(controls);
			this.car.heading = controls.northDirection;

			// Switch to the ground camera first, then drop the car and aim
			// the camera at it (placeCarAt syncs the ground navigator).
			controls.setDrivingMode(true);
			this.spawnHeightResolved = false;
			this.placeCarAt(lat, lon);
			this.smoothedYaw = this.car.heading;

			this.car.visible = true;
			this.driving = true;
			this.publishHud(1);
		} else {
			this.driving = false;
			this.car.visible = false;
			this.car.speed = 0;
			this.clearInputFlags();
			controls.setDrivingMode(false);
			controls.clearDrivingCamera();

			this.systemManager.getSystem(UISystem).setDrivingState({
				active: false,
				speedMph: 0,
				speedKmh: 0,
				headingDeg: 0,
				maxSpeedMph: this.maxSpeedMph,
				altitudeFt: 0,
				dataLoadedPct: null
			});
		}
	}

	// The HUD speed slider: the car's maximum speed in mph (0–10,000).
	// Gas accelerates toward it; the physics clamp uses the m/s value.
	public setMaxSpeedMph(mph: number): void {
		this.maxSpeedMph = MathUtils.clamp(Math.round(mph), 0, MaxSpeedMphLimit);
		this.maxForwardSpeedMps = this.maxSpeedMph * MphToMps;
		this.publishHud(1);
	}

	// Best terrain height for a spawn point, with fallbacks for when the
	// height tile has not loaded yet (the query returns null then).
	// Returns null only when no height is known anywhere; the caller must
	// not aim the camera at 0 in that case.
	private resolveSpawnHeight(x: number, z: number, controls: ControlsSystem): number | null {
		const height = this.systemManager.getSystem(TerrainSystem)
			.terrainHeightProvider.getHeightGlobalInterpolated(x, z, true);

		if (height !== null && Number.isFinite(height)) {
			this.lastKnownHeight = height;
			this.spawnHeightResolved = true;
			return height;
		}

		// A height from anywhere nearby beats 0: the per-frame physics
		// query corrects the car as soon as the tile for this spot loads.
		if (this.lastKnownHeight !== null) {
			this.spawnHeightResolved = true;
			return this.lastKnownHeight;
		}

		// In ground mode the camera target height is maintained by the
		// heightmap, so it is exact for the area on screen.
		if (controls.mode === NavigationMode.Ground) {
			const targetHeight = controls.getGroundControlsTarget().y;

			if (Number.isFinite(targetHeight)) {
				this.spawnHeightResolved = true;
				return targetHeight;
			}
		}

		return null;
	}

	// Move the car to a latitude/longitude (used when the user searches for
	// an address while driving). The chase camera is re-aimed at the new
	// spot so the jump is immediate instead of a long swing.
	public placeCarAt(lat: number, lon: number): void {
		const position = MathUtils.degrees2meters(lat, lon);
		this.car.x = position.x;
		this.car.z = position.y;

		const height = this.resolveSpawnHeight(this.car.x, this.car.z, this.systemManager.getSystem(ControlsSystem));

		if (height !== null) {
			this.car.height = height + 0.05;
		}

		this.smoothedYaw = this.car.heading;

		this.systemManager.getSystem(ControlsSystem).setState(
			lat,
			lon,
			FollowPitchDeg,
			MathUtils.toDeg(this.car.heading),
			FollowDistance
		);

		// Aim the chase camera now, not on the next frame: the navigator
		// update runs before this system's update each frame, and without
		// this the first frame would still use the stale target height.
		this.updateFollowCamera(0);
	}

	public setTouchButton(button: keyof DrivingTouchInput, pressed: boolean): void {
		this.touchInput[button] = pressed;
	}

	public update(deltaTime: number): void {
		if (!this.driving) {
			return;
		}

		const dt = Math.min(deltaTime, 0.1);

		this.updatePhysics(dt);
		this.updateFollowCamera(dt);
		this.publishHud(dt);
	}

	private getSpawnLatLon(controls: ControlsSystem): {lat: number; lon: number} {
		// The ground target is only meaningful in ground mode; in slippy
		// or free view the camera position is the spawn point.
		if (controls.mode === NavigationMode.Ground) {
			const target = controls.getGroundControlsTarget();
			return MathUtils.meters2degrees(target.x, target.z);
		}

		return controls.getLatLon();
	}

	private get isInFocus(): boolean {
		return !(
			document.activeElement instanceof HTMLInputElement
			|| document.activeElement instanceof HTMLTextAreaElement
			|| document.activeElement.attributes.getNamedItem('contenteditable') !== null
		);
	}

	private keyDownEvent(e: KeyboardEvent): void {
		if (!this.driving || !this.isInFocus || e.ctrlKey || e.metaKey || e.altKey) {
			return;
		}

		switch (e.code) {
			case 'KeyW':
			case 'ArrowUp':
				this.gasKeyPressed = true;
				e.preventDefault();
				break;
			case 'KeyS':
			case 'ArrowDown':
				this.reverseKeyPressed = true;
				e.preventDefault();
				break;
			case 'KeyA':
			case 'ArrowLeft':
				this.leftKeyPressed = true;
				e.preventDefault();
				break;
			case 'KeyD':
			case 'ArrowRight':
				this.rightKeyPressed = true;
				e.preventDefault();
				break;
			case 'Space':
				this.brakeKeyPressed = true;
				e.preventDefault();
				break;
			case 'Escape':
				this.setDrivingEnabled(false);
				break;
		}
	}

	private keyUpEvent(e: KeyboardEvent): void {
		switch (e.code) {
			case 'KeyW':
			case 'ArrowUp':
				this.gasKeyPressed = false;
				break;
			case 'KeyS':
			case 'ArrowDown':
				this.reverseKeyPressed = false;
				break;
			case 'KeyA':
			case 'ArrowLeft':
				this.leftKeyPressed = false;
				break;
			case 'KeyD':
			case 'ArrowRight':
				this.rightKeyPressed = false;
				break;
			case 'Space':
				this.brakeKeyPressed = false;
				break;
		}
	}

	private clearInputFlags(): void {
		this.gasKeyPressed = false;
		this.reverseKeyPressed = false;
		this.brakeKeyPressed = false;
		this.leftKeyPressed = false;
		this.rightKeyPressed = false;
		this.touchInput = {
			gas: false,
			reverse: false,
			brake: false,
			left: false,
			right: false
		};
	}

	private updatePhysics(deltaTime: number): void {
		const gas = this.gasKeyPressed || this.touchInput.gas;
		const reverse = this.reverseKeyPressed || this.touchInput.reverse;
		const brake = this.brakeKeyPressed || this.touchInput.brake;
		const left = this.leftKeyPressed || this.touchInput.left;
		const right = this.rightKeyPressed || this.touchInput.right;

		let speed = this.car.speed;

		if (gas) {
			speed += Acceleration * deltaTime;
		}

		if (reverse) {
			// S brakes while moving forward, then reverses once stopped.
			if (speed > 0.5) {
				speed -= BrakeDeceleration * deltaTime;
			} else {
				speed -= Acceleration * 0.7 * deltaTime;
			}
		}

		if (brake) {
			const deceleration = this.brakeKeyPressed ? HardBrakeDeceleration : BrakeDeceleration;
			speed -= Math.sign(speed) * deceleration * deltaTime;

			if (Math.sign(speed) !== Math.sign(this.car.speed)) {
				speed = 0;
			}
		}

		// Drag + rolling resistance, then clamp.
		speed -= speed * DragCoefficient * deltaTime;

		if (!gas && !reverse) {
			speed -= Math.sign(speed) * RollingResistance * deltaTime;

			if (Math.sign(speed) !== Math.sign(this.car.speed)) {
				speed = 0;
			}
		}

		speed = MathUtils.clamp(speed, -MaxReverseSpeed, this.maxForwardSpeedMps);

		if (Math.abs(speed) < 0.05 && !gas && !reverse) {
			speed = 0;
		}

		this.car.speed = speed;

		// Steering authority grows with speed and flips when reversing.
		const steer = (right ? 1 : 0) - (left ? 1 : 0);
		const speedFactor = MathUtils.clamp(speed / 8, -1, 1);
		this.car.heading += steer * SteeringRate * speedFactor * deltaTime;
		this.car.heading = MathUtils.normalizeAngle(this.car.heading);

		// Move along the heading: x is northing, z is easting.
		this.car.x += Math.cos(this.car.heading) * speed * deltaTime;
		this.car.z += Math.sin(this.car.heading) * speed * deltaTime;

		// Stick to the terrain; keep the last height if it is not loaded yet.
		const height = this.systemManager.getSystem(TerrainSystem)
			.terrainHeightProvider.getHeightGlobalInterpolated(this.car.x, this.car.z, true);

		if (height !== null && Number.isFinite(height)) {
			this.car.height = height + 0.05;
			this.lastKnownHeight = height;
			this.spawnHeightResolved = true;
		}
	}

	private updateFollowCamera(deltaTime: number): void {
		// Until the car has a trustworthy height, leave the camera where
		// it is: aiming the chase camera at an unresolved height of 0
		// would put it underground and blank the screen. The physics
		// query above resolves the height as soon as its tile loads.
		if (!this.spawnHeightResolved) {
			return;
		}

		// Ease the chase yaw behind the car instead of snapping to it.
		const alpha = 1 - Math.pow(1 - 0.25, deltaTime / (1 / 60));
		this.smoothedYaw = MathUtils.lerpAngle(this.smoothedYaw, this.car.heading, alpha);

		this.systemManager.getSystem(ControlsSystem).setDrivingCamera(
			this.car.x,
			this.car.z,
			this.smoothedYaw,
			MathUtils.toRad(FollowPitchDeg),
			FollowDistance,
			this.car.height + FollowTargetHeightOffset
		);
	}

	private publishHud(deltaTime: number): void {
		this.hudTimer += deltaTime;

		if (this.hudTimer < HudUpdateInterval) {
			return;
		}

		this.hudTimer = 0;

		this.systemManager.getSystem(UISystem).setDrivingState({
			active: true,
			speedMph: Math.abs(this.car.speed) * MpsToMph,
			speedKmh: Math.abs(this.car.speed) * 3.6,
			headingDeg: MathUtils.toDeg(this.car.heading),
			maxSpeedMph: this.maxSpeedMph,
			altitudeFt: Math.round(this.car.height * MetersToFeet),
			dataLoadedPct: this.computeDataLoadedPct()
		});
	}

	// Percentage of the queued map data for the current view that has
	// loaded: vector tiles in the camera frustum (queued + in flight +
	// loaded) plus terrain tiles in the area loaders' viewports. Null
	// when nothing is queued, so the HUD can hide the indicator.
	private computeDataLoadedPct(): number | null {
		const tileSystem = this.systemManager.getSystem(TileSystem);
		const terrainSystem = this.systemManager.getSystem(TerrainSystem);

		const vector = tileSystem ? tileSystem.getLoadProgress() : {loaded: 0, total: 0};
		const terrain = terrainSystem ? terrainSystem.getLoadProgress() : {loaded: 0, total: 0};

		const total = vector.total + terrain.total;

		if (total === 0) {
			return null;
		}

		return Math.round((vector.loaded + terrain.loaded) / total * 100);
	}
}
