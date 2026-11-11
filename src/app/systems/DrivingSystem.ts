import System from "../System";
import MathUtils from "~/lib/math/MathUtils";
import ControlsSystem, {NavigationMode} from "~/app/systems/ControlsSystem";
import TerrainSystem from "~/app/systems/TerrainSystem";
import TileSystem from "~/app/systems/TileSystem";
import VehicleSystem from "~/app/systems/VehicleSystem";
import UISystem from "~/app/systems/UISystem";
import SceneSystem from "~/app/systems/SceneSystem";
import Car from "~/app/vehicles/car/Car";
import {
	capMphForAltitudeAgl,
	MetersToFeet,
	MphToMps,
	MpsToMph
} from "~/app/utils/AdaptiveSpeed";

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
const GroundClearanceM = 0.05; // car sits this far above the terrain surface
const DropSpawnHeightM = 1.5; // spawn this far (~5 ft) above the ground, then drop onto it
const DropFallSpeedMin = 2; // m/s, slowest the car falls while dropping in
const DropFallSpeedMax = 600; // m/s, fastest the car falls while dropping in
const DropJumpDownDistance = 250; // m above the landing spot the drop starts from
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
	// Drop-in state (see placeCarAt): while the car is dropping, it
	// hovers above the ground and cannot drive yet. dropTargetHeight is
	// the validated terrain height it is falling toward, or null while
	// the height tile for the spot has not loaded. landed is true once
	// the car rests on the land.
	private landed: boolean = false;
	private dropTargetHeight: number | null = null;

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
			this.placeCarAt(lat, lon);
			this.smoothedYaw = this.car.heading;

			this.car.visible = true;
			this.driving = true;
			this.publishHud(1);
		} else {
			this.driving = false;
			this.car.visible = false;
			this.car.speed = 0;
			this.landed = false;
			this.dropTargetHeight = null;
			this.clearInputFlags();
			controls.setDrivingMode(false);
			controls.clearDrivingCamera();

			this.systemManager.getSystem(UISystem).setDrivingState({
				active: false,
				speedMph: 0,
				speedKmh: 0,
				headingDeg: 0,
				maxSpeedMph: this.maxSpeedMph,
				maxSpeedCapMph: this.getAdaptiveCapMph(),
				altitudeFt: 0,
				dataLoadedPct: null
			});
		}
	}

	// The adaptive speed cap at the car's current height above ground.
	// The car sits on the land, so this is the 100 mph ground cap; it is
	// computed from the live altitude anyway so the HUD never disagrees
	// with the shared cap rule.
	private getAdaptiveCapMph(): number {
		const groundHeight = this.systemManager.getSystem(TerrainSystem)
			.terrainHeightProvider.getHeightGlobalInterpolated(this.car.x, this.car.z, true);

		const agl = groundHeight !== null && Number.isFinite(groundHeight)
			? Math.max(this.car.height - groundHeight, 0)
			: 0;

		return capMphForAltitudeAgl(agl);
	}

	// The HUD speed slider: the car's maximum speed in mph. At ground
	// level the adaptive cap is 100 mph, so the drive slider tops out
	// there; the 10,000 mph top is for high altitude in flight mode.
	// Gas accelerates toward it; the physics clamp uses the m/s value.
	public setMaxSpeedMph(mph: number): void {
		this.maxSpeedMph = MathUtils.clamp(Math.round(mph), 0, this.getAdaptiveCapMph());
		this.maxForwardSpeedMps = this.maxSpeedMph * MphToMps;
		this.publishHud(1);
	}

	// Move the car to a latitude/longitude (used when driving starts and
	// when the user searches for an address while driving). The ground
	// altitude at the spot is read through the terrain height system
	// (zoom 12, the same data the rendered mesh uses — the near height
	// layer never leaves zoom 12, so the height is always there once
	// its tile loads and the mesh and the car can never disagree about
	// where the ground is). The car then spawns a few feet above that
	// altitude and drops vertically onto the surface (see updateDrop),
	// so it rests on the land instead of starting under it. If the
	// height tile has not loaded yet, the car holds high above the
	// ground — at the camera's height, which is above the terrain by
	// construction in every navigation mode — and drops onto the surface
	// the moment a valid height resolves. It is never placed at height
	// 0 or at a stale estimate from somewhere else, so it can never end
	// up under the terrain. The chase camera is re-aimed at the new
	// spot so the jump is immediate instead of a long swing.
	public placeCarAt(lat: number, lon: number): void {
		const position = MathUtils.degrees2meters(lat, lon);
		this.car.x = position.x;
		this.car.z = position.y;

		const height = this.queryGroundHeight(this.car.x, this.car.z);

		if (height !== null) {
			// A few feet above the ground, then drop onto it: the car
			// lands on the surface it was measured against.
			this.car.height = height + DropSpawnHeightM;
			this.landed = false;
			this.dropTargetHeight = height + GroundClearanceM;
		} else {
			// Hold above the ground and wait: the camera sits above the
			// terrain in every mode, so its height is a safe hold.
			const camera = this.systemManager.getSystem(SceneSystem).objects.camera;
			this.car.height = camera.position.y + 20;
			this.landed = false;
			this.dropTargetHeight = null;
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

	// Terrain height at a spot, or null when the height tile has not
	// loaded yet (or the value is not a real height). Null means "not
	// known", never "sea level": callers must hold above the ground
	// instead of trusting it.
	private queryGroundHeight(x: number, z: number): number | null {
		const height = this.systemManager.getSystem(TerrainSystem)
			.terrainHeightProvider.getHeightGlobalInterpolated(x, z, true);

		if (height !== null && Number.isFinite(height)) {
			return height;
		}

		return null;
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
		// Until the car has landed on the terrain it cannot drive: it is
		// either holding above the ground waiting for a valid height, or
		// falling toward the landing spot. See updateDrop.
		if (!this.landed) {
			this.updateDrop(deltaTime);
			return;
		}

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

		// Drag + rolling resistance, then clamp to the effective maximum:
		// the HUD slider value, further limited by the adaptive altitude
		// cap (100 mph on the ground). A car descending from a drop-in
		// can never stay faster than the cap for its altitude.
		speed -= speed * DragCoefficient * deltaTime;

		if (!gas && !reverse) {
			speed -= Math.sign(speed) * RollingResistance * deltaTime;

			if (Math.sign(speed) !== Math.sign(this.car.speed)) {
				speed = 0;
			}
		}

		const effectiveMaxMps = Math.min(this.maxForwardSpeedMps, this.getAdaptiveCapMph() * MphToMps);
		speed = MathUtils.clamp(speed, -MaxReverseSpeed, effectiveMaxMps);

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

		// Stick to the terrain; keep the current height if the tile for
		// this spot has not loaded yet, so the car never drops to 0.
		const height = this.queryGroundHeight(this.car.x, this.car.z);

		if (height !== null) {
			this.car.height = height + GroundClearanceM;
		}
	}

	// Drop the car vertically onto the terrain surface. While the height
	// tile for the spot has not loaded, the car holds where it is (high
	// above the ground) and waits. Once a valid height resolves, the car
	// falls straight down until it rests on the land — a few feet when
	// it spawned just above the surface, further when it held high
	// waiting for the tile. It is never lowered toward an unvalidated
	// height, so it can never end up under the terrain — and the chase
	// camera, which follows the car's height, can never end up
	// underground either. The fall eases off as the ground approaches
	// so the car settles onto the land instead of slamming into it.
	private updateDrop(deltaTime: number): void {
		const height = this.queryGroundHeight(this.car.x, this.car.z);

		if (height === null) {
			return;
		}

		const target = height + GroundClearanceM;
		this.dropTargetHeight = target;

		// A very long fall is shortened: jump to 250 m above the landing
		// spot, then fall the rest visibly instead of dropping for many
		// seconds from a high camera.
		if (this.car.height - target > DropJumpDownDistance) {
			this.car.height = target + DropJumpDownDistance;
		}

		const remaining = this.car.height - target;

		if (remaining <= 0.01) {
			this.car.height = target;
			this.landed = true;
			this.dropTargetHeight = null;
			return;
		}

		// Fall fast, easing off as the ground approaches so the car
		// settles onto the land instead of slamming into it.
		const fallSpeed = MathUtils.clamp(remaining * 3, DropFallSpeedMin, DropFallSpeedMax);
		this.car.height = Math.max(target, this.car.height - fallSpeed * deltaTime);

		if (this.car.height <= target) {
			this.car.height = target;
			this.landed = true;
			this.dropTargetHeight = null;
		}
	}

	private updateFollowCamera(deltaTime: number): void {
		// The camera always aims at the car's current height: the car is
		// either resting on a validated terrain height or holding high
		// above the ground while its height tile loads, so the look point
		// is never underground and the camera can never end up under the
		// terrain. No gate is needed (and a gate on a stale height was
		// what used to blank the screen).
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
			maxSpeedCapMph: this.getAdaptiveCapMph(),
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
