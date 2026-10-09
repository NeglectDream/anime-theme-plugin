/**
 * Derives the animated theme variant from the still one.
 *
 * Two themes exist because the host's asset route derives `Content-Type` from the
 * file extension and serves `nosniff`, so a GIF must be referenced as `.gif`. A
 * single theme cannot point at "whatever the user supplied".
 *
 * Rather than hand-maintaining two copies of ~250 token values (which would drift
 * the moment one is edited), the animated variant is cloned from the still one and
 * only its background paths are rewritten. Run this after editing the still theme.
 *
 *   node tools/build-themes.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(here, "..", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const STILL_ID = "sakura-glass";
const LIVE_ID = "sakura-glass-live";

const themes = manifest.contributes.themes;
const still = themes.find((theme) => theme.id === STILL_ID);
if (!still) throw new Error(`theme "${STILL_ID}" not found in manifest`);

const live = structuredClone(still);
live.id = LIVE_ID;
live.title = "Sakura Glass Live (Anime)";

let rewritten = 0;
for (const scheme of ["light", "dark"]) {
	const background = live.tokens?.[scheme]?.backgrounds?.body;
	if (!background?.image) continue;
	// The still theme's raster extension is whatever the shipped art actually is,
	// so derive the animated path from it rather than assuming one format.
	if (!/\.(png|jpe?g|webp)$/.test(background.image)) {
		throw new Error(`unexpected background for ${scheme}: ${background.image}`);
	}
	background.image = background.image.replace(/\.(png|jpe?g|webp)$/, ".gif");
	rewritten += 1;
}
if (rewritten === 0) throw new Error("no background images were rewritten");

// Still theme first, so it stays the default the settings picker shows on top.
manifest.contributes.themes = [still, live];
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
console.log(`wrote ${LIVE_ID}: ${rewritten} background path(s) rewritten to .gif`);
