import System from "../System";
import MathUtils from "~/lib/math/MathUtils";
import ControlsSystem, {NavigationMode} from "~/app/systems/ControlsSystem";
import TerrainSystem from "~/app/systems/TerrainSystem";
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
const MaxForwardSpeed = 30; // m/s (~67 mph)
const MaxReverseSpeed = 8; // m/s
const Acceleration = 9; // m/s^2
const BrakeDeceleration = 18; // m/s^2
const HardBrakeDeceleration = 25; // m/s^2 (Space)
const DragCoefficient = 0.4; // 1/s
const RollingResistance = 0.6; // m/s^2
const SteeringRate = 1.9; // rad/s at full steering authority
const FollowDistance = 30; // chase camera distance, meters
const FollowPitchDeg = 35; // chase camera pitch, degrees
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
			this.clearInputFlags();
			controls.setDrivingMode(false);

			this.systemManager.getSystem(UISystem).setDrivingState({
				active: false,
				speedMph: 0,
				speedKmh: 0,
				headingDeg: 0
			});
		}
	}

	// Move the car to a latitude/longitude (used when the user searches for
	// an address while driving). The chase camera is re-aimed at the new
	// spot so the jump is immediate instead of a long swing.
	public placeCarAt(lat: number, lon: number): void {
		const position = MathUtils.degrees2meters(lat, lon);
		this.car.x = position.x;
		this.car.z = position.y;

		const height = this.systemManager.getSystem(TerrainSystem)
			.terrainHeightProvider.getHeightGlobalInterpolated(this.car.x, this.car.z, true);

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

		speed = MathUtils.clamp(speed, -MaxReverseSpeed, MaxForwardSpeed);

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

		if (height !== null) {
			this.car.height = height + 0.05;
		}
	}

	private updateFollowCamera(deltaTime: number): void {
		// Ease the chase yaw behind the car instead of snapping to it.
		const alpha = 1 - Math.pow(1 - 0.25, deltaTime / (1 / 60));
		this.smoothedYaw = MathUtils.lerpAngle(this.smoothedYaw, this.car.heading, alpha);

		this.systemManager.getSystem(ControlsSystem).setDrivingCamera(
			this.car.x,
			this.car.z,
			this.smoothedYaw,
			MathUtils.toRad(FollowPitchDeg),
			FollowDistance
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
			speedMph: Math.abs(this.car.speed) * 2.23694,
			speedKmh: Math.abs(this.car.speed) * 3.6,
			headingDeg: MathUtils.toDeg(this.car.heading)
		});
	}
}
