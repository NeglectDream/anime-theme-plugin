/**
 * Minimal PNG encoder shared by the art generators.
 *
 * Zero dependencies: CRC32 and the chunk framing are written out by hand, and the
 * scanlines use per-row adaptive filtering (minimum sum of absolute differences)
 * because the art here is mostly large soft gradients, which compress several
 * times better with Sub/Up/Paeth than with a fixed filter.
 */
import zlib from "node:zlib";

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, "ascii");
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Encode an RGB image. `rgb` is a flat buffer of `width * height * 3` values in
 * the 0..1 range (values outside are clamped).
 */
export function encodePng(width, height, rgb) {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor RGB
	ihdr[10] = 0; // deflate
	ihdr[11] = 0; // adaptive filtering
	ihdr[12] = 0; // no interlace

	const bpp = 3;
	const stride = width * bpp;
	const out = Buffer.alloc((stride + 1) * height);
	const line = Buffer.alloc(stride);
	const prev = Buffer.alloc(stride);
	const candidates = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));

	for (let y = 0; y < height; y += 1) {
		for (let i = 0; i < stride; i += 1) {
			const v = Math.round(rgb[y * stride + i] * 255);
			line[i] = v < 0 ? 0 : v > 255 ? 255 : v;
		}

		let bestType = 0;
		let bestScore = Number.POSITIVE_INFINITY;
		for (let type = 0; type < 5; type += 1) {
			let score = 0;
			const target = candidates[type];
			for (let i = 0; i < stride; i += 1) {
				const a = i >= bpp ? line[i - bpp] : 0;
				const b = prev[i];
				const c = i >= bpp ? prev[i - bpp] : 0;
				let prediction;
				if (type === 0) prediction = 0;
				else if (type === 1) prediction = a;
				else if (type === 2) prediction = b;
				else if (type === 3) prediction = (a + b) >> 1;
				else {
					const p = a + b - c;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					prediction = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
				}
				const val = (line[i] - prediction) & 0xff;
				target[i] = val;
				score += val < 128 ? val : 256 - val;
			}
			if (score < bestScore) {
				bestScore = score;
				bestType = type;
			}
		}

		out[y * (stride + 1)] = bestType;
		candidates[bestType].copy(out, y * (stride + 1) + 1);
		line.copy(prev);
	}

	return Buffer.concat([
		signature,
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(out, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/**
 * Encode an RGBA image (used by the nine-slice frame, which needs a transparent
 * centre). `rgba` is a flat buffer of `width * height * 4` values in 0..1.
 */
export function encodePngRgba(width, height, rgba) {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6; // color type: truecolor + alpha
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	const bpp = 4;
	const stride = width * bpp;
	const out = Buffer.alloc((stride + 1) * height);
	const line = Buffer.alloc(stride);
	const prev = Buffer.alloc(stride);
	const candidates = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));

	for (let y = 0; y < height; y += 1) {
		for (let i = 0; i < stride; i += 1) {
			const v = Math.round(rgba[y * stride + i] * 255);
			line[i] = v < 0 ? 0 : v > 255 ? 255 : v;
		}

		let bestType = 0;
		let bestScore = Number.POSITIVE_INFINITY;
		for (let type = 0; type < 5; type += 1) {
			let score = 0;
			const target = candidates[type];
			for (let i = 0; i < stride; i += 1) {
				const a = i >= bpp ? line[i - bpp] : 0;
				const b = prev[i];
				const c = i >= bpp ? prev[i - bpp] : 0;
				let prediction;
				if (type === 0) prediction = 0;
				else if (type === 1) prediction = a;
				else if (type === 2) prediction = b;
				else if (type === 3) prediction = (a + b) >> 1;
				else {
					const p = a + b - c;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					prediction = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
				}
				const val = (line[i] - prediction) & 0xff;
				target[i] = val;
				score += val < 128 ? val : 256 - val;
			}
			if (score < bestScore) {
				bestScore = score;
				bestType = type;
			}
		}

		out[y * (stride + 1)] = bestType;
		candidates[bestType].copy(out, y * (stride + 1) + 1);
		line.copy(prev);
	}

	return Buffer.concat([
		signature,
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(out, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** Parse "#rrggbb" into a 0..1 RGB triple. */
export function hex(value) {
	return [
		Number.parseInt(value.slice(1, 3), 16) / 255,
		Number.parseInt(value.slice(3, 5), 16) / 255,
		Number.parseInt(value.slice(5, 7), 16) / 255,
	];
}
