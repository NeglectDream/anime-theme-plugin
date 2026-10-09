/**
 * Packages the plugin directory into a `.nfplugin` archive (ZIP, v1 format).
 *
 * Zero dependencies — the ZIP container is written by hand, same spirit as the
 * PNG encoder. Every entry is deflated and falls back to stored when deflating
 * would grow it (already-compressed PNGs).
 *
 * Paths are stored with forward slashes and `manifest.json` sits at the archive
 * root, which is what the host's static checks require.
 *
 *   node tools/pack.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

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

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..");
const OUT_DIR = path.resolve(SRC, "..");

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
const OUT = path.join(OUT_DIR, `${manifest.pluginId}-${manifest.version}.nfplugin`);

/**
 * Assets the backend writes into `assets/` at runtime.
 *
 * The theme reads its wallpaper from the package, so a swapped wallpaper lands
 * there as `day-<hash>.jpg` / `night-live-<hash>.gif`. A source tree that has
 * been run locally therefore carries them, and they must not ship: the package
 * carries the `day` / `night` defaults, and the backend recreates any derived
 * file from the drop folder on demand. Shipping them would bloat the archive and
 * freeze one user's picture into the plugin.
 */
const DERIVED_ASSET = /^assets\/[a-z]+(-live)?-[a-f0-9]{8}\.[a-z]+$/;

function walk(dir, base = "") {
	const found = [];
	for (const name of fs.readdirSync(dir).sort()) {
		// Skip dot-prefixed entries: scratch and tooling leftovers (editor state,
		// test sandboxes) must never end up inside a published archive.
		if (name.startsWith(".")) continue;
		const full = path.join(dir, name);
		const rel = base ? `${base}/${name}` : name;
		if (DERIVED_ASSET.test(rel)) continue;
		const stat = fs.statSync(full);
		if (stat.isDirectory()) found.push(...walk(full, rel));
		else found.push({ rel, full, size: stat.size });
	}
	return found;
}

const files = walk(SRC);
const localParts = [];
const centralParts = [];
let offset = 0;

for (const file of files) {
	const data = fs.readFileSync(file.full);
	const crc = crc32(data);
	const deflated = zlib.deflateRawSync(data, { level: 9 });
	const useDeflate = deflated.length < data.length;
	const payload = useDeflate ? deflated : data;
	const method = useDeflate ? 8 : 0;
	const nameBuf = Buffer.from(file.rel, "utf8");

	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0); // local file header signature
	local.writeUInt16LE(20, 4); // version needed
	local.writeUInt16LE(0, 6); // flags
	local.writeUInt16LE(method, 8);
	local.writeUInt16LE(0, 10); // mod time
	local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(payload.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(nameBuf.length, 26);
	local.writeUInt16LE(0, 28); // extra length
	localParts.push(local, nameBuf, payload);

	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0); // central directory signature
	central.writeUInt16LE(20, 4); // version made by
	central.writeUInt16LE(20, 6); // version needed
	central.writeUInt16LE(0, 8); // flags
	central.writeUInt16LE(method, 10);
	central.writeUInt16LE(0, 12);
	central.writeUInt16LE(0x21, 14);
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(payload.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(nameBuf.length, 28);
	central.writeUInt16LE(0, 30); // extra
	central.writeUInt16LE(0, 32); // comment
	central.writeUInt16LE(0, 34); // disk number
	central.writeUInt16LE(0, 36); // internal attrs
	central.writeUInt32LE(0, 38); // external attrs
	central.writeUInt32LE(offset, 42);
	centralParts.push(central, nameBuf);

	offset += local.length + nameBuf.length + payload.length;
}

const centralBuf = Buffer.concat(centralParts);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

fs.writeFileSync(OUT, Buffer.concat([...localParts, centralBuf, eocd]));

const kib = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`packed ${files.length} files → ${OUT} (${kib} KiB)`);
for (const file of files) console.log(`  ${file.rel}  ${(file.size / 1024).toFixed(1)} KiB`);
