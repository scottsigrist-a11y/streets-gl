import AABB3D from "~/lib/math/AABB3D";
import Vec3 from "~/lib/math/Vec3";
import {ModelSourceBuffers} from "~/app/objects/models/ModelManager";

// Builds the vertex buffers for an axis-aligned box, in the same buffer
// shape as a loaded glTF model, so it can be rendered by
// InstancedAircraftPart through the instanced-vehicle pipeline.
//
// The box sits on the ground: y spans 0..height. Forward is +X, matching
// the aircraft models, so rotation.y = -heading works the same way as for
// aircraft (see VehicleSystem). UVs span 0..1 per face; with the solid
// car textures any UV would do, but proper UVs keep the shader honest.
export function createBoxModelSourceBuffers(
	length: number, // along X (forward)
	height: number, // along Y (up)
	width: number, // along Z
	offsetX: number = 0,
	offsetY: number = 0,
	offsetZ: number = 0
): ModelSourceBuffers {
	const hx = length / 2;
	const hz = width / 2;

	const faces: {normal: [number, number, number]; corners: [number, number, number][]}[] = [
		{normal: [1, 0, 0], corners: [[hx, 0, -hz], [hx, 0, hz], [hx, height, hz], [hx, height, -hz]]}, // front (+X, nose)
		{normal: [-1, 0, 0], corners: [[-hx, 0, hz], [-hx, 0, -hz], [-hx, height, -hz], [-hx, height, hz]]}, // rear (-X)
		{normal: [0, 1, 0], corners: [[-hx, height, -hz], [hx, height, -hz], [hx, height, hz], [-hx, height, hz]]}, // top (+Y)
		{normal: [0, -1, 0], corners: [[-hx, 0, hz], [hx, 0, hz], [hx, 0, -hz], [-hx, 0, -hz]]}, // bottom (-Y)
		{normal: [0, 0, 1], corners: [[hx, 0, hz], [-hx, 0, hz], [-hx, height, hz], [hx, height, hz]]}, // right (+Z)
		{normal: [0, 0, -1], corners: [[-hx, 0, -hz], [hx, 0, -hz], [hx, height, -hz], [-hx, height, -hz]]} // left (-Z)
	];

	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const indices: number[] = [];

	for (const face of faces) {
		const base = positions.length / 3;
		const faceUvs: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];

		for (let i = 0; i < 4; i++) {
			const corner = face.corners[i];
			positions.push(corner[0] + offsetX, corner[1] + offsetY, corner[2] + offsetZ);
			normals.push(face.normal[0], face.normal[1], face.normal[2]);
			uvs.push(faceUvs[i][0], faceUvs[i][1]);
		}

		indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
	}

	return {
		position: new Float32Array(positions),
		normal: new Float32Array(normals),
		uv: new Float32Array(uvs),
		indices: new Uint32Array(indices),
		boundingBox: new AABB3D(
			new Vec3(-hx + offsetX, offsetY, -hz + offsetZ),
			new Vec3(hx + offsetX, height + offsetY, hz + offsetZ)
		)
	};
}
