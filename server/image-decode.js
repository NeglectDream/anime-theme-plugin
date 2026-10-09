/**
 * Minimal image decoding for the wallpaper manager.
 *
 * The host gives a plugin no way to decode an image, so the theme's "follow the
 * wallpaper's colours" feature has to do it here.
 *
 *   JPEG → the vendored jpeg-js decoder (BSD-3-Clause; see
 *          vendor/jpeg-js/LICENSE — that licence covers that directory only)
 *   PNG  → decoded below, so a PNG wallpaper needs no second dependency
 *
 * Both paths return RGBA bytes, so the tinting code has a single shape to read.
 */
import { createRequire } from "node:module";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
// jpeg-js is CommonJS; createRequire is the supported way to pull it into ESM.
const decodeJpeg = require("../vendor/jpeg-js/lib/decoder.js");

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Identify a raster format from its magic bytes. */
export function detectFormat(buffer) {
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return "jpeg";
	}
	if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
		return "png";
	}
	if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
		return "gif";
	}
	if (
		buffer.length >= 12 &&
		buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
		buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
	) {
		return "webp";
	}
	return undefined;
}

/** PNG → RGBA. 8/16-bit, non-interlaced, colour types 0/2/3/4/6. */
function decodePngToRgba(buffer) {
	let width;
	let height;
	let bitDepth;
	let colorType;
	let interlace;
	let palette;
	const idat = [];

	let offset = 8;
	while (offset + 8 <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8];
			colorType = data[9];
			interlace = data[12];
		} else if (type === "PLTE") {
			palette = data;
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}
		offset += 12 + length;
	}

	if (width === undefined || height === undefined) throw new Error("PNG: missing IHDR");
	if (interlace !== 0) throw new Error("PNG: interlaced images are not supported");
	if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`PNG: unsupported bit depth ${bitDepth}`);
	const channels = CHANNELS_BY_COLOR_TYPE[colorType];
	if (!channels) throw new Error(`PNG: unsupported colour type ${colorType}`);
	if (colorType === 3 && !palette) throw new Error("PNG: indexed image without a palette");

	const bytesPerSample = bitDepth / 8;
	const bpp = channels * bytesPerSample;
	const stride = width * bpp;
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const pixels = Buffer.alloc(height * stride);

	let position = 0;
	for (let y = 0; y < height; y += 1) {
		const filter = raw[position];
		position += 1;
		const source = raw.subarray(position, position + stride);
		position += stride;
		const out = pixels.subarray(y * stride, (y + 1) * stride);
		const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined;

		for (let i = 0; i < stride; i += 1) {
			const a = i >= bpp ? out[i - bpp] : 0;
			const b = prior ? prior[i] : 0;
			const c = prior && i >= bpp ? prior[i - bpp] : 0;
			let value;
			if (filter === 0) value = source[i];
			else if (filter === 1) value = source[i] + a;
			else if (filter === 2) value = source[i] + b;
			else if (filter === 3) value = source[i] + ((a + b) >> 1);
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				value = source[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
			} else {
				throw new Error(`PNG: unknown filter type ${filter}`);
			}
			out[i] = value & 0xff;
		}
	}

	// Normalise every colour type to RGBA.
	const rgba = Buffer.alloc(width * height * 4);
	const read = (base, index) => pixels[base + index * bytesPerSample];
	for (let i = 0; i < width * height; i += 1) {
		const base = i * bpp;
		let r;
		let g;
		let b;
		let alpha = 255;
		if (colorType === 3) {
			const entry = pixels[base] * 3;
			r = palette[entry];
			g = palette[entry + 1];
			b = palette[entry + 2];
		} else if (colorType === 0 || colorType === 4) {
			r = g = b = read(base, 0);
			if (colorType === 4) alpha = read(base, 1);
		} else {
			r = read(base, 0);
			g = read(base, 1);
			b = read(base, 2);
			if (colorType === 6) alpha = read(base, 3);
		}
		const out = i * 4;
		rgba[out] = r;
		rgba[out + 1] = g;
		rgba[out + 2] = b;
		rgba[out + 3] = alpha;
	}

	return { width, height, rgba };
}

/**
 * Decode a supported image to RGBA.
 * Throws for anything else — callers report the reason rather than guessing.
 */
export function decodeImage(buffer) {
	const format = detectFormat(buffer);
	if (format === "jpeg") {
		const raw = decodeJpeg(buffer, { useTArray: true, formatAsRGBA: true });
		return { width: raw.width, height: raw.height, rgba: raw.data, format };
	}
	if (format === "png") {
		return { ...decodePngToRgba(buffer), format };
	}
	throw new Error(`unsupported image format: ${format ?? "unrecognised"}`);
}
