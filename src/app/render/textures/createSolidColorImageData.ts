/**
 * Generates raw RGBA8 pixel data for a flat solid-color texture.
 *
 * Used for the drivable car's textures: the source PNGs were single flat
 * colors, so generating the pixels at runtime produces identical texture
 * data without shipping image files.
 */
export default function createSolidColorImageData(
	width: number,
	height: number,
	r: number,
	g: number,
	b: number,
	a: number
): Uint8Array {
	const data = new Uint8Array(width * height * 4);

	for (let i = 0; i < width * height; i++) {
		const offset = i * 4;
		data[offset] = r;
		data[offset + 1] = g;
		data[offset + 2] = b;
		data[offset + 3] = a;
	}

	return data;
}
