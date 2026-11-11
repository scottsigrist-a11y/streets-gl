import Vec3 from "~/lib/math/Vec3";
import {AircraftPart, AircraftPartType} from "~/app/vehicles/aircraft/Aircraft";

// A simple drivable car, rendered as two boxes (red body + darker cabin)
// through the same instanced-vehicle pipeline as the aircraft.
//
// World coordinates are Web-Mercator meters, like everywhere else in the
// app: x = northing, z = easting, y = up. Heading is radians clockwise
// from north; the model forward axis is +X (like the aircraft models), so
// the rendered rotation.y is the negated heading.
export default class Car {
	public x: number = 0; // northing, meters
	public z: number = 0; // easting, meters
	public height: number = 0; // ground height, meters
	public heading: number = 0; // radians, clockwise from north
	public speed: number = 0; // m/s, negative when reversing
	public visible: boolean = false; // only rendered while driving mode is on

	public getParts(): AircraftPart[] {
		if (!this.visible) {
			return [];
		}

		const position = new Vec3(this.x, this.height, this.z);
		const rotation = new Vec3(0, -this.heading, 0);

		return [{
			type: AircraftPartType.CarBody,
			position,
			rotation
		}, {
			type: AircraftPartType.CarCabin,
			position,
			rotation
		}];
	}
}
