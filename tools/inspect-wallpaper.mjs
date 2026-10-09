/**
 * Inspects a wallpaper: real format, dimensions, and — the part that actually
 * bites — whether the theme's text stays readable on top of it.
 *
 * The theme paints translucent panels over the art, so readability depends on how
 * bright the wallpaper is under them. A dark photo behind the light scheme (dark
 * text on a light panel) or a blown-out one behind the dark scheme (light text on
 * a dark panel) will quietly produce an unreadable UI, and nothing in the manifest
 * can fix that — the fix is a different image.
 *
 * Decodes PNG in-process (no dependencies) so the numbers are measured rather
 * than guessed. `node tools/inspect-wallpaper.mjs [file ...]`
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Minimal PNG decoder: 8/16-bit, non-interlaced, color types 0/2/3/4/6. */
function decodePng(buffer) {
	if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
		throw new Error("not a PNG (bad signature)");
	}

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

	if (width === undefined || height === undefined) throw new Error("missing IHDR");
	if (interlace !== 0) throw new Error("interlaced PNG is not supported");
	if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`unsupported bit depth: ${bitDepth}`);
	const channels = CHANNELS_BY_COLOR_TYPE[colorType];
	if (!channels) throw new Error(`unsupported color type: ${colorType}`);
	if (colorType === 3 && !palette) throw new Error("indexed PNG without a palette");

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
				throw new Error(`unknown filter type: ${filter}`);
			}
			out[i] = value & 0xff;
		}
	}

	return { width, height, bitDepth, colorType, channels, bytesPerSample, palette, pixels, stride };
}

/** Sample one pixel as 0..1 RGB, following the PNG color type. */
function samplePixel(image, x, y) {
	const { channels, bytesPerSample, palette, colorType, pixels, stride } = image;
	const base = y * stride + x * channels * bytesPerSample;
	const read = (index) => pixels[base + index * bytesPerSample] / 255; // high byte for 16-bit

	if (colorType === 3) {
		const index = pixels[base] * 3;
		return [palette[index] / 255, palette[index + 1] / 255, palette[index + 2] / 255];
	}
	if (colorType === 0 || colorType === 4) {
		const grey = read(0);
		return [grey, grey, grey];
	}
	return [read(0), read(1), read(2)];
}

// ------------------------------------------------------------ contrast maths

const srgbToLinear = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const relativeLuminance = ([r, g, b]) =>
	0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);

function contrastRatio(a, b) {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Composite a translucent panel colour over a wallpaper sample. */
const composite = (panel, alpha, behind) => [
	panel[0] * alpha + behind[0] * (1 - alpha),
	panel[1] * alpha + behind[1] * (1 - alpha),
	panel[2] * alpha + behind[2] * (1 - alpha),
];

const hex = (value) => [
	Number.parseInt(value.slice(1, 3), 16) / 255,
	Number.parseInt(value.slice(3, 5), 16) / 255,
	Number.parseInt(value.slice(5, 7), 16) / 255,
];

const toHex = (rgb) =>
	`#${rgb
		.map((v) =>
			Math.round(Math.min(1, Math.max(0, v)) * 255)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;

/**
 * The two schemes this theme ships, with the alpha actually stacked on the
 * sidebar (body token + the navbar gradient over it).
 */
const SCHEMES = [
	{
		id: "light",
		label: "浅色（day）",
		text: hex("#2a2140"),
		panel: hex("#fffafd"),
		alpha: 1 - (1 - 0.42) * (1 - 0.46),
		worstIs: "darkest",
	},
	{
		id: "dark",
		label: "深色（night）",
		text: hex("#f4e8f5"),
		panel: hex("#261a32"),
		alpha: 1 - (1 - 0.62) * (1 - 0.64),
		worstIs: "brightest",
	},
];

/** Read width/height out of a JPEG's SOF marker without decoding the pixels. */
function jpegSize(buffer) {
	if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
	let offset = 2;
	while (offset + 4 <= buffer.length) {
		if (buffer[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = buffer[offset + 1];
		// Standalone markers carry no length field.
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		if (offset + 4 > buffer.length) break;
		const length = buffer.readUInt16BE(offset + 2);
		// SOF0-3, SOF5-7, SOF9-11, SOF13-15 carry the frame size.
		const isSof =
			(marker >= 0xc0 && marker <= 0xc3) ||
			(marker >= 0xc5 && marker <= 0xc7) ||
			(marker >= 0xc9 && marker <= 0xcb) ||
			(marker >= 0xcd && marker <= 0xcf);
		if (isSof && offset + 9 <= buffer.length) {
			return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
		}
		if (length < 2) break;
		offset += 2 + length;
	}
	return null;
}

function inspect(file, schemeIds) {
	const bytes = fs.readFileSync(file);

	// JPEG cannot be measured here: the contrast numbers need real pixel values and
	// this tool carries no JPEG decoder. Report the size and say so, rather than
	// failing with "not a PNG" on a perfectly valid wallpaper.
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		const size = jpegSize(bytes);
		console.log(`\n${path.basename(file)}  (${(bytes.length / 1024).toFixed(0)} KiB)`);
		console.log(`  JPEG${size ? `, ${size.width}x${size.height}` : "（无法读取尺寸）"}`);
		console.log("  对比度未测量：需要 JPEG 解码器，本工具不做。");
		console.log("  请目视确认文字清晰；要精确测量，把图另存为 PNG 后再跑本工具。");
		return [];
	}

	const image = decodePng(bytes);

	// Sample on a grid: a wallpaper is smooth enough that this is plenty, and it
	// keeps a 4K image from costing a full pass.
	const stepX = Math.max(1, Math.floor(image.width / 160));
	const stepY = Math.max(1, Math.floor(image.height / 90));
	const samples = [];
	for (let y = 0; y < image.height; y += stepY) {
		for (let x = 0; x < image.width; x += stepX) {
			samples.push(samplePixel(image, x, y));
		}
	}
	samples.sort((p, q) => relativeLuminance(p) - relativeLuminance(q));
	const darkest = samples[0];
	const brightest = samples[samples.length - 1];
	const median = samples[Math.floor(samples.length / 2)];

	console.log(`\n${path.basename(file)}  (${(bytes.length / 1024).toFixed(0)} KiB)`);
	console.log(`  ${image.width}x${image.height}, ${image.bitDepth}-bit, colorType ${image.colorType}`);
	console.log(`  亮度: 最暗 ${toHex(darkest)}  中位 ${toHex(median)}  最亮 ${toHex(brightest)}`);

	const problems = [];
	for (const scheme of SCHEMES) {
		if (schemeIds && !schemeIds.includes(scheme.id)) continue;
		const behind = scheme.worstIs === "darkest" ? darkest : brightest;
		const ratio = contrastRatio(scheme.text, composite(scheme.panel, scheme.alpha, behind));
		const verdict = ratio >= 4.5 ? "PASS AA" : ratio >= 3 ? "仅大字可用" : "FAIL";
		console.log(
			`  ${scheme.label}: 面板不透明度 ${scheme.alpha.toFixed(2)}，最坏对比度 ${ratio.toFixed(2)}:1  ${verdict}`,
		);
		if (ratio < 4.5) problems.push(`${path.basename(file)} 的${scheme.label}对比度只有 ${ratio.toFixed(2)}:1`);
	}
	return problems;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const files =
	args.length > 0
		? args
		: [
				path.join(here, "..", "assets", "day.jpg"),
				path.join(here, "..", "assets", "night.jpg"),
			];

const allProblems = [];
for (const file of files) {
	if (!fs.existsSync(file)) {
		console.log(`\n${path.basename(file)}  不存在（跳过）`);
		continue;
	}
	// A `-night` file is judged against the dark scheme, everything else against light.
	const schemeIds = path.basename(file).includes("night") ? ["dark"] : ["light"];
	try {
		allProblems.push(...inspect(file, schemeIds));
	} catch (error) {
		console.error(`\n${path.basename(file)}: 无法解析 — ${error?.message ?? error}`);
		process.exitCode = 1;
	}
}

console.log("");
if (allProblems.length > 0) {
	console.log("⚠ 可读性提示：");
	for (const problem of allProblems) console.log(`  - ${problem}`);
	console.log("  AA 门槛是 4.5:1。低于它时，换一张更亮（浅色方案）或更暗（深色方案）的图，");
	console.log("  或者调高 manifest 里对应方案 gradients 的 alpha。");
} else {
	console.log("可读性检查通过。");
}
