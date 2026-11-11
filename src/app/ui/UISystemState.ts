import {SettingsSchema} from "~/app/settings/SettingsSchema";
import {OverpassEndpoint} from "~/app/systems/TileLoadingSystem";
import RenderGraphSnapshot from "~/app/ui/RenderGraphSnapshot";

// Live state of the driving mode, published by DrivingSystem for the
// driving HUD (speedometer + heading). Null until driving is used.
// maxSpeedMph is the HUD slider's cap; maxSpeedCapMph is the live
// altitude cap that bounds the slider; altitudeFt is the car's terrain
// elevation in feet; dataLoadedPct is the percentage of queued map data
// loaded for the current view (null when nothing is queued).
export interface DrivingState {
	active: boolean;
	speedMph: number;
	speedKmh: number;
	headingDeg: number;
	maxSpeedMph: number;
	maxSpeedCapMph: number;
	altitudeFt: number;
	dataLoadedPct: number | null;
}

// Live state of the free-fly mode, published by ControlsSystem for the
// flight HUD. Same shape as the driving HUD: speedMph is the camera's
// current speed, altitudeFt is the height above ground in feet,
// maxSpeedMph is the slider value, maxSpeedCapMph is the live altitude
// cap that bounds it.
export interface FlightState {
	active: boolean;
	speedMph: number;
	headingDeg: number;
	altitudeFt: number;
	maxSpeedMph: number;
	maxSpeedCapMph: number;
	dataLoadedPct: number | null;
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
	flight: FlightState | null;
}
