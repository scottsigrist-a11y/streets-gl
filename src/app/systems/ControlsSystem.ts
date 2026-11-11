import Vec3 from "~/lib/math/Vec3";
import MathUtils from "~/lib/math/MathUtils";
import URLControlsStateHandler from "../controls/URLControlsStateHandler";
import Config from "../Config";
import System from "../System";
import SceneSystem from './SceneSystem';
import Easing from "~/lib/math/Easing";
import GroundControlsNavigator from "../controls/GroundControlsNavigator";
import ControlsNavigator from "../controls/ControlsNavigator";
import FreeControlsNavigator from "../controls/FreeControlsNavigator";
import CursorStyleSystem from "./CursorStyleSystem";
import PerspectiveCamera from "~/lib/core/PerspectiveCamera";
import TerrainSystem from "~/app/systems/TerrainSystem";
import TileSystem from "~/app/systems/TileSystem";
import SlippyControlsNavigator from "~/app/controls/SlippyControlsNavigator";
import UISystem from "~/app/systems/UISystem";
import {
	capMphForAltitudeAgl,
	MetersToFeet,
	MphToMps,
	MpsToMph
} from "~/app/utils/AdaptiveSpeed";

const WheelZoomFactor = 6;
const FlightHudUpdateInterval = 0.1; // seconds between flight HUD updates
const DefaultFlightMaxSpeedMph = 100; // flight slider default, mph
// Flight-mode max-speed keys (+/= and -): a multiplicative step suits
// the 100–10,000 mph range, with a small additive floor so the keys
// can climb out of 0 mph.
const FlightMaxSpeedKeyStep = 1.25;
const FlightMaxSpeedKeyFloorMph = 5;

export interface ControlsState {
	x: number;
	z: number;
	pitch: number;
	yaw: number;
	distance: number;
}

export enum NavigationMode {
	Ground,
	Free,
	Slippy
}

export default class ControlsSystem extends System {
	private readonly element: HTMLElement;
	public mode: NavigationMode = NavigationMode.Ground;
	// True while the car is being driven: the ground camera is a chase
	// camera then, and navigator switching (Tab) is suspended.
	public drivingMode: boolean = false;
	private camera: PerspectiveCamera;
	private tick: number = 0;
	public target: Vec3 = new Vec3();
	private state: ControlsState;
	private urlHandler: URLControlsStateHandler = new URLControlsStateHandler();
	private wheelZoomScale: number = 0;
	private wheelZoomScaleTarget: number = 0;

	private groundNavigator: GroundControlsNavigator;
	private freeNavigator: FreeControlsNavigator;
	private slippyNavigator: SlippyControlsNavigator;
	private activeNavigator: ControlsNavigator = null;
	// Flight speed (free-fly mode): the HUD slider value in mph. The
	// effective speed is the slider value capped by the altitude cap
	// (see getFlightSpeedCapMph); the stored value is clamped to the cap
	// every frame, so descending clamps the speed at once and the slider
	// never shows a value above its live upper bound.
	private flightMaxSpeedMph: number = DefaultFlightMaxSpeedMph;
	// Last camera height above ground that resolved (m). Falls back to
	// this when the terrain height tile under the camera has not loaded
	// yet, so the cap does not jump to the ground value on a null query.
	private lastKnownAgl: number | null = null;
	private flightHudTimer: number = 0;
	// Whether the last published flight HUD state was active. Used to
	// publish active:false once when leaving flight mode, so the flight
	// panel does not stay stuck on screen.
	private lastFlightHudActive: boolean = false;

	public constructor() {
		super();

		this.element = <HTMLCanvasElement>document.getElementById('canvas');

		this.element.addEventListener('contextmenu', (e: MouseEvent) => e.preventDefault());
		this.element.addEventListener('mousedown', (e: MouseEvent) => this.mouseDownEvent(e));
		this.element.addEventListener('mouseup', (e: MouseEvent) => this.mouseUpEvent(e));
		window.addEventListener('keydown', (e: KeyboardEvent) => this.keyDownEvent(e));
	}

	public postInit(): void {

	}

	public lookAtNorth(): void {
		if (this.activeNavigator) {
			this.activeNavigator.lookAtNorth();
		}
	}

	// Driving mode: hand camera input to DrivingSystem (the ground
	// navigator stops listening to WASD/mouse) and let DrivingSystem
	// position the ground camera as a chase camera following the car.
	// Driving always uses the ground camera, so if the user was in free
	// or slippy mode we switch to it first (without the slippy transition:
	// DrivingSystem aims the camera at the car right after this).
	public setDrivingMode(enabled: boolean): void {
		this.drivingMode = enabled;

		if (enabled) {
			if (this.activeNavigator !== this.groundNavigator) {
				this.slippyNavigator.disable();
				this.freeNavigator.disable();
				this.groundNavigator.enable();
				this.activeNavigator = this.groundNavigator;
				this.mode = NavigationMode.Ground;
			}

			this.groundNavigator.resetKeys();
			this.groundNavigator.disable();
		} else {
			this.groundNavigator.enable();
		}
	}

	// Called every frame while driving: point the ground camera at the car.
	// targetHeight is the car's look height; the ground navigator needs it
	// because the heightmap query returns null until its tile loads.
	public setDrivingCamera(x: number, z: number, yaw: number, pitch: number, distance: number, targetHeight: number): void {
		this.groundNavigator.setFollowCamera(x, z, yaw, pitch, distance, targetHeight);
	}

	// Driving ended: hand the target height back to the heightmap and
	// restore the normal near plane.
	public clearDrivingCamera(): void {
		this.groundNavigator.clearFollowCamera();
	}

	// Camera height above the ground (m). Null terrain heights (tile not
	// loaded yet) fall back to the last resolved value, and to 0 when
	// nothing has resolved — the conservative ground cap.
	public getCameraAgl(): number {
		const terrainHeight = this.systemManager.getSystem(TerrainSystem)
			.terrainHeightProvider.getHeightGlobalInterpolated(this.camera.position.x, this.camera.position.z, true);

		if (terrainHeight !== null && Number.isFinite(terrainHeight)) {
			this.lastKnownAgl = Math.max(this.camera.position.y - terrainHeight, 0);
		}

		return this.lastKnownAgl ?? 0;
	}

	// The adaptive speed cap at the camera's current altitude: 100 mph
	// at ground level, scaling logarithmically to 10,000 mph at
	// 10,000 m above ground (see AdaptiveSpeed).
	public getFlightSpeedCapMph(): number {
		return capMphForAltitudeAgl(this.getCameraAgl());
	}

	// The flight HUD speed slider: the free camera's maximum speed in
	// mph, clamped to the current altitude cap.
	public setFlightMaxSpeedMph(mph: number): void {
		this.flightMaxSpeedMph = MathUtils.clamp(Math.round(mph), 0, this.getFlightSpeedCapMph());
		this.publishFlightHud();
	}

	// Speed (m/s) the free camera flies at: the slider value, or the
	// full altitude cap while Shift is held. Both follow the cap live.
	public getFlightSpeedMps(fast: boolean): number {
		const capMph = this.getFlightSpeedCapMph();

		if (fast) {
			return capMph * MphToMps;
		}

		return Math.min(this.flightMaxSpeedMph, capMph) * MphToMps;
	}

	// Enter or exit free-fly mode from any mode (the FlightPanel's Fly
	// button). Tab only toggles Ground <-> Free; this also works from the
	// top-down slippy view.
	public setFreeModeEnabled(enabled: boolean): void {
		if (this.drivingMode) {
			return;
		}

		if (enabled && this.mode !== NavigationMode.Free) {
			const prevNavigator = this.activeNavigator;
			this.groundNavigator.disable();
			this.slippyNavigator.disable();
			this.freeNavigator.enable();
			this.freeNavigator.syncWithCamera(prevNavigator);
			this.activeNavigator = this.freeNavigator;
			this.mode = NavigationMode.Free;
		} else if (!enabled && this.mode === NavigationMode.Free) {
			this.freeNavigator.disable();
			this.groundNavigator.enable();
			this.groundNavigator.syncWithCamera(this.freeNavigator);
			this.activeNavigator = this.groundNavigator;
			this.mode = NavigationMode.Ground;
		}
	}

	private initCameraAndNavigators(): void {
		this.camera = this.systemManager.getSystem(SceneSystem).objects.camera;

		const cursorStyleSystem = this.systemManager.getSystem(CursorStyleSystem);
		const terrainHeightProvider = this.systemManager.getSystem(TerrainSystem).terrainHeightProvider;

		this.groundNavigator = new GroundControlsNavigator(this.element, this.camera, cursorStyleSystem, terrainHeightProvider);
		this.freeNavigator = new FreeControlsNavigator(
			this.element,
			this.camera,
			terrainHeightProvider,
			(fast: boolean): number => this.getFlightSpeedMps(fast)
		);
		this.slippyNavigator = new SlippyControlsNavigator(this.element, this.camera, cursorStyleSystem, terrainHeightProvider);

		this.activeNavigator = this.slippyNavigator;
		this.slippyNavigator.enable();
		this.slippyNavigator.syncWithCamera(null);
		this.mode = NavigationMode.Slippy;

		this.initStateFromHash();
	}

	private initStateFromHash(): void {
		const [newState] = this.urlHandler.getStateFromHash();

		if (newState) {
			this.state = newState;
			this.updatePositionFromState(this.state);
		} else {
			const {lat, lon, pitch, yaw, distance} = Config.StartPosition;
			const startPosition = MathUtils.degrees2meters(lat, lon);

			this.state = {
				x: startPosition.x,
				z: startPosition.y,
				pitch: MathUtils.toRad(pitch),
				yaw: MathUtils.toRad(yaw),
				distance: distance
			}

			this.updatePositionFromState(this.state);
		}
	}

	public getLatLon(): {lat: number; lon: number} {
		return MathUtils.meters2degrees(this.camera.position.x, this.camera.position.z);
	}

	public setLatLon(lat: number, lon: number): void {
		const position = MathUtils.degrees2meters(lat, lon);

		this.state.x = position.x;
		this.state.z = position.y;
		this.state.distance = 1500;
		this.state.pitch = MathUtils.toRad(45);
		this.state.yaw = MathUtils.toRad(0);

		this.updatePositionFromState(this.state);
	}

	public setState(lat: number, lon: number, pitch: number, yaw: number, distance: number): void {
		const position = MathUtils.degrees2meters(lat, lon);

		this.state.x = position.x;
		this.state.z = position.y;
		this.state.pitch = MathUtils.toRad(pitch);
		this.state.yaw = MathUtils.toRad(yaw);
		this.state.distance = distance;

		this.updatePositionFromState(this.state);
	}

	private updateStateFromPosition(): void {
		if (this.activeNavigator) {
			this.state = this.activeNavigator.getCurrentState();
		}
	}

	private updatePositionFromState(state: ControlsState): void {
		if (state.distance < Config.MaxCameraDistance && this.slippyNavigator.isEnabled) {
			this.slippyNavigator.disable();
			this.groundNavigator.enable();

			this.activeNavigator = this.groundNavigator;
			this.mode = NavigationMode.Ground;
		}

		if (state.distance > Config.MaxCameraDistance && this.groundNavigator.isEnabled) {
			this.groundNavigator.disable();
			this.slippyNavigator.enable();

			this.activeNavigator = this.slippyNavigator;
			this.mode = NavigationMode.Slippy;
		}

		if (this.activeNavigator) {
			this.activeNavigator.syncWithState(state);
		}
	}

	// Raise or lower the flight maximum speed by a multiplicative
	// factor, with a small additive floor so it can climb out of 0.
	// setFlightMaxSpeedMph clamps the result to the live altitude cap,
	// so the adaptive cap still applies, and republishes the HUD.
	private adjustFlightMaxSpeedMph(factor: number): void {
		const current = this.flightMaxSpeedMph;
		const next = factor > 1
			? Math.max(Math.round(current * factor), current + FlightMaxSpeedKeyFloorMph)
			: Math.min(Math.round(current * factor), current - FlightMaxSpeedKeyFloorMph);

		this.setFlightMaxSpeedMph(next);
	}

	private get isInFocus(): boolean {
		return !(
			document.activeElement instanceof HTMLInputElement
			|| document.activeElement instanceof HTMLTextAreaElement
			|| document.activeElement.attributes.getNamedItem('contenteditable') !== null
		);
	}

	private keyDownEvent(e: KeyboardEvent): void {
		if (this.drivingMode) {
			return;
		}

		if (e.code === 'Tab') {
			e.preventDefault();

			if (this.mode === NavigationMode.Free) {
				this.mode = NavigationMode.Ground;
				this.activeNavigator = this.groundNavigator;
				this.freeNavigator.disable();
				this.groundNavigator.enable();
				this.groundNavigator.syncWithCamera(this.freeNavigator);
			} else if (this.mode === NavigationMode.Ground) {
				this.mode = NavigationMode.Free;
				this.activeNavigator = this.freeNavigator;
				this.groundNavigator.disable();
				this.freeNavigator.enable();
				this.freeNavigator.syncWithCamera(this.groundNavigator);
			}
		}

		// Flight-mode max-speed keys: +/= raises, - lowers the flight
		// maximum speed (the slider stays, and the adaptive altitude cap
		// still applies). Holding the key repeats it. Gated on free-fly
		// mode and on not typing in an input, so the keys never fire
		// while driving or while editing the exact-value box.
		// Equal/Minus are free: flight uses W A S D, Q E, R F, Shift.
		if (this.mode === NavigationMode.Free && this.isInFocus) {
			if (e.code === 'Equal' || e.code === 'NumpadAdd') {
				this.adjustFlightMaxSpeedMph(FlightMaxSpeedKeyStep);
				e.preventDefault();
			} else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
				this.adjustFlightMaxSpeedMph(1 / FlightMaxSpeedKeyStep);
				e.preventDefault();
			}
		}
	}

	private mouseDownEvent(e: MouseEvent): void {
		e.preventDefault();

		if (e.button === 1 && !this.slippyNavigator.isEnabled) {
			this.wheelZoomScaleTarget = 1;
		}
	}

	private mouseUpEvent(e: MouseEvent): void {
		if (e.button === 1) {
			this.wheelZoomScaleTarget = 0;
		}
	}

	private updateHash(): void {
		const [newState, changedByUser] = this.urlHandler.getStateFromHash();

		if (newState && changedByUser) {
			this.updatePositionFromState(newState);
			this.state = newState;
		} else {
			this.updateStateFromPosition();
		}

		if (this.tick % 30 === 0) {
			this.urlHandler.setHashFromState(this.state);
		}
	}

	public getCurrentStateHash(): string {
		return this.urlHandler.serializeControlsState(this.state);
	}

	public get isSlippyMapVisible(): boolean {
		return this.slippyNavigator.isEnabled || this.groundNavigator.slippyMapOverlayFactor > 0;
	}

	public get isTilesVisible(): boolean {
		return this.groundNavigator.isEnabled || this.freeNavigator.isEnabled;
	}

	public get slippyMapAndTilesFactor(): number {
		if (this.slippyNavigator.isEnabled) {
			return 1;
		}

		return this.groundNavigator.slippyMapOverlayFactor;
	}

	public get northDirection(): number {
		// While driving the ground navigator is disabled (DrivingSystem
		// owns its input), but it is still the active camera controller:
		// its yaw is the camera heading. Returning 0 here froze the
		// compass in drive mode.
		if (this.drivingMode) {
			return this.groundNavigator.yaw;
		}

		if (this.groundNavigator && this.groundNavigator.isEnabled) {
			return this.groundNavigator.yaw;
		}

		// In free-fly mode the free navigator is the camera controller:
		// returning 0 here would freeze the compass while flying.
		if (this.freeNavigator && this.freeNavigator.isEnabled) {
			return this.freeNavigator.getCurrentState().yaw;
		}

		return 0;
	}

	public getGroundControlsTarget(): Vec3 {
		return this.groundNavigator.target;
	}

	public update(deltaTime: number): void {
		if (!this.camera) {
			this.initCameraAndNavigators();
		}

		this.activeNavigator.update(deltaTime);

		if (this.groundNavigator.switchToSlippy) {
			this.groundNavigator.switchToSlippy = false;

			this.groundNavigator.disable();
			this.slippyNavigator.enable();
			this.slippyNavigator.syncWithCamera(this.groundNavigator);

			this.activeNavigator = this.slippyNavigator;
			this.mode = NavigationMode.Slippy;

			this.activeNavigator.update(deltaTime);
		}

		if (this.slippyNavigator.switchToGround) {
			this.slippyNavigator.switchToGround = false;

			this.slippyNavigator.disable();
			this.groundNavigator.enable();
			this.groundNavigator.syncWithCamera(this.slippyNavigator);

			this.activeNavigator = this.groundNavigator;
			this.mode = NavigationMode.Ground;

			this.activeNavigator.update(deltaTime);
		}

		if (this.wheelZoomScaleTarget !== this.wheelZoomScale) {
			const sign = Math.sign(this.wheelZoomScaleTarget - this.wheelZoomScale);

			this.wheelZoomScale += sign * deltaTime * WheelZoomFactor;
			this.wheelZoomScale = MathUtils.clamp(this.wheelZoomScale, 0, 1);

			const alpha = Easing.easeOutCubic(this.wheelZoomScale);

			this.camera.zoom(MathUtils.lerp(1, Config.CameraFOVZoomFactor, alpha));
		}

		this.updateFlightHud(deltaTime);
		this.updateHash();

		++this.tick;
	}

	// Live flight HUD state (free-fly mode only), published to the
	// FlightPanel: current speed, heading, height above ground in feet,
	// the slider value and its live altitude cap, and the queued-data
	// percentage. Also clamps the stored slider value to the cap every
	// frame, so descending clamps the speed at once. Leaving flight mode
	// publishes active:false once, so the flight panel clears instead of
	// staying stuck on screen.
	private updateFlightHud(deltaTime: number): void {
		this.flightHudTimer += deltaTime;

		const active = this.mode === NavigationMode.Free && !this.drivingMode && !!this.freeNavigator;

		if (!active) {
			if (this.lastFlightHudActive) {
				this.lastFlightHudActive = false;
				this.publishFlightHud();
			}

			return;
		}

		if (this.flightHudTimer < FlightHudUpdateInterval) {
			return;
		}

		this.flightHudTimer = 0;

		const capMph = this.getFlightSpeedCapMph();
		this.flightMaxSpeedMph = Math.min(this.flightMaxSpeedMph, capMph);
		this.lastFlightHudActive = true;

		this.publishFlightHud();
	}

	// Publish the current flight HUD state immediately (used by the HUD
	// timer and by the slider, so the panel answers at once).
	private publishFlightHud(): void {
		const uiSystem = this.systemManager.getSystem(UISystem);

		if (!uiSystem || !this.freeNavigator) {
			return;
		}

		const capMph = this.getFlightSpeedCapMph();
		const agl = this.getCameraAgl();

		uiSystem.setFlightState({
			active: this.mode === NavigationMode.Free && !this.drivingMode,
			speedMph: this.freeNavigator.currentSpeedMps * MpsToMph,
			headingDeg: MathUtils.toDeg(this.freeNavigator.getCurrentState().yaw),
			altitudeFt: Math.round(agl * MetersToFeet),
			maxSpeedMph: this.flightMaxSpeedMph,
			maxSpeedCapMph: capMph,
			dataLoadedPct: this.computeDataLoadedPct()
		});
	}

	// Percentage of the queued map data for the current view that has
	// loaded (same basis as the driving HUD). Null when nothing is
	// queued, so the HUD can hide the indicator.
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
