/**
 * Procedurally generates the anime-style wallpaper shipped in this theme plugin.
 *
 * Zero dependencies: PNG is encoded by hand (zlib deflate + CRC32 chunks) and all
 * drawing happens on a float RGB buffer. Deterministic — a fixed seed means
 * re-running produces byte-identical art.
 *
 * Design intent: a soft, low-contrast "sakura sky". The theme paints translucent
 * frosted panels over it, so the art must stay bright and gentle — busy, high
 * contrast art would make text unreadable no matter what the panel does.
 *
 *   node tools/generate-wallpaper.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng, hex } from "./png.mjs";

const W = 1920;
const H = 1080;
const SEED = 20261009;

/**
 * Which palette to generate. The theme declares a light *and* a dark variant, so
 * one generator produces both; each run is independent and reproducible.
 *
 *   node tools/generate-wallpaper.mjs            → assets/day.png   (light)
 *   node tools/generate-wallpaper.mjs --night    → assets/night.png (dark)
 */
const SCHEME = process.argv.includes("--night") ? "night" : "day";
const OUT_NAME = SCHEME === "night" ? "night.png" : "day.png";

// ------------------------------------------------------------------- painting

/** Deterministic PRNG so the art is reproducible. */
function mulberry32(a) {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const rand = mulberry32(SEED);
const buf = new Float32Array(W * H * 3);

const smoothstep = (edge0, edge1, x) => {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
};

function blend(x, y, color, alpha) {
	if (alpha <= 0 || x < 0 || x >= W || y < 0 || y >= H) return;
	const i = (y * W + x) * 3;
	const a = alpha > 1 ? 1 : alpha;
	buf[i] += (color[0] - buf[i]) * a;
	buf[i + 1] += (color[1] - buf[i + 1]) * a;
	buf[i + 2] += (color[2] - buf[i + 2]) * a;
}

/** Vertical multi-stop sky gradient. */
function paintSky(stops) {
	for (let y = 0; y < H; y += 1) {
		const t = y / (H - 1);
		let lo = stops[0];
		let hi = stops[stops.length - 1];
		for (let s = 0; s < stops.length - 1; s += 1) {
			if (t >= stops[s].at && t <= stops[s + 1].at) {
				lo = stops[s];
				hi = stops[s + 1];
				break;
			}
		}
		const span = hi.at - lo.at || 1;
		const k = smoothstep(0, 1, (t - lo.at) / span);
		const color = [
			lo.color[0] + (hi.color[0] - lo.color[0]) * k,
			lo.color[1] + (hi.color[1] - lo.color[1]) * k,
			lo.color[2] + (hi.color[2] - lo.color[2]) * k,
		];
		for (let x = 0; x < W; x += 1) {
			const i = (y * W + x) * 3;
			buf[i] = color[0];
			buf[i + 1] = color[1];
			buf[i + 2] = color[2];
		}
	}
}

/** Soft radial glow, added in screen-ish fashion. */
function paintGlow(cx, cy, radius, color, strength) {
	const x0 = Math.max(0, Math.floor(cx - radius));
	const x1 = Math.min(W - 1, Math.ceil(cx + radius));
	const y0 = Math.max(0, Math.floor(cy - radius));
	const y1 = Math.min(H - 1, Math.ceil(cy + radius));
	for (let y = y0; y <= y1; y += 1) {
		for (let x = x0; x <= x1; x += 1) {
			const dx = (x - cx) / radius;
			const dy = (y - cy) / radius;
			const d = Math.sqrt(dx * dx + dy * dy);
			if (d >= 1) continue;
			const falloff = (1 - d) * (1 - d);
			blend(x, y, color, falloff * strength);
		}
	}
}

/** Soft-edged ellipse (clouds, petals, hills). */
function paintEllipse(cx, cy, rx, ry, angle, color, alpha, softness = 0.35) {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const extent = Math.max(rx, ry) * 1.1;
	const x0 = Math.max(0, Math.floor(cx - extent));
	const x1 = Math.min(W - 1, Math.ceil(cx + extent));
	const y0 = Math.max(0, Math.floor(cy - extent));
	const y1 = Math.min(H - 1, Math.ceil(cy + extent));
	for (let y = y0; y <= y1; y += 1) {
		for (let x = x0; x <= x1; x += 1) {
			const px = x - cx;
			const py = y - cy;
			const lx = (px * cos + py * sin) / rx;
			const ly = (-px * sin + py * cos) / ry;
			const d = Math.sqrt(lx * lx + ly * ly);
			if (d >= 1) continue;
			const edge = smoothstep(1, 1 - softness, d);
			blend(x, y, color, alpha * edge);
		}
	}
}

/** Separable box blur, repeated to approximate a gaussian. */
function blurPasses(passes, radius) {
	const tmp = new Float32Array(buf.length);
	for (let p = 0; p < passes; p += 1) {
		// horizontal
		for (let y = 0; y < H; y += 1) {
			for (let c = 0; c < 3; c += 1) {
				let sum = 0;
				const row = y * W * 3 + c;
				for (let x = -radius; x <= radius; x += 1) {
					const sx = Math.min(W - 1, Math.max(0, x));
					sum += buf[row + sx * 3];
				}
				const norm = radius * 2 + 1;
				for (let x = 0; x < W; x += 1) {
					tmp[row + x * 3] = sum / norm;
					const outIdx = Math.min(W - 1, Math.max(0, x - radius));
					const inIdx = Math.min(W - 1, Math.max(0, x + radius + 1));
					sum += buf[row + inIdx * 3] - buf[row + outIdx * 3];
				}
			}
		}
		// vertical
		for (let x = 0; x < W; x += 1) {
			for (let c = 0; c < 3; c += 1) {
				let sum = 0;
				for (let y = -radius; y <= radius; y += 1) {
					const sy = Math.min(H - 1, Math.max(0, y));
					sum += tmp[(sy * W + x) * 3 + c];
				}
				const norm = radius * 2 + 1;
				for (let y = 0; y < H; y += 1) {
					buf[(y * W + x) * 3 + c] = sum / norm;
					const outIdx = Math.min(H - 1, Math.max(0, y - radius));
					const inIdx = Math.min(H - 1, Math.max(0, y + radius + 1));
					sum += tmp[(inIdx * W + x) * 3 + c] - tmp[(outIdx * W + x) * 3 + c];
				}
			}
		}
	}
}

// -------------------------------------------------------------- compose scene
//
// Two palettes come out of this one generator, because the theme declares a
// light *and* a dark variant: a daylight sakura sky, and a moonlit one. Both are
// deliberately soft and low-contrast — the theme lays translucent panels over
// them, so busy art would defeat the panels no matter how they are tuned.

if (SCHEME === "day") {
	paintSky([
		{ at: 0.0, color: hex("#b6c4ff") },
		{ at: 0.34, color: hex("#d9c4f5") },
		{ at: 0.62, color: hex("#ffd2e6") },
		{ at: 0.84, color: hex("#ffe3ee") },
		{ at: 1.0, color: hex("#fff2f7") },
	]);

	// Warm light source top-right, cool counter-glow bottom-left.
	paintGlow(W * 0.78, H * 0.16, W * 0.5, hex("#fff4fa"), 0.5);
	paintGlow(W * 0.14, H * 0.86, W * 0.42, hex("#d8e6ff"), 0.34);

	// Distant hills: soft violet silhouettes near the horizon.
	const hillBase = H * 0.78;
	for (let i = 0; i < 7; i += 1) {
		const cx = (i / 6) * W * 1.2 - W * 0.1 + (rand() - 0.5) * 120;
		const rx = 220 + rand() * 260;
		const ry = 90 + rand() * 70;
		paintEllipse(cx, hillBase + 40 + rand() * 60, rx, ry, 0, hex("#c3b2ee"), 0.3, 0.9);
	}
	for (let i = 0; i < 9; i += 1) {
		const cx = (i / 8) * W * 1.15 - W * 0.08 + (rand() - 0.5) * 140;
		const rx = 180 + rand() * 220;
		const ry = 70 + rand() * 60;
		paintEllipse(cx, hillBase + 130 + rand() * 70, rx, ry, 0, hex("#d3c6f4"), 0.34, 0.9);
	}

	// Clouds: stacked soft ellipses, brighter where they face the light.
	const clouds = [
		{ x: 0.2, y: 0.24, s: 1.0, a: 0.5 },
		{ x: 0.62, y: 0.36, s: 1.25, a: 0.42 },
		{ x: 0.88, y: 0.2, s: 0.85, a: 0.4 },
		{ x: 0.42, y: 0.58, s: 1.1, a: 0.3 },
		{ x: 0.08, y: 0.5, s: 0.8, a: 0.26 },
	];
	for (const cloud of clouds) {
		const cx = cloud.x * W;
		const cy = cloud.y * H;
		const unit = 130 * cloud.s;
		for (let i = 0; i < 9; i += 1) {
			const ox = (rand() - 0.5) * unit * 3.4;
			const oy = (rand() - 0.5) * unit * 0.9;
			paintEllipse(
				cx + ox,
				cy + oy,
				unit * (0.7 + rand() * 0.9),
				unit * (0.3 + rand() * 0.4),
				0,
				hex("#ffffff"),
				cloud.a * (0.55 + rand() * 0.45),
				0.85,
			);
		}
	}

	// Sakura petals drifting across the frame.
	const petalColors = [hex("#ff9ec8"), hex("#ffb6d5"), hex("#ffc9e0"), hex("#f78fbe")];
	for (let i = 0; i < 190; i += 1) {
		const x = rand() * W;
		const y = rand() * H * 0.92;
		const size = 7 + rand() * 15;
		const color = petalColors[Math.floor(rand() * petalColors.length)];
		paintEllipse(
			x,
			y,
			size,
			size * (0.5 + rand() * 0.3),
			rand() * Math.PI,
			color,
			0.3 + rand() * 0.35,
			0.6,
		);
	}

	// Sparkles: small bright points, denser near the light source.
	for (let i = 0; i < 260; i += 1) {
		const bias = rand();
		const x = bias < 0.55 ? rand() * W : rand() * W * 0.5 + W * 0.5;
		const y = rand() * H * 0.85;
		const size = 1.5 + rand() * 3.5;
		paintGlow(x, y, size * 3.2, hex("#ffffff"), 0.5 + rand() * 0.4);
	}
} else {
	// Night: the same composition, moonlit and far dimmer. The palette is kept dark
	// on purpose — a dark scheme pairs it with light text, and a bright wallpaper
	// would destroy that contrast exactly as a dark one would in light mode.
	paintSky([
		{ at: 0.0, color: hex("#0d0819") },
		{ at: 0.3, color: hex("#171029") },
		{ at: 0.58, color: hex("#241740") },
		{ at: 0.82, color: hex("#332154") },
		{ at: 1.0, color: hex("#3d2a60") },
	]);

	// Moon: a wide halo, a tight inner glow, then the disc. Kept well short of
	// white and small in area — it is the brightest thing in the frame, so it sets
	// the worst-case contrast for light text on a translucent dark panel.
	paintGlow(W * 0.76, H * 0.18, W * 0.3, hex("#b9a4ff"), 0.2);
	paintGlow(W * 0.76, H * 0.18, W * 0.08, hex("#ded1f8"), 0.4);
	paintEllipse(W * 0.76, H * 0.18, W * 0.028, W * 0.028, 0, hex("#e4daff"), 0.72, 0.3);

	// Stars: many faint points, a few brighter ones.
	for (let i = 0; i < 420; i += 1) {
		const x = rand() * W;
		const y = rand() * H * 0.84;
		const size = 0.8 + rand() * 2.2;
		paintGlow(x, y, size * 3.2, hex("#ffffff"), 0.28 + rand() * 0.42);
	}

	// Hills: deep silhouettes against the sky.
	const hillBase = H * 0.76;
	for (let i = 0; i < 7; i += 1) {
		const cx = (i / 6) * W * 1.2 - W * 0.1 + (rand() - 0.5) * 120;
		const rx = 220 + rand() * 260;
		const ry = 90 + rand() * 70;
		paintEllipse(cx, hillBase + 40 + rand() * 60, rx, ry, 0, hex("#1b1133"), 0.55, 0.9);
	}
	for (let i = 0; i < 9; i += 1) {
		const cx = (i / 8) * W * 1.15 - W * 0.08 + (rand() - 0.5) * 140;
		const rx = 180 + rand() * 220;
		const ry = 70 + rand() * 60;
		paintEllipse(cx, hillBase + 130 + rand() * 70, rx, ry, 0, hex("#241640"), 0.6, 0.9);
	}

	// Night clouds: dim violet bands drifting in front of the moon.
	const clouds = [
		{ x: 0.22, y: 0.3, s: 1.0, a: 0.3 },
		{ x: 0.64, y: 0.42, s: 1.2, a: 0.24 },
		{ x: 0.86, y: 0.26, s: 0.85, a: 0.22 },
	];
	for (const cloud of clouds) {
		const cx = cloud.x * W;
		const cy = cloud.y * H;
		const unit = 130 * cloud.s;
		for (let i = 0; i < 9; i += 1) {
			const ox = (rand() - 0.5) * unit * 3.4;
			const oy = (rand() - 0.5) * unit * 0.9;
			paintEllipse(
				cx + ox,
				cy + oy,
				unit * (0.7 + rand() * 0.9),
				unit * (0.3 + rand() * 0.4),
				0,
				hex("#3a2a5c"),
				cloud.a * (0.55 + rand() * 0.45),
				0.85,
			);
		}
	}

	// Petals as silhouettes: barely lighter than the sky, so they read as drifting
	// shapes rather than bright confetti.
	const petalColors = [hex("#5f3f66"), hex("#6d4a72"), hex("#7a547c")];
	for (let i = 0; i < 170; i += 1) {
		const x = rand() * W;
		const y = rand() * H * 0.92;
		const size = 7 + rand() * 15;
		const color = petalColors[Math.floor(rand() * petalColors.length)];
		paintEllipse(
			x,
			y,
			size,
			size * (0.5 + rand() * 0.3),
			rand() * Math.PI,
			color,
			0.25 + rand() * 0.3,
			0.6,
		);
	}
}

// Soften everything: the frosted panels sit on top, so a gentle image reads better.
blurPasses(2, 3);

// Fine grain, so large gradients do not band on 8-bit displays.
for (let i = 0; i < buf.length; i += 1) {
	buf[i] += (rand() - 0.5) * 0.012;
}

// ---------------------------------------------------------------------- write

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, OUT_NAME);
fs.writeFileSync(outFile, encodePng(W, H, buf));

const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`wrote ${outFile} (${W}x${H}, ${kb} KiB)`);

// ------------------------------------------------------- readability report
//
// The theme lays translucent frosted panels over this art, so the number that
// matters is not the wallpaper's own contrast but the contrast of themed text
// against the *composited* panel. This simulates that composite over the
// darkest and brightest regions of the image and reports WCAG ratios.

const srgbToLinear = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const relLum = ([r, g, b]) =>
	0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
const contrast = (a, b) => {
	const la = relLum(a);
	const lb = relLum(b);
	const hi = Math.max(la, lb);
	const lo = Math.min(la, lb);
	return (hi + 0.05) / (lo + 0.05);
};
const over = (panel, alpha, bg) => [
	panel[0] * alpha + bg[0] * (1 - alpha),
	panel[1] * alpha + bg[1] * (1 - alpha),
	panel[2] * alpha + bg[2] * (1 - alpha),
];

/** Per-region luminance percentiles of the raw art. */
function regionStats(x0, x1, y0, y1) {
	const lums = [];
	for (let y = y0; y < y1; y += 3) {
		for (let x = x0; x < x1; x += 3) {
			const i = (y * W + x) * 3;
			lums.push([buf[i], buf[i + 1], buf[i + 2]]);
		}
	}
	const sorted = [...lums].sort((p, q) => relLum(p) - relLum(q));
	const at = (p) => sorted[Math.floor((sorted.length - 1) * p)];
	return { min: sorted[0], p05: at(0.05), median: at(0.5), max: sorted[sorted.length - 1] };
}

const regions = {
	sidebar: regionStats(0, 260, 0, H),
	header: regionStats(0, W, 0, 64),
	main: regionStats(300, 1900, 100, 980),
};

// Light scheme: dark text on a near-white panel, so the *darkest* wallpaper
// region is the worst case. Dark scheme: the mirror image — light text on a dark
// panel, worst over the *brightest* region (the moon).
const TEXT = SCHEME === "night" ? hex("#f4e8f5") : hex("#2a2140");
const PANEL = SCHEME === "night" ? hex("#261a32") : hex("#fffafd");
const worstRegion = SCHEME === "night" ? "max" : "min";
const bestRegion = SCHEME === "night" ? "min" : "max";

console.log("\nwallpaper luminance (raw art):");
for (const [name, s] of Object.entries(regions)) {
	const fmt = (c) =>
		`#${c
			.map((v) =>
				Math.round(Math.min(1, Math.max(0, v)) * 255)
					.toString(16)
					.padStart(2, "0"),
			)
			.join("")}`;
	console.log(
		`  ${name.padEnd(8)} min ${fmt(s.min)}  p05 ${fmt(s.p05)}  median ${fmt(s.median)}  max ${fmt(s.max)}`,
	);
}

const fmtRgb = (c) => c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(",");
console.log(`\n${SCHEME} scheme — text rgb(${fmtRgb(TEXT)}) over panel rgb(${fmtRgb(PANEL)}) at alpha:`);
	for (const alpha of [0.5, 0.6, 0.7, 0.78, 0.86]) {
		const worst = Math.min(
			...Object.values(regions).map((s) => contrast(TEXT, over(PANEL, alpha, s[worstRegion]))),
		);
		const best = Math.max(
			...Object.values(regions).map((s) => contrast(TEXT, over(PANEL, alpha, s[bestRegion]))),
		);
	console.log(
		`  alpha ${alpha.toFixed(2)}  worst ${worst.toFixed(2)}:1   best ${best.toFixed(2)}:1   ${
			worst >= 4.5 ? "PASS AA" : worst >= 3 ? "large-text only" : "FAIL"
		}`,
	);
}
