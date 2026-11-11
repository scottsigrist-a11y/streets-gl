import {SettingsSchema} from "~/app/settings/SettingsSchema";
import {OverpassEndpoint} from "~/app/systems/TileLoadingSystem";
import RenderGraphSnapshot from "~/app/ui/RenderGraphSnapshot";

// Live state of the driving mode, published by DrivingSystem for the
// driving HUD (speedometer + heading). Null until driving is used.
export interface DrivingState {
	active: boolean;
	speedMph: number;
	speedKmh: number;
	headingDeg: number;
}

export default interface UISystemState {
	activeFeature: {type: number; id: number};
	fps: number;
	fpsSmooth: number;
	frameTime: number;
	frameTimeSmooth: number;
	mapTime: number;
	mapTimeMultiplier: number;
	mapTimeMode: number;
	renderGraph: RenderGraphSnapshot;
	resourcesLoadingProgress: number;
	resourceInProgressPath: string;
	northDirection: number;
	settingsSchema: SettingsSchema;
	overpassEndpoints: OverpassEndpoint[];
	dataTimestamp: Date;
	driving: DrivingState | null;
}
