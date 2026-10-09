/**
 * Wallpaper manager — plugin backend.
 *
 * WHY THIS EXISTS
 * A theme can only reference images *inside its own package*: the host serves
 * them from the package directory through a path allowlist, and its URL embeds
 * the package hash computed at install time. So "change the wallpaper" normally
 * means "repack the plugin". This process removes that step.
 *
 * The host serves those assets straight off disk with no content cache
 * (`readAsset` re-reads the file per request), so overwriting a file at the fixed
 * asset path is enough — no reinstall, no repack. This backend simply copies a
 * file the user dropped in a well-known folder onto that fixed path.
 *
 *   <narrafork home>/plugins/data/<pluginId>/wallpapers/day.png    → assets/day-<hash>.png
 *   <narrafork home>/plugins/data/<pluginId>/wallpapers/day.gif    → assets/day-live-<hash>.gif
 *   <narrafork home>/plugins/data/<pluginId>/wallpapers/night.png  → assets/night-<hash>.png
 *   <narrafork home>/plugins/data/<pluginId>/wallpapers/night.gif  → assets/night-live-<hash>.gif
 *
 * A slot is named the same in the drop folder and in `assets/`, so the panel's
 * table, the file the user drops in, and the file the theme reads all agree.
 *
 * The `day`/`night` split mirrors the theme's light/dark variants. `png` backs the
 * still theme and `gif` the animated one; the extension has to match the theme's
 * declared path, which is why the two variants exist rather than one theme
 * pointing at whatever the user happened to supply.
 *
 * DELIBERATELY NOT DONE
 * No image decoding or transcoding, and no renaming a file to an extension it
 * does not match. Every candidate is checked against its own magic bytes and
 * rejected on mismatch, so the asset route never depends on a browser sniffing
 * bytes that contradict the Content-Type it sends.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyTint } from "./tint.js";

const PLUGIN_ID = "cn.mcd7.neglectdream.anime-glass";
const PLUGIN_VERSION = "1.5.7";
const PACKAGE_DIGEST = process.env.NF_PLUGIN_PACKAGE_DIGEST;
const RPC_PROTOCOL = "narrafork.rpc/1";
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = MAX_HEADER_BYTES + MAX_FRAME_BYTES + 4;

/** Polling beats fs.watch here: it behaves identically on every platform and a
 * wallpaper is not a latency-sensitive change. */
const SCAN_INTERVAL_MS = 2500;
/**
 * Largest wallpaper the host will actually serve.
 *
 * Not our own number: `PluginUiAssetService` refuses any theme asset over
 * `DEFAULT_PLUGIN_UI_ASSET_MAX_BYTES` (10 MiB) with a 413. Accepting a bigger
 * file here would only move the failure into the browser, where it shows up as a
 * background that silently never loads and nothing says why. Capping it here
 * means the log names the problem while the user is still looking at the folder.
 */
const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024;

// ------------------------------------------------------------------ RPC plumbing

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
let buffer = new Uint8Array(0);
let initialized = false;
let active = false;
let runtimeId;
let generation;

function append(left, right) {
	const next = new Uint8Array(left.byteLength + right.byteLength);
	next.set(left);
	next.set(right, left.byteLength);
	return next;
}

function delimiterIndex(bytes) {
	for (let index = 0; index <= bytes.byteLength - 4; index += 1) {
		if (
			bytes[index] === 13 &&
			bytes[index + 1] === 10 &&
			bytes[index + 2] === 13 &&
			bytes[index + 3] === 10
		) {
			return index;
		}
	}
	return -1;
}

function contentLength(header) {
	let length;
	for (const line of header.split("\r\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) throw new Error("invalid RPC header");
		if (line.slice(0, separator).trim().toLowerCase() !== "content-length") continue;
		if (length !== undefined) throw new Error("duplicate Content-Length header");
		const value = line.slice(separator + 1).trim();
		if (!/^\d+$/.test(value)) throw new Error("invalid Content-Length header");
		length = Number(value);
	}
	if (!Number.isSafeInteger(length)) throw new Error("missing Content-Length header");
	return length;
}

function send(message, callback) {
	const body = encoder.encode(JSON.stringify(message));
	const header = encoder.encode(
		`Content-Length: ${body.byteLength}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
	);
	process.stdout.write(append(header, body), callback);
}

function respond(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function reject(id, code, message, data) {
	send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function object(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

/** Diagnostics go to stderr: stdout carries the RPC frames. */
function log(message) {
	process.stderr.write(`[anime-glass] ${message}\n`);
}

// -------------------------------------------------------------- wallpaper sync

const PACKAGE_DIR = process.cwd();
/**
 * `<home>/plugins/packages/<pluginId>/<version>/<hash>` → `<home>/plugins/data/<pluginId>/wallpapers`.
 * Derived from the working directory rather than an env var so it stays correct
 * when the host's data root is not the default one.
 */
const DROP_DIR = path.resolve(PACKAGE_DIR, "../../../../data", PLUGIN_ID, "wallpapers");
const ASSETS_DIR = path.join(PACKAGE_DIR, "assets");

/**
 * The two wallpaper slots.
 *
 * The drop-folder name and the asset name are deliberately the same (`day.*` →
 * `assets/day.*`) so the panel's table, the file a user drops in, and the file
 * the theme reads all speak one vocabulary. The animated variant is the same
 * slot with a `-live` suffix on the asset side only.
 */
const SLOTS = [
	{ name: "day", scheme: "light" },
	{ name: "night", scheme: "dark" },
];

/** Extensions accepted, and the exact magic-byte signature each one must carry. */
function detectFormat(bytes) {
	const at = (i) => bytes[i];
	if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
		return "png";
	}
	if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) {
		return "gif";
	}
	if (
		bytes.length >= 12 &&
		at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
		at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
	) {
		return "webp";
	}
	if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpeg";
	return undefined;
}

/**
 * Accepted source extensions → the asset extension the file lands on, plus the
 * real format its bytes must carry.
 *
 * These mirror the themes' declared background paths exactly: the still theme
 * reads `.jpg`, the animated one `.gif`. Copying some other extension would write
 * a file no theme loads, so anything else is reported instead of silently ignored.
 * `jpeg` is accepted as an alias and lands on `.jpg`.
 */
/**
 * Accepted source extensions, split by the theme family each one feeds.
 *
 * The still theme and the animated one are separate themes that may both be
 * installed, so one slot can legitimately hold a still image AND a gif. They are
 * applied as two independent outputs instead of competing for a single file.
 */
const STILL_EXTENSIONS = { png: "png", webp: "webp", jpg: "jpeg", jpeg: "jpeg" };
const ANIMATED_EXTENSIONS = { gif: "gif" };

/** Every extension a drop-folder slot may use, for occupancy checks. */
const ACCEPTED_EXTENSIONS = { ...STILL_EXTENSIONS, ...ANIMATED_EXTENSIONS };

/**
 * Which still image wins when one slot holds several.
 *
 * The plugin seeds a `.jpg`, so a `.png` dropped beside it must win — otherwise
 * the shipped default silently shadows the file the user just added. Iterating
 * the extension map's own key order does the opposite: `jpg` is declared after
 * `png`, and the last one applied used to overwrite the first.
 */
const STILL_PRIORITY = ["png", "webp", "jpg", "jpeg"];

/**
 * Marker written after the first seed.
 *
 * Without it, deleting the seeded `day.jpg` to replace it with `day.png` makes
 * the slot look empty to the next scan, which seeds a fresh `day.jpg` right back
 * — and the default then wins over the user's file. Seeding is a once-per-folder
 * action, so it is recorded rather than inferred from the folder being empty.
 */
const SEED_MARKER = ".seeded";

const lastApplied = new Map();

/**
 * Asset file name currently backing each scheme, or undefined while the package
 * default is still in place. `applyTint` needs the real name because user
 * wallpapers land on a content-addressed file (see `contentHash`).
 */
const appliedAssets = { light: undefined, dark: undefined, lightLive: undefined, darkLive: undefined };

/**
 * Content hash for the asset file name.
 *
 * The theme-asset URL carries the *package* hash, which does not move when a
 * user swaps a wallpaper, and the route is served `immutable`. With a fixed
 * `wallpaper.jpg` the browser therefore answers from cache forever and the new
 * picture never appears — and no amount of disabling/re-enabling the plugin
 * helps, because that does not change the package hash either.
 *
 * Putting the content hash in the file NAME is the one lever available: the URL
 * changes exactly when the bytes do. A `?v=` query string is not an option,
 * because the host's `isSafeAssetPath` rejects `?` outright.
 */
function contentHash(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/**
 * Remove asset files this plugin previously wrote for `output`, so repeated
 * wallpaper swaps do not accumulate in the package.
 *
 * Only content-addressed names are touched (`wallpaper-<hash>.<ext>`), and only
 * the extensions belonging to this output: the still and animated outputs share
 * a target prefix, so pruning by prefix alone would delete the animated theme's
 * gif the moment a still wallpaper was applied. The package's own un-hashed
 * defaults are never deleted — they are the fallback the theme points at when no
 * wallpaper has been applied.
 */
function pruneStaleAssets(output, keep, extensions) {
	let entries;
	try {
		entries = fs.readdirSync(ASSETS_DIR);
	} catch {
		return;
	}
	const ours = new RegExp(`^${output}-[a-f0-9]{8}\\.(${extensions.join("|")})$`);
	for (const entry of entries) {
		if (entry === keep || !ours.test(entry)) continue;
		try {
			fs.unlinkSync(path.join(ASSETS_DIR, entry));
			log(`removed superseded asset ${entry}`);
		} catch (error) {
			log(`cannot remove ${entry}: ${error?.message ?? error}`);
		}
	}
}

/**
 * Copy the package's own wallpapers into the drop folder on first run.
 *
 * Without this the folder starts empty and the panel's job — telling the user
 * what to put where — is the only way to discover the expected names, with no
 * working example to look at. Seeding leaves a real, replaceable pair in place.
 *
 * A slot is skipped as soon as the folder holds a `day.*` / `night.*` of any
 * accepted extension, so this can never overwrite a wallpaper the user supplied.
 * The marker file then makes it a once-per-folder action, so replacing the
 * seeded file (deleting `day.jpg` to add `day.png`, say) is not undone by the
 * next scan seeding the default straight back.
 */
function seedDropFolder() {
	if (fs.existsSync(path.join(DROP_DIR, SEED_MARKER))) return;

	let entries;
	try {
		entries = new Set(fs.readdirSync(DROP_DIR));
	} catch {
		return;
	}

	let seeded = false;
	for (const { name } of SLOTS) {
		const occupied = Object.keys(ACCEPTED_EXTENSIONS).some((extension) =>
			entries.has(`${name}.${extension}`),
		);
		if (occupied) continue;

		// Copy whichever format the package currently ships for this slot.
		for (const extension of Object.keys(ACCEPTED_EXTENSIONS)) {
			const shipped = path.join(ASSETS_DIR, `${name}.${extension}`);
			if (!fs.existsSync(shipped)) continue;
			try {
				fs.copyFileSync(shipped, path.join(DROP_DIR, `${name}.${extension}`));
				log(`seeded ${name}.${extension} from the package default`);
				seeded = true;
			} catch (error) {
				log(`cannot seed ${name}.${extension}: ${error?.message ?? error}`);
			}
			break;
		}
	}

	try {
		fs.writeFileSync(
			path.join(DROP_DIR, SEED_MARKER),
			"Written after the plugin seeded its default wallpapers.\n" +
				"Delete this file to have the defaults copied in again.\n",
		);
		if (seeded) log("seeding recorded; defaults will not be re-copied");
	} catch (error) {
		log(`cannot write ${SEED_MARKER}: ${error?.message ?? error}`);
	}
}

/**
 * Apply one slot → output pair.
 *
 * A slot feeds two independent outputs — the still theme and the animated one —
 * so this runs once per output rather than once per slot. Exactly ONE file is
 * applied per output: when a slot holds several extensions the first in
 * `extensions` wins and the rest are reported, because applying them all in turn
 * lets whichever extension happens to be declared last silently overwrite the
 * user's choice.
 */
function applySlot({ name, scheme, kind, output, extensions }) {
	const present = extensions.filter((extension) => {
		try {
			return fs.statSync(path.join(DROP_DIR, `${name}.${extension}`)).isFile();
		} catch {
			return false;
		}
	});
	if (present.length === 0) return;

	const winner = present[0];
	for (const loser of present.slice(1)) {
		log(`ignoring ${name}.${loser}: ${name}.${winner} takes precedence`);
	}

	const info = fs.statSync(path.join(DROP_DIR, `${name}.${winner}`));
	const key = `${kind}:${name}`;
	const stamp = `${winner}:${info.size}:${info.mtimeMs}`;
	if (lastApplied.get(key) === stamp) return;
	if (lastApplied.get(`${key}:rejected`) === stamp) return;

	/** Report once, then stay quiet until the file changes again. */
	const reject = (reason) => {
		log(reason);
		lastApplied.set(`${key}:rejected`, stamp);
	};

	if (info.size > MAX_WALLPAPER_BYTES) {
		reject(
			`${name}.${winner} is ${(info.size / 1048576).toFixed(1)} MiB — the host serves theme ` +
				`assets up to ${(MAX_WALLPAPER_BYTES / 1048576).toFixed(0)} MiB, so this would never load; ` +
				`compress it and drop it back in`,
		);
		return;
	}

	let bytes;
	try {
		bytes = fs.readFileSync(path.join(DROP_DIR, `${name}.${winner}`));
	} catch (error) {
		reject(`skip ${name}.${winner}: ${error?.message ?? error}`);
		return;
	}

	// Trust the bytes, not the name. A mismatched file is reported and left alone
	// rather than renamed, so the asset route never serves a body that contradicts
	// its own Content-Type.
	const expected = (kind === "live" ? ANIMATED_EXTENSIONS : STILL_EXTENSIONS)[winner];
	const format = detectFormat(bytes);
	if (format !== expected) {
		reject(
			`skip ${name}.${winner}: contents are ${format ?? "not a recognized image"}, expected ${expected}`,
		);
		return;
	}

	// Land on the extension of the file's *real* format, so the asset route's
	// Content-Type always agrees with the bytes it serves. `applyTint` then
	// rewrites the theme's image path to this name.
	const assetExtension = format === "jpeg" ? "jpg" : format;
	// Content-addressed name: swapping the wallpaper changes the URL, which is what
	// makes the new picture appear without a hard refresh.
	const assetName = `${output}-${contentHash(bytes)}.${assetExtension}`;
	try {
		fs.writeFileSync(path.join(ASSETS_DIR, assetName), bytes);
		pruneStaleAssets(output, assetName, kind === "live" ? ["gif"] : ["png", "jpg", "webp"]);
		appliedAssets[kind === "live" ? `${scheme}Live` : scheme] = assetName;
		lastApplied.set(key, stamp);
		lastApplied.delete(`${key}:rejected`);
		log(`applied ${name}.${winner} → assets/${assetName} (${(bytes.length / 1024).toFixed(0)} KiB)`);
	} catch (error) {
		log(`cannot write ${assetName}: ${error?.message ?? error}`);
	}
}

function syncOnce() {
	let created = false;
	try {
		fs.mkdirSync(DROP_DIR, { recursive: true });
		created = true;
	} catch (error) {
		log(`cannot prepare ${DROP_DIR}: ${error?.message ?? error}`);
		return;
	}
	if (created) log(`wallpaper folder: ${DROP_DIR}`);

	// Seed before scanning so a fresh install gets a working pair in the same pass.
	seedDropFolder();

	for (const { name, scheme } of SLOTS) {
		// The still image, highest-priority extension first.
		applySlot({ name, scheme, kind: "still", output: name, extensions: STILL_PRIORITY });
		// The gif. It feeds the animated theme, so it gets its own output name
		// instead of overwriting the still image's file.
		applySlot({ name, scheme, kind: "live", output: `${name}-live`, extensions: ["gif"] });
	}

	retintFromWallpapers();
}

/** Where the theme's derived colours are written back to. */
const MANIFEST_PATH = path.join(PACKAGE_DIR, "manifest.json");

/**
 * Re-derive the theme's colours from whatever wallpapers are in place.
 *
 * Runs after every sync, but the manifest is only rewritten when the derived
 * colours actually change, so a steady state costs one read and one compare.
 *
 * The host recompiles theme CSS by re-reading this manifest during a catalog
 * refresh, and only an install/enable/disable can trigger one — a plugin cannot
 * ask for it. So new colours land when the user reloads the plugin.
 */
function retintFromWallpapers() {
	applyTint({
		assetsDir: ASSETS_DIR,
		manifestPath: MANIFEST_PATH,
		readFile: (file) => fs.readFileSync(file),
		writeFile: (file, data) => fs.writeFileSync(file, data),
		exists: (file) => fs.existsSync(file),
		// Keys are file extensions; values are the format each must contain.
		extensions: Object.keys(ACCEPTED_EXTENSIONS),
		// Names the backend actually wrote. Undefined falls back to the package
		// default, which is what keeps the theme working before any swap.
		assets: appliedAssets,
		defaults: {
			light: "day",
			dark: "night",
			lightLive: "day-live",
			darkLive: "night-live",
		},
		log,
	});
}

let scanTimer;
function startScanning() {
	syncOnce();
	if (scanTimer) return;
	scanTimer = setInterval(() => {
		try {
			syncOnce();
		} catch (error) {
			log(`scan failed: ${error?.message ?? error}`);
		}
	}, SCAN_INTERVAL_MS);
	// Never hold the host process open on our account.
	if (typeof scanTimer.unref === "function") scanTimer.unref();
}

// --------------------------------------------------------------- request handling

function handleRequest(message) {
	const params = object(message.params);
	switch (message.method) {
		case "initialize": {
			if (params?.protocol !== RPC_PROTOCOL || params.pluginId !== PLUGIN_ID) {
				reject(message.id, -32602, "initialize identity or protocol mismatch", {
					code: "INVALID_PARAMS",
				});
				return;
			}
			runtimeId = typeof params.runtimeId === "string" ? params.runtimeId : undefined;
			generation = typeof params.generation === "number" ? params.generation : undefined;
			initialized = true;
			respond(message.id, { initialized: true, protocol: RPC_PROTOCOL });
			return;
		}
		case "activate":
			if (!initialized) {
				reject(message.id, -32603, "Plugin must be initialized before activation");
				return;
			}
			active = true;
			respond(message.id, { activated: true });
			startScanning();
			return;
		case "health":
			respond(message.id, {
				healthy: initialized && active,
				status: active ? "ready" : "inactive",
				runtimeId,
				generation,
			});
			return;
		case "deactivate":
			active = false;
			respond(message.id, { deactivated: true });
			return;
		case "shutdown":
			active = false;
			initialized = false;
			if (scanTimer) clearInterval(scanTimer);
			send({ jsonrpc: "2.0", id: message.id, result: { shutdown: true } }, () => {
				process.exit(0);
			});
			return;
		default:
			reject(message.id, -32601, `Unknown method: ${message.method}`, {
				code: "METHOD_NOT_FOUND",
			});
	}
}

function handleMessage(message) {
	if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
	if (!("id" in message)) return;
	handleRequest(message);
}

function parseFrames() {
	while (buffer.byteLength > 0) {
		const delimiter = delimiterIndex(buffer);
		if (delimiter < 0) {
			if (buffer.byteLength > MAX_HEADER_BYTES) throw new Error("RPC header exceeds limit");
			return;
		}
		if (delimiter > MAX_HEADER_BYTES) throw new Error("RPC header exceeds limit");
		const length = contentLength(decoder.decode(buffer.slice(0, delimiter)));
		if (length > MAX_FRAME_BYTES) throw new Error("RPC frame exceeds limit");
		const bodyStart = delimiter + 4;
		const frameEnd = bodyStart + length;
		if (buffer.byteLength < frameEnd) return;
		const message = JSON.parse(decoder.decode(buffer.slice(bodyStart, frameEnd)));
		buffer = buffer.slice(frameEnd);
		handleMessage(message);
	}
}

process.stdin.on("data", (chunk) => {
	try {
		buffer = append(buffer, new Uint8Array(chunk));
		if (buffer.byteLength > MAX_BUFFER_BYTES) throw new Error("RPC input buffer exceeds limit");
		parseFrames();
	} catch (error) {
		log(`fatal: ${error?.message ?? error}`);
		process.exit(2);
	}
});

process.stdin.on("end", () => process.exit(0));

// Keep the process alive even if the host never activates us.
process.stdin.resume();

send({
	jsonrpc: "2.0",
	method: "hello",
	params: {
		pluginId: PLUGIN_ID,
		version: PLUGIN_VERSION,
		rpcProtocol: RPC_PROTOCOL,
		...(PACKAGE_DIGEST ? { packageDigest: PACKAGE_DIGEST } : {}),
		features: [],
	},
});
