import {OverpassEndpoint} from "~/app/systems/TileLoadingSystem";
import {DrivingTouchInput} from "~/app/systems/DrivingSystem";

export default interface UIActions {
	updateRenderGraph: () => void;
	goToLatLon: (lat: number, lon: number) => void;
	goToState: (lat: number, lon: number, pitch: number, yaw: number, distance: number) => void;
	lookAtNorth: () => void;
	setTime: (time: number) => void;
	resetSettings: () => void;
	setOverpassEndpoints: (endpoints: OverpassEndpoint[]) => void;
	resetOverpassEndpoints: () => void;
	getControlsStateHash: () => string;
	setDrivingEnabled: (enabled: boolean) => void;
	setDrivingTouchButton: (button: keyof DrivingTouchInput, pressed: boolean) => void;
}