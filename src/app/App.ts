import RenderSystem from "./systems/RenderSystem";
import TileSystem from "./systems/TileSystem";
import ControlsSystem from "./systems/ControlsSystem";
import PickingSystem from "./systems/PickingSystem";
import CursorStyleSystem from './systems/CursorStyleSystem';
import SystemManager from "./SystemManager";
import TileObjectsSystem from "./systems/TileObjectsSystem";
import TileLoadingSystem from "./systems/TileLoadingSystem";
import MapWorkerSystem from "./systems/MapWorkerSystem";
import MapTimeSystem from "./systems/MapTimeSystem";
import UISystem from "./systems/UISystem";
import SceneSystem from './systems/SceneSystem';
import ResourceLoader, {ResourceJSON} from './world/ResourceLoader';
import resourcesList from '../resources/resources.json';
import createSolidColorImageData from './render/textures/createSolidColorImageData';
import VehicleSystem from "./systems/VehicleSystem";
import DrivingSystem from "./systems/DrivingSystem";
import TerrainSystem from "./systems/TerrainSystem";
import SettingsSystem from "~/app/systems/SettingsSystem";
import SlippyMapSystem from "~/app/systems/SlippyMapSystem";

class App {
	private loop = (deltaTime: number): void => this.update(deltaTime);
	private time = 0;
	private systemManager: SystemManager;

	public constructor() {
		this.init();
	}

	private init(): void {
		this.systemManager = new SystemManager();

		this.systemManager.addSystems(SettingsSystem);
		this.systemManager.addSystems(UISystem);

		ResourceLoader.addFromJSON(resourcesList as ResourceJSON);

		// Drivable car textures: the source PNGs were single flat colors,
		// so the equivalent 512x512 RGBA textures are generated at runtime
		// and registered under the same resource keys the car rendering
		// code uses (carBodyDiffuse, carBodyNormal, carCabinDiffuse,
		// carCabinNormal).
		ResourceLoader.set('carBodyDiffuse', createSolidColorImageData(512, 512, 224, 80, 64, 255));
		ResourceLoader.set('carBodyNormal', createSolidColorImageData(512, 512, 128, 128, 255, 255));
		ResourceLoader.set('carCabinDiffuse', createSolidColorImageData(512, 512, 22, 35, 63, 255));
		ResourceLoader.set('carCabinNormal', createSolidColorImageData(512, 512, 128, 128, 255, 255));

		ResourceLoader.load({
			onFileLoad: (loaded: number, total: number) => {
				this.systemManager.getSystem(UISystem).setResourcesLoadingProgress(loaded / total);
			},
			onLoadedFileNameChange: (name: string) => {
				this.systemManager.getSystem(UISystem).setResourceInProgressPath(name);
			}
		}).then(() => {
			this.systemManager.addSystems(
				ControlsSystem,
				MapTimeSystem,
				TerrainSystem,
				TileSystem,
				SceneSystem,
				CursorStyleSystem,
				PickingSystem,
				TileObjectsSystem,
				SlippyMapSystem,
				VehicleSystem,
				DrivingSystem,
				RenderSystem,
				MapWorkerSystem,
				TileLoadingSystem,
			);
		});

		this.update();
	}

	private update(rafTime = 0): void {
		requestAnimationFrame(this.loop);

		const frameStart = performance.now();
		const deltaTime = (rafTime - this.time) / 1e3;
		this.time = rafTime;

		this.systemManager.updateSystems(deltaTime);

		const frameTime = performance.now() - frameStart;
		this.systemManager.getSystem(UISystem).updateFrameTime(frameTime);
	}
}

export default new App;
