import System from "../System";
import SceneSystem from "./SceneSystem";
import MathUtils from "~/lib/math/MathUtils";
import Vec2 from "~/lib/math/Vec2";
import Config from "../Config";
import HeightTileSource from "../terrain/tile-source/HeightTileSource";
import WaterTileSource from "../terrain/tile-source/WaterTileSource";
import TileAreaLoader from "../terrain/TileAreaLoader";
import Terrain from "~/app/objects/Terrain";
import Object3D from "~/lib/core/Object3D";
import TerrainHeightProvider from "~/app/terrain/TerrainHeightProvider";
import WaterTileSourceFactory from "~/app/terrain/tile-source/factory/WaterTileSourceFactory";
import HeightReusedTileSourceFactory from "~/app/terrain/tile-source/factory/HeightReusedTileSourceFactory";
import HeightTileSourceFactory from "~/app/terrain/tile-source/factory/HeightTileSourceFactory";
import ControlsSystem, {NavigationMode} from "~/app/systems/ControlsSystem";
import SettingsSystem from "~/app/systems/SettingsSystem";

export interface TerrainAreaLoaders {
	water0: TileAreaLoader<WaterTileSource>;
	water1: TileAreaLoader<WaterTileSource>;
	height0: TileAreaLoader<HeightTileSource>;
	height1: TileAreaLoader<HeightTileSource>;
}

// Adaptive terrain detail, by camera height above ground (AGL):
// the closer the camera gets to the ground, the finer the terrain.
// 'max' (near the ground) uses the densest mesh the height data can
// feed and the finer height zoom; 'base' (far above) is the original
// detail. The mesh is the binding constraint — the innermost ring is
// ~4,892 m across, so 256 segments puts a vertex every ~19 m, matching
// the zoom-12 height texels (~19 m); the zoom-13 height data (~9.5 m)
// mainly sharpens the slope shading (normals) beyond that. Thresholds
// have separate enter/leave altitudes (hysteresis) so hovering near a
// boundary does not rebuild meshes every frame.
type TerrainDetailTier = 'max' | 'mid' | 'base';

const TerrainDetailTiers: Record<TerrainDetailTier, {segments: number[]; heightZoom: number}> = {
	max: {segments: [256, 128, 64, 64, 64, 64], heightZoom: 13},
	mid: {segments: [128, 64, 64, 64, 64, 64], heightZoom: 12},
	base: {segments: [64, 64, 64, 64, 64, 64], heightZoom: 12}
};

const MaxDetailEnterAglM = 500; // below this AGL, switch to max detail
const MaxDetailLeaveAglM = 900; // above this AGL, leave max detail
const BaseDetailEnterAglM = 4500; // above this AGL, switch to base detail
const BaseDetailLeaveAglM = 3000; // below this AGL, leave base detail

export default class TerrainSystem extends System {
	public maskOrigin: Vec2 = new Vec2();
	// Mutable (not Readonly): the adaptive detail system swaps height0
	// for a loader at another zoom when the camera gets close to the
	// ground. Readers (the texture pass) always read it fresh.
	public areaLoaders: TerrainAreaLoaders;
	public readonly terrainHeightProvider: TerrainHeightProvider = new TerrainHeightProvider(12, 13);
	private loadTerrainHeight: boolean = true;
	private detailTier: TerrainDetailTier = 'base';
	private lastKnownAgl: number | null = null;
	// Height loader prefetching the other zoom while the camera is near
	// a tier boundary. It is only swapped in once its viewport is
	// (nearly) full, so the ground never goes flat mid-stream — and the
	// finest tiles are never fetched while the camera is far above the
	// ground, because prefetching only starts when the tier wants them.
	private pendingHeightLoader: TileAreaLoader<HeightTileSource> | null = null;
	private pendingHeightZoom: number = 0;

	public postInit(): void {
		this.createAreaLoaders();
		this.listenToSettings();
	}

	private createAreaLoaders(): void {
		this.areaLoaders = {
			water0: new TileAreaLoader({
				sourceFactory: new WaterTileSourceFactory(),
				zoom: 13,
				maxStoredTiles: 100,
				viewportSize: 4,
				bufferSize: 1,
				maxConcurrentRequests: 1
			}),
			water1: new TileAreaLoader({
				sourceFactory: new WaterTileSourceFactory(),
				zoom: 9,
				maxStoredTiles: 100,
				viewportSize: 4,
				bufferSize: 1,
				maxConcurrentRequests: 1
			}),
			height0: new TileAreaLoader({
				sourceFactory: new HeightReusedTileSourceFactory(this.terrainHeightProvider, 0),
				zoom: 12,
				maxStoredTiles: 100,
				viewportSize: 4,
				bufferSize: 1,
				maxConcurrentRequests: 1
			}),
			height1: new TileAreaLoader({
				sourceFactory: new HeightTileSourceFactory(),
				zoom: 9,
				maxStoredTiles: 100,
				viewportSize: 4,
				bufferSize: 1,
				maxConcurrentRequests: 1
			}),
		};
	}

	private listenToSettings(): void {
		const settings = this.systemManager.getSystem(SettingsSystem).settings;

		settings.onChange('terrainHeight', ({statusValue}) => {
			const isEnabled = statusValue === 'on';

			this.loadTerrainHeight = isEnabled;
			this.terrainHeightProvider.setFallbackState(!isEnabled);
		}, true);
	}

	public update(deltaTime: number): void {
		const terrain = this.systemManager.getSystem(SceneSystem).objects.terrain;
		const camera = this.systemManager.getSystem(SceneSystem).objects.camera;
		const slippyMode = this.systemManager.getSystem(ControlsSystem).mode === NavigationMode.Slippy;

		this.terrainHeightProvider.update();

		if (!slippyMode || camera.position.y < 10000) {
			this.updateAreaLoaders(camera);
		}

		if (!slippyMode) {
			this.updateRingPositions(terrain, camera);
			this.updateRingAreaTransforms(terrain);
			this.updateRingMaskTransforms(terrain, camera);
			this.updateDetailTier(camera);
		}
	}

	// Camera height above the ground (m), or null when the terrain
	// height under the camera has not resolved yet (falls back to the
	// last resolved value so the tier does not flap on a null query).
	private getCameraAgl(camera: Object3D): number | null {
		const height = this.terrainHeightProvider.getHeightGlobalInterpolated(camera.position.x, camera.position.z, true);

		if (height !== null && Number.isFinite(height)) {
			this.lastKnownAgl = Math.max(camera.position.y - height, 0);
		}

		return this.lastKnownAgl;
	}

	// Pick the detail tier from the camera altitude, with hysteresis,
	// and apply it: rebuild the ring meshes at the tier's density and
	// start prefetching the tier's height zoom.
	private updateDetailTier(camera: Object3D): void {
		const agl = this.getCameraAgl(camera);

		if (agl === null) {
			return;
		}

		let tier = this.detailTier;

		if (tier !== 'max' && agl < MaxDetailEnterAglM) {
			tier = 'max';
		} else if (tier === 'max' && agl > MaxDetailLeaveAglM) {
			tier = 'mid';
		} else if (tier !== 'base' && agl > BaseDetailEnterAglM) {
			tier = 'base';
		} else if (tier === 'base' && agl < BaseDetailLeaveAglM) {
			tier = 'mid';
		}

		if (tier !== this.detailTier) {
			this.detailTier = tier;
			const terrain = this.systemManager.getSystem(SceneSystem).objects.terrain;
			terrain.setRingDetail(TerrainDetailTiers[tier].segments);
		}

		this.updateHeightDetail(tier, camera);
	}

	// Move the near height layer to the tier's zoom. The new loader is
	// built and prefetched in the background and only swapped in once
	// its viewport is (nearly) full, so the ground never goes flat while
	// the new zoom streams in; a single failed tile must not block the
	// swap forever, hence 90% instead of 100%. While the camera is far
	// above the ground the tier wants zoom 12, so the finer zoom-13
	// tiles are never requested up there.
	private updateHeightDetail(tier: TerrainDetailTier, camera: Object3D): void {
		const desiredZoom = TerrainDetailTiers[tier].heightZoom;

		if (desiredZoom === this.areaLoaders.height0.zoom) {
			if (this.pendingHeightLoader) {
				this.pendingHeightLoader.dispose();
				this.pendingHeightLoader = null;
			}

			return;
		}

		if (!this.pendingHeightLoader || this.pendingHeightZoom !== desiredZoom) {
			if (this.pendingHeightLoader) {
				this.pendingHeightLoader.dispose();
			}

			this.pendingHeightZoom = desiredZoom;
			this.pendingHeightLoader = new TileAreaLoader({
				sourceFactory: new HeightReusedTileSourceFactory(this.terrainHeightProvider, 0),
				zoom: desiredZoom,
				maxStoredTiles: 100,
				viewportSize: 4,
				bufferSize: 1,
				maxConcurrentRequests: 4
			});
		}

		const cameraPosition2D = new Vec2(camera.position.x, camera.position.z);
		this.pendingHeightLoader.update(cameraPosition2D);

		const progress = this.pendingHeightLoader.getLoadProgress();

		if (progress.total > 0 && progress.loaded / progress.total >= 0.9) {
			const oldLoader = this.areaLoaders.height0;
			this.areaLoaders.height0 = this.pendingHeightLoader;
			this.pendingHeightLoader = null;
			oldLoader.dispose();
		}
	}

	private updateAreaLoaders(camera: Object3D): void {
		this.updateWaterLoaders(camera);

		if (this.loadTerrainHeight) {
			this.updateHeightLoaders(camera);
		}
	}

	// Loading progress across the area loaders' viewports (water + height
	// tiles): tiles with data vs all tiles assigned to the viewports.
	public getLoadProgress(): {loaded: number; total: number} {
		let loaded = 0;
		let total = 0;

		for (const loader of Object.values(this.areaLoaders)) {
			const progress = loader.getLoadProgress();
			loaded += progress.loaded;
			total += progress.total;
		}

		return {loaded, total};
	}

	private updateHeightLoaders(camera: Object3D): void {
		const cameraPosition2D = new Vec2(camera.position.x, camera.position.z);

		this.areaLoaders.height0.update(cameraPosition2D);
		this.areaLoaders.height1.update(cameraPosition2D);
	}

	private updateWaterLoaders(camera: Object3D): void {
		const cameraPosition2D = new Vec2(camera.position.x, camera.position.z);

		this.areaLoaders.water0.update(cameraPosition2D);
		this.areaLoaders.water1.update(cameraPosition2D);
	}

	private updateRingPositions(terrain: Terrain, camera: Object3D): void {
		let currentStepX: number, currentStepY: number;

		for (let i = 0; i < terrain.children.length; i++) {
			const ring = terrain.children[i];
			const stepSize = ring.size / ring.segmentCount;

			ring.position.set(
				camera.position.x - MathUtils.mod(camera.position.x, stepSize),
				0,
				camera.position.z - MathUtils.mod(camera.position.z, -stepSize)
			);
			ring.updateMatrix();

			if (i === 0) {
				currentStepX = Math.floor(camera.position.x / stepSize);
				currentStepY = Math.floor(camera.position.z / stepSize);
			}

			ring.morphOffset[0] = currentStepX % 2 === 0 ? 0 : 2;
			ring.morphOffset[1] = currentStepY % 2 === 0 ? 0 : -2;

			if (i === terrain.children.length - 1) {
				ring.isLastRing = true;
			}

			currentStepX = Math.floor(currentStepX / 2);
			currentStepY = Math.floor(currentStepY / 2);
		}
	}

	private updateRingAreaTransforms(terrain: Terrain): void {
		for (const ring of terrain.children) {
			this.areaLoaders.water0.transformToArray(
				ring.position.x - ring.size / 2,
				ring.position.z - ring.size / 2,
				ring.size,
				ring.waterTextureTransform0
			);
			this.areaLoaders.water1.transformToArray(
				ring.position.x - ring.size / 2,
				ring.position.z - ring.size / 2,
				ring.size,
				ring.waterTextureTransform1
			);
			this.areaLoaders.height0.transformToArray(
				ring.position.x - ring.size / 2,
				ring.position.z - ring.size / 2,
				ring.size,
				ring.heightTextureTransform0
			);
			this.areaLoaders.height1.transformToArray(
				ring.position.x - ring.size / 2,
				ring.position.z - ring.size / 2,
				ring.size,
				ring.heightTextureTransform1
			);
		}
	}

	private updateRingMaskTransforms(terrain: Terrain, camera: Object3D): void {
		const cameraTilePosition = MathUtils.meters2tile(camera.position.x, camera.position.z);
		const startX = Math.floor(cameraTilePosition.x) - Math.floor(Config.TerrainMaskResolution / 2);
		const startY = Math.floor(cameraTilePosition.y) - Math.floor(Config.TerrainMaskResolution / 2);
		const startMeters = MathUtils.tile2meters(startX, startY + Config.TerrainMaskResolution);

		this.maskOrigin.set(startX, startY);

		for (const ring of terrain.children) {
			const maskWorldSize = Config.TileSize * Config.TerrainMaskResolution;
			const maskScale = ring.size / maskWorldSize;
			const maskOffsetX = (ring.position.x - ring.size / 2 - startMeters.x) / maskWorldSize;
			const maskOffsetY = (ring.position.z - ring.size / 2 - startMeters.y) / maskWorldSize;

			ring.maskTextureTransform[0] = maskOffsetX;
			ring.maskTextureTransform[1] = maskOffsetY;
			ring.maskTextureTransform[2] = maskScale;
		}
	}
}