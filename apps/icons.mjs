// Derives every app icon from one source: logo/adaptive-icon.png, the dark mark
// on a transparent 1024x1024 canvas. Run it again after changing the logo:
//
//     node apps/icons.mjs
//
// Plain Node with no image library, in keeping with the rest of the project: a
// minimal PNG reader and writer over node:zlib (8-bit RGB/RGBA, which is all
// the source ever is) and an area-averaging resize that keeps thin strokes
// intact at 16 px.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(ROOT, ...p);

/* ---------------- PNG ---------------- */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(file) {
    const buf = fs.readFileSync(file);
    if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error(file + ' is not a PNG');
    let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
    const idat = [];
    for (let off = 8; off < buf.length;) {
        const len = buf.readUInt32BE(off);
        const kind = buf.toString('ascii', off + 4, off + 8);
        const body = buf.subarray(off + 8, off + 8 + len);
        if (kind === 'IHDR') {
            width = body.readUInt32BE(0); height = body.readUInt32BE(4);
            depth = body[8]; type = body[9]; interlace = body[12];
        } else if (kind === 'IDAT') idat.push(body);
        else if (kind === 'IEND') break;
        off += 12 + len;
    }
    if (depth !== 8 || interlace !== 0 || (type !== 6 && type !== 2)) {
        throw new Error(file + ': only 8-bit, non-interlaced RGB or RGBA is supported');
    }
    const bpp = type === 6 ? 4 : 3;
    const stride = width * bpp;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const data = new Float32Array(width * height * 4);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const cur = new Uint8Array(stride);
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? cur[x - bpp] : 0;
            const b = prev[x];
            const c = x >= bpp ? prev[x - bpp] : 0;
            let v = line[x];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
            }
            cur[x] = v & 255;
        }
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            data[o] = cur[x * bpp] / 255;
            data[o + 1] = cur[x * bpp + 1] / 255;
            data[o + 2] = cur[x * bpp + 2] / 255;
            data[o + 3] = bpp === 4 ? cur[x * bpp + 3] / 255 : 1;
        }
        prev = cur;
    }
    return { width, height, data };
}

function chunk(kind, body) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(kind, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed));
    return Buffer.concat([len, typed, crc]);
}

function writePng(file, img) {
    const { width, height, data } = img;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        const row = y * (width * 4 + 1);
        for (let i = 0; i < width * 4; i++) {
            raw[row + 1 + i] = Math.round(Math.min(1, Math.max(0, data[y * width * 4 + i])) * 255);
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6;               // 8-bit RGBA, no interlace
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat([
        SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
    ]));
    console.log('  ' + path.relative(ROOT, file).replace(/\\/g, '/') + `  ${width}x${height}`);
}

/* ---------------- image operations ----------------
   Pixels are straight (not premultiplied) RGBA floats in 0..1. */

const blank = (width, height) => ({ width, height, data: new Float32Array(width * height * 4) });

function hex(color) {
    const n = parseInt(color.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// The smallest box holding anything visible.
function bounds(img) {
    let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
            if (img.data[(y * img.width + x) * 4 + 3] > 0.02) {
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        }
    }
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function crop(img, { x, y, w, h }) {
    const out = blank(w, h);
    for (let j = 0; j < h; j++) {
        out.data.set(img.data.subarray(((y + j) * img.width + x) * 4, ((y + j) * img.width + x + w) * 4), j * w * 4);
    }
    return out;
}

// Area average in premultiplied space, so transparent pixels cannot bleed their
// (meaningless) colour into the edge of the mark.
function resize(img, w, h) {
    const out = blank(w, h);
    const sx = img.width / w, sy = img.height / h;
    for (let y = 0; y < h; y++) {
        const fy0 = y * sy, fy1 = fy0 + sy;
        for (let x = 0; x < w; x++) {
            const fx0 = x * sx, fx1 = fx0 + sx;
            let r = 0, g = 0, b = 0, a = 0, area = 0;
            for (let yy = Math.floor(fy0); yy < Math.ceil(fy1); yy++) {
                const wy = Math.min(fy1, yy + 1) - Math.max(fy0, yy);
                for (let xx = Math.floor(fx0); xx < Math.ceil(fx1); xx++) {
                    const wgt = wy * (Math.min(fx1, xx + 1) - Math.max(fx0, xx));
                    const o = (yy * img.width + xx) * 4;
                    const pa = img.data[o + 3] * wgt;
                    r += img.data[o] * pa; g += img.data[o + 1] * pa; b += img.data[o + 2] * pa;
                    a += pa; area += wgt;
                }
            }
            const o = (y * w + x) * 4;
            if (a > 0) { out.data[o] = r / a; out.data[o + 1] = g / a; out.data[o + 2] = b / a; }
            out.data[o + 3] = a / area;
        }
    }
    return out;
}

function tint(img, color) {
    const [r, g, b] = hex(color);
    const out = blank(img.width, img.height);
    for (let i = 0; i < img.data.length; i += 4) {
        out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = img.data[i + 3];
    }
    return out;
}

// Source-over, at an integer offset.
function place(dst, src, ox, oy) {
    for (let y = 0; y < src.height; y++) {
        const dy = y + oy;
        if (dy < 0 || dy >= dst.height) continue;
        for (let x = 0; x < src.width; x++) {
            const dx = x + ox;
            if (dx < 0 || dx >= dst.width) continue;
            const s = (y * src.width + x) * 4, d = (dy * dst.width + dx) * 4;
            const sa = src.data[s + 3];
            if (sa <= 0) continue;
            const da = dst.data[d + 3];
            const oa = sa + da * (1 - sa);
            for (let k = 0; k < 3; k++) {
                dst.data[d + k] = (src.data[s + k] * sa + dst.data[d + k] * da * (1 - sa)) / oa;
            }
            dst.data[d + 3] = oa;
        }
    }
    return dst;
}

// A shape given by an inside() test, anti-aliased by 4x4 supersampling.
function shape(width, height, color, inside) {
    const [r, g, b] = hex(color);
    const out = blank(width, height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let hits = 0;
            for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
                if (inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4)) hits++;
            }
            if (!hits) continue;
            const o = (y * width + x) * 4;
            out.data[o] = r; out.data[o + 1] = g; out.data[o + 2] = b; out.data[o + 3] = hits / 16;
        }
    }
    return out;
}

function roundedSquare(size, radius, color) {
    return shape(size, size, color, (px, py) => {
        const cx = Math.min(Math.max(px, radius), size - radius);
        const cy = Math.min(Math.max(py, radius), size - radius);
        return (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius;
    });
}

const disc = (size, cx, cy, radius, color) => shape(size, size, color,
    (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius);

// The mark scaled to `markWidth` px wide, centred on a `size` px square canvas.
function centred(mark, size, markWidth, background = null) {
    const w = Math.max(1, Math.round(markWidth));
    const h = Math.max(1, Math.round(mark.height * (w / mark.width)));
    const canvas = background || blank(size, size);
    return place(canvas, resize(mark, w, h), Math.round((size - w) / 2), Math.round((size - h) / 2));
}

/* ---------------- the assets ---------------- */

const DARK = '#44464e';      // the mark as drawn on light surfaces
const LIGHT = '#e8ebf0';     // the mark on dark surfaces (the splash, dark taskbars)
const RED = '#e5484d';

const source = readPng(at('logo', 'adaptive-icon.png'));
const mark = crop(source, bounds(source));
const dark = tint(mark, DARK);
const light = tint(mark, LIGHT);
const white = tint(mark, '#ffffff');

// The everyday app icon: the dark mark on a white rounded tile.
const tile = (size) => centred(dark, size, size * 0.62, roundedSquare(size, size * 0.2, '#ffffff'));

console.log('web');
// Status-bar icon for notifications shown by the browser: only the alpha
// channel is used, so it is the mark in white.
writePng(at('public', 'badge-96.png'), centred(white, 96, 84));

console.log('android');
const RES = at('apps', 'android', 'app', 'src', 'main', 'res');
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, scale] of Object.entries(DENSITIES)) {
    // 24dp status-bar icon, white on transparent as Android requires.
    writePng(path.join(RES, `drawable-${name}`, 'ic_notification.png'), centred(white, 24 * scale, 22 * scale));
    // Launchers that predate adaptive icons (Android 7) get the finished tile.
    writePng(path.join(RES, `mipmap-${name}`, 'ic_launcher.png'), tile(48 * scale));
    // Adaptive icon foreground, 108dp. The mark stays inside the 66dp circle
    // that every launcher mask leaves visible.
    writePng(path.join(RES, `mipmap-${name}`, 'ic_launcher_foreground.png'), centred(dark, 108 * scale, 52 * scale));
    // Shown while the web app loads, on the dark background colour.
    writePng(path.join(RES, `drawable-${name}`, 'splash.png'), centred(light, 128 * scale, 100 * scale));
}

console.log('desktop');
const DESK = at('apps', 'desktop');
writePng(path.join(DESK, 'build', 'icon.png'), tile(512));           // installer and .exe
writePng(path.join(DESK, 'assets', 'app.png'), tile(256));           // window and notifications
// Tray: Windows draws it on the taskbar, which may be dark or light, so there
// is one of each — plus a variant with a dot for unread messages.
for (const [name, ink] of [['light', light], ['dark', dark]]) {
    for (const [suffix, size] of [['', 16], ['@2x', 32]]) {
        writePng(path.join(DESK, 'assets', `tray-${name}${suffix}.png`), centred(ink, size, size * 0.94));
        const unread = centred(ink, size, size * 0.94);
        place(unread, disc(size, size * 0.78, size * 0.22, size * 0.22, RED), 0, 0);
        writePng(path.join(DESK, 'assets', `tray-${name}-unread${suffix}.png`), unread);
    }
}
