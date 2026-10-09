/**
 * Procedurally generates the nine-slice "glass edge" bitmap used by the theme's
 * `frames` tokens (cards, modals, buttons, inputs, menus).
 *
 * The point of this asset is the frosted-glass look the theme cannot express in
 * tokens: `backdrop-filter` is not in the whitelist, so the glass *illusion* has
 * to come from painted art. A frame gives a bright rim that fades inward and
 * picks up a faint pink cast toward the lower-right, which is what reads as a
 * lit glass edge rather than a flat 1px border.
 *
 *   node tools/generate-frame.mjs
 *
 * Geometry: 64x64 with a 20px slice. The centre 24x24 region stays fully
 * transparent so the panel's own translucent wash shows through unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePngRgba } from "./png.mjs";

const SIZE = 64;
const SLICE = 20;

const rgba = new Float32Array(SIZE * SIZE * 4);

// Lit from the upper-left: the rim is brightest there and picks up a pink cast
// as it travels toward the lower-right.
const RIM = [1, 1, 1];
const WARM = [1, 0.88, 0.95];

for (let y = 0; y < SIZE; y += 1) {
	for (let x = 0; x < SIZE; x += 1) {
		const edge = Math.min(x, y, SIZE - 1 - x, SIZE - 1 - y);
		const i = (y * SIZE + x) * 4;

		if (edge >= SLICE) {
			// Centre: fully transparent, so `fill` is never needed.
			rgba[i + 3] = 0;
			continue;
		}

		const t = edge / SLICE; // 0 at the outer edge, 1 at the inner boundary
		const diagonal = (x + y) / (SIZE * 2 - 2); // 0 upper-left .. 1 lower-right

		// A crisp outer highlight, then a soft falloff inward.
		const falloff = (1 - t) ** 1.7;
		let alpha = falloff * 0.8;
		if (edge < 1) alpha = 0.95;
		else if (edge < 2) alpha = Math.max(alpha, 0.7);

		const warm = 0.15 + diagonal * 0.4;
		rgba[i] = RIM[0] * (1 - warm) + WARM[0] * warm;
		rgba[i + 1] = RIM[1] * (1 - warm) + WARM[1] * warm;
		rgba[i + 2] = RIM[2] * (1 - warm) + WARM[2] * warm;
		rgba[i + 3] = alpha;
	}
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "glass-frame.png");
fs.writeFileSync(outFile, encodePngRgba(SIZE, SIZE, rgba));

console.log(`wrote ${outFile} (${SIZE}x${SIZE}, slice ${SLICE})`);
