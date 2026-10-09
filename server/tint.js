/**
 * Derives the theme's colours from the wallpaper.
 *
 * The goal is panels that read as "a touch whiter than the wallpaper" in the
 * light scheme and "a touch blacker" in the dark one, so the art's own hue comes
 * through instead of a fixed pink/violet that fights it.
 *
 * WHAT IS TAKEN FROM THE WALLPAPER: hue, and a damped saturation.
 * WHAT IS NOT: lightness. Lightness is what text contrast rests on, so letting a
 * dark photo drive the light scheme's panel lightness is precisely how a theme
 * becomes unreadable. Pinning lightness per scheme means the audit ratios hold for
 * any image a user drops in — the theme changes colour with the art, but never
 * changes how legible it is.
 *
 * The alpha ladders below are the design's structure (which surface sits above
 * which, and the lit top edge). They stay identical across wallpapers; only the
 * colour they are painted in moves.
 */
import { decodeImage } from "./image-decode.js";

// ------------------------------------------------------------- colour maths

/** r,g,b in 0..1 → h,s,l in 0..1. */
function rgbToHsl(r, g, b) {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return { h: 0, s: 0, l };
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h;
	if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
	else if (max === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	return { h: h / 6, s, l };
}

/** h,s,l in 0..1 → [r,g,b] in 0..255. */
function hslToRgb(h, s, l) {
	if (s === 0) {
		const v = Math.round(l * 255);
		return [v, v, v];
	}
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const channel = (t) => {
		let tt = t;
		if (tt < 0) tt += 1;
		if (tt > 1) tt -= 1;
		if (tt < 1 / 6) return p + (q - p) * 6 * tt;
		if (tt < 1 / 2) return q;
		if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
		return p;
	};
	return [
		Math.round(channel(h + 1 / 3) * 255),
		Math.round(channel(h) * 255),
		Math.round(channel(h - 1 / 3) * 255),
	];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const rgba = ([r, g, b], alpha) => `rgba(${r}, ${g}, ${b}, ${alpha})`;

// -------------------------------------------------------- primary extraction

/**
 * The wallpaper's dominant hue and saturation.
 *
 * A plain average is useless here: averaging a pink sky with a blue sea gives
 * grey, and grey is the one answer that makes every theme look the same. So
 * near-grey, near-black and near-white pixels are dropped, and what remains is
 * averaged *circularly* in hue (hue is an angle — averaging 350° and 10° must
 * give 0°, not 180°), weighted toward saturated mid-tones, which are what people
 * read as "the colour of this picture".
 */
export function extractPrimary(image) {
	const { width, height, rgba: pixels } = image;
	const stepX = Math.max(1, Math.floor(width / 220));
	const stepY = Math.max(1, Math.floor(height / 220));

	let sumX = 0;
	let sumY = 0;
	let weightSum = 0;
	let saturationSum = 0;

	for (let y = 0; y < height; y += stepY) {
		for (let x = 0; x < width; x += stepX) {
			const i = (y * width + x) * 4;
			if (pixels[i + 3] < 128) continue; // transparent
			const { h, s, l } = rgbToHsl(pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255);
			if (l < 0.12 || l > 0.92) continue; // crushed shadows / blown highlights
			if (s < 0.1) continue; // greys carry no hue

			const midness = 1 - Math.abs(l - 0.5) * 2; // peaks at mid lightness
			const weight = s * (0.35 + 0.65 * midness);

			sumX += Math.cos(h * 2 * Math.PI) * weight;
			sumY += Math.sin(h * 2 * Math.PI) * weight;
			weightSum += weight;
			saturationSum += s * weight;
		}
	}

	// A genuinely monochrome wallpaper leaves nothing to take. Fall back to a
	// neutral cool hue at modest saturation rather than inventing a colour.
	if (weightSum < 1e-6) return { h: 0.58, s: 0.3 };

	let h = Math.atan2(sumY, sumX) / (2 * Math.PI);
	if (h < 0) h += 1;
	return { h, s: saturationSum / weightSum };
}

// ------------------------------------------------------------- token ladders

/**
 * Per-scheme constants.
 *
 * `lightness` is the whole trick: the light scheme paints panels just under
 * white and the dark scheme just above black, so the wallpaper's hue shows as a
 * tint rather than as a colour. `saturationCap` keeps a vivid wallpaper from
 * tinting the panels so hard that text contrast collapses.
 */
const SCHEME = {
	light: { lightness: 0.966, saturationCap: 0.3, saturationScale: 0.85, bodyAlpha: 0.36 },
	dark: { lightness: 0.134, saturationCap: 0.38, saturationScale: 0.9, bodyAlpha: 0.56 },
};

/** Surfaces and their alpha ladder. `via` is the lit top edge of the glass. */
const LADDER = {
	main: { from: 0.14, to: 0.08 },
	navbar: { from: 0.38, via: 0.46, viaAt: 8, to: 0.28 },
	header: { from: 0.42, via: 0.52, viaAt: 12, to: 0.32 },
	footer: { from: 0.36, to: 0.26, angle: 0 },
	card: { from: 0.66, via: 0.74, viaAt: 10, to: 0.56 },
	paper: { from: 0.68, via: 0.76, viaAt: 10, to: 0.58 },
	modal: { from: 0.84, via: 0.9, viaAt: 10, to: 0.78 },
	input: { from: 0.7, to: 0.62 },
	inputFocus: { from: 0.86, to: 0.82 },
	menu: { from: 0.86, to: 0.82 },
	menuItemHover: { from: 0.62, to: 0.54, angle: 90 },
	navLink: { from: 0.12, to: 0.06 },
	navLinkHover: { from: 0.44, to: 0.34 },
	navLinkActive: { from: 0.66, to: 0.56, angle: 135, accent: 0.5 },
	actionIcon: { from: 0.42, to: 0.32 },
	actionIconHover: { from: 0.64, to: 0.54 },
	table: { from: 0.62, to: 0.52 },
	tableHeader: { from: 0.66, to: 0.56 },
	code: { from: 0.74, to: 0.66 },
	scrollbar: { from: 0.48, to: 0.38 },
	scrollbarThumb: { from: 0.7, to: 0.7, accent: 0.62 },
	divider: { from: 0.4, to: 0.4, accent: 0.45 },
};

/** Control fills are dark enough for white text; only the hue follows the art. */
const CONTROL = { light: { l: 0.36, s: 0.55 }, dark: { l: 0.33, s: 0.5 } };

/** Panel tint for one scheme, as [r,g,b] and as an hsl basis. */
function panelBase(primary, scheme) {
	const { lightness, saturationCap, saturationScale } = SCHEME[scheme];
	const s = Math.min(primary.s * saturationScale, saturationCap);
	return { h: primary.h, s, l: lightness };
}

/**
 * Build the full token set for both schemes.
 *
 * Each scheme is driven by its own wallpaper: the light scheme follows `day.jpg`
 * and the dark one `night.jpg`. They are separate images with separate palettes,
 * so taking one colour for both would tint the light scheme with a hue that only
 * exists in the night art.
 *
 * `primaries` is `{ light: {h,s}, dark: {h,s} }`; a scheme whose wallpaper is
 * missing falls back to the other's.
 *
 * Shape matches `ThemeTokens` so the result drops straight into the manifest's
 * theme contribution.
 */
export function buildTokens(primaries) {
	const tokens = {};
	const lightPrimary = primaries.light ?? primaries.dark;
	const darkPrimary = primaries.dark ?? primaries.light;

	for (const scheme of ["light", "dark"]) {
		const primary = scheme === "light" ? lightPrimary : darkPrimary;
		const base = panelBase(primary, scheme);
		const { bodyAlpha } = SCHEME[scheme];

		// Panels are painted in the wallpaper's hue; brightness steps inside a
		// gradient are small on purpose — the alpha ladder carries the depth, and a
		// large lightness swing is what makes translucent panels look muddy.
		const at = (deltaL, deltaS = 0) =>
			hslToRgb(base.h, clamp01(base.s + deltaS), clamp01(base.l + deltaL));

		const gradients = {};
		for (const [surface, spec] of Object.entries(LADDER)) {
			const accent = spec.accent;
			// Accent surfaces (active nav item, scrollbar thumb) are pushed toward
			// the wallpaper's own hue at higher saturation so they still read as
			// "selected" rather than as another panel.
			const colourAt = (alpha) => {
				if (accent === undefined) return rgba(at(0), alpha);
				const [r, g, b] = hslToRgb(
					base.h,
					clamp01(Math.max(base.s, accent)),
					scheme === "light" ? 0.72 : 0.42,
				);
				return rgba([r, g, b], alpha);
			};
			const entry = { from: colourAt(spec.from), to: colourAt(spec.to), angle: spec.angle ?? 180 };
			if (spec.via !== undefined) {
				entry.via = rgba(at(0.03), spec.via);
				entry.viaAt = spec.viaAt;
			}
			gradients[surface] = entry;
		}

		const control = CONTROL[scheme];
		const controlBase = hslToRgb(base.h, control.s, control.l);
		const controlLighter = hslToRgb(base.h, control.s, control.l + 0.04);
		const controlDarker = hslToRgb(base.h, control.s, control.l - 0.04);
		gradients.button = { from: rgba(controlBase, 1), to: rgba(controlDarker, 1), angle: 180 };
		gradients.buttonHover = { from: rgba(controlLighter, 1), to: rgba(controlBase, 1), angle: 180 };
		gradients.buttonActive = { from: rgba(controlDarker, 1), to: rgba(controlDarker, 1), angle: 180 };
		gradients.badge = { from: rgba(controlBase, 1), to: rgba(controlDarker, 1), angle: 180 };
		gradients.tooltip =
			scheme === "light"
				? { from: rgba(at(-0.82, -0.05), 0.95), to: rgba(at(-0.86, -0.05), 0.95), angle: 180 }
				: { from: rgba(at(0.8, -0.05), 0.96), to: rgba(at(0.76, -0.05), 0.96), angle: 180 };

		// Text keeps the wallpaper's hue but sits at a lightness that holds contrast
		// against the panels above.
		const textColour =
			scheme === "light"
				? rgba(hslToRgb(base.h, Math.min(base.s * 1.6, 0.34), 0.16), 1)
				: rgba(hslToRgb(base.h, Math.min(base.s * 1.2, 0.22), 0.94), 1);
		const dimText =
			scheme === "light"
				? rgba(hslToRgb(base.h, Math.min(base.s * 1.4, 0.3), 0.24), 1)
				: rgba(hslToRgb(base.h, Math.min(base.s, 0.18), 0.88), 1);

		const textColors = {
			navbar: textColour,
			header: textColour,
			footer: dimText,
			main: textColour,
			card: textColour,
			paper: textColour,
			modal: textColour,
			input: textColour,
			table: textColour,
			tableHeader: textColour,
			menu: textColour,
			menuItem: textColour,
			navLink: textColour,
			actionIcon: dimText,
			code: scheme === "light" ? rgba(hslToRgb(base.h, 0.45, 0.3), 1) : rgba(hslToRgb(base.h, 0.4, 0.86), 1),
			button: "#ffffff",
			buttonHover: "#ffffff",
			buttonActive: "#ffffff",
			badge: "#ffffff",
			// The active nav item sits on a saturated wash: dark text in the light
			// scheme, light text in the dark one.
			navLinkActive:
				scheme === "light"
					? rgba(hslToRgb(base.h, 0.5, 0.2), 1)
					: rgba(hslToRgb(base.h, 0.25, 0.95), 1),
			scrollbarThumb: scheme === "light" ? textColour : rgba(hslToRgb(base.h, 0.2, 0.95), 1),
			// The tooltip flips polarity per scheme — a dark bubble in the light scheme,
			// a light one in the dark scheme — so its text is always the opposite of the
			// bubble, never the scheme's normal text colour.
			tooltip:
				scheme === "light"
					? rgba(hslToRgb(base.h, 0.2, 0.95), 1)
					: rgba(hslToRgb(base.h, 0.3, 0.2), 1),
		};

		// Borders are a soft rim of the panel colour, slightly brighter than the
		// panel itself so it reads as a lit edge rather than a drawn line.
		const rim = scheme === "light" ? at(0.03, -0.05) : at(0.1, -0.05);
		const rimStrong = scheme === "light" ? at(0.035, -0.05) : at(0.13, -0.05);
		const borderAlpha = scheme === "light" ? 0.45 : 0.13;
		const borders = {
			navbar: { width: 1, color: rgba(rim, borderAlpha), edges: ["right"] },
			header: { width: 1, color: rgba(rim, borderAlpha), edges: ["bottom"] },
			footer: { width: 1, color: rgba(rim, borderAlpha), edges: ["top"] },
			card: { width: 1, color: rgba(rim, borderAlpha), inset: true, radius: 16 },
			paper: { width: 1, color: rgba(rim, borderAlpha), inset: true, radius: 16 },
			modal: { width: 1, color: rgba(rimStrong, borderAlpha), inset: true, radius: 18 },
			input: { width: 1, color: rgba(rim, borderAlpha), inset: true, radius: 10 },
			menu: { width: 1, color: rgba(rim, borderAlpha), inset: true, radius: 14 },
			menuItem: { radius: 8 },
			navLink: { radius: 10 },
			navLinkActive: { width: 1, color: rgba(rimStrong, borderAlpha + 0.1), inset: true, radius: 10 },
			badge: { radius: 10 },
			button: { radius: 12 },
			actionIcon: { radius: 10 },
			table: { width: 1, color: rgba(rim, borderAlpha - 0.1), inset: true, radius: 12 },
			tableHeader: { width: 1, color: rgba(rim, borderAlpha - 0.06), edges: ["bottom"] },
			code: { width: 1, color: rgba(rim, borderAlpha - 0.05), inset: true, radius: 8 },
			tooltip: { radius: 10 },
			scrollbarThumb: { radius: 8 },
		};

		tokens[scheme] = {
			primaryColor: rgba(hslToRgb(base.h, control.s + 0.1, control.l), 1).replace(
				/^rgba\((\d+), (\d+), (\d+), 1\)$/,
				(_, r, g, b) =>
					`#${[r, g, b].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`,
			),
			body: rgba(at(0, -0.05), bodyAlpha),
			text: textColour,
			gradients,
			textColors,
			borders,
		};
	}

	return tokens;
}

/** Human-readable summary for the backend log. */
export function describePrimary(primary) {
	return `hue ${Math.round(primary.h * 360)}°, saturation ${(primary.s * 100).toFixed(0)}%`;
}

/**
 * Read the wallpapers in `assetsDir`, derive the theme's colours, and write them
 * into `manifestPath`.
 *
 * Extracted from the backend so it can be tested directly: the interesting logic
 * here is colour derivation, and driving it through a spawned process with an RPC
 * handshake would test the plumbing instead.
 *
 * `readFile` / `writeFile` / `exists` are injected so a test can run it against an
 * in-memory manifest. Returns a summary, or `undefined` when nothing changed.
 */
export function applyTint(options) {
	const {
		assetsDir,
		manifestPath,
		readFile,
		writeFile,
		exists,
		// Names the backend actually wrote, per scheme. An entry is used verbatim —
		// it may be content-addressed (`wallpaper-1a2b3c4d.png`) so that swapping a
		// wallpaper changes the URL and the browser cannot serve a stale copy. A
		// missing entry falls back to scanning `defaults` for whatever ships.
		assets = {},
		defaults = {
			light: "day",
			dark: "night",
			lightLive: "day-live",
			darkLive: "night-live",
		},
		extensions = ["jpg", "jpeg", "png", "webp", "gif"],
		log = () => {},
	} = options;

	/** The asset file actually present for a scheme, or undefined. */
	const findAsset = (scheme) => {
		const applied = assets[scheme];
		if (applied && exists(`${assetsDir}/${applied}`)) return applied;
		const base = defaults[scheme];
		for (const extension of extensions) {
			const name = `${base}.${extension}`;
			if (exists(`${assetsDir}/${name}`)) return name;
		}
		return undefined;
	};

	const primaries = {};
	const resolved = {};
	for (const scheme of ["light", "dark"]) {
		const name = findAsset(scheme);
		if (!name) continue;
		resolved[scheme] = name;
		try {
			primaries[scheme] = extractPrimary(decodeImage(readFile(`${assetsDir}/${name}`)));
		} catch (error) {
			log(`cannot read colours from ${name}: ${error?.message ?? error}`);
		}
	}
	// Animated outputs are referenced but never sampled: the still image is what
	// drives the palette, and a user's gif may not be decodable at all.
	for (const scheme of ["light", "dark"]) {
		const name = findAsset(`${scheme}Live`);
		if (name) resolved[`${scheme}Live`] = name;
	}
	if (!primaries.light && !primaries.dark) return undefined;

	const tokens = buildTokens(primaries);
	let manifest;
	try {
		manifest = JSON.parse(readFile(manifestPath).toString("utf8"));
	} catch (error) {
		log(`cannot read manifest: ${error?.message ?? error}`);
		return undefined;
	}

	let changed = false;
	for (const theme of manifest.contributes?.themes ?? []) {
		// The animated variant reads a `.gif` and is only usable when the user
		// supplied one; it keeps its own path.
		const isAnimated = typeof theme.id === "string" && theme.id.endsWith("-live");
		for (const scheme of ["light", "dark"]) {
			const target = theme.tokens?.[scheme];
			if (!target || !tokens[scheme]) continue;
			// The wallpaper reference belongs to the theme; only colours are derived.
			const backgrounds = target.backgrounds;
			Object.assign(target, tokens[scheme]);
			if (backgrounds) target.backgrounds = backgrounds;
			// Point each theme at whatever file was actually written for its family,
			// so a PNG wallpaper is referenced as `.png` rather than a hard-coded
			// `.jpg`, and the animated theme gets the gif output rather than the
			// still image's name.
			const assetName = resolved[isAnimated ? `${scheme}Live` : scheme];
			if (assetName && target.backgrounds?.body) {
				target.backgrounds.body.image = `assets/${assetName}`;
			}
			changed = true;
		}
	}
	if (!changed) return undefined;

	const next = `${JSON.stringify(manifest, null, "\t")}\n`;
	try {
		if (readFile(manifestPath).toString("utf8") === next) return undefined;
		writeFile(manifestPath, next);
	} catch (error) {
		log(`cannot write manifest: ${error?.message ?? error}`);
		return undefined;
	}

	const summary = {
		light: primaries.light ?? primaries.dark,
		dark: primaries.dark ?? primaries.light,
	};
	log(
		`theme colours now follow the wallpaper — light ${describePrimary(summary.light)}, ` +
			`dark ${describePrimary(summary.dark)}; reload the plugin to apply`,
	);
	return summary;
}
