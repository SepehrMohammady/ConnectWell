// Avatar preparation in the browser: decode, centre-crop to a square, downscale
// and re-encode. It runs here because the server deliberately takes no image
// dependency.
//
// This is a convenience, NOT a security control: anything that skips the app can
// post whatever bytes it likes, so the server re-validates every upload itself.

import { t } from './i18n.js';

const AVATAR_PX = 512;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const ACCEPTED = /^image\/(jpeg|png|webp|gif|avif|heic|heif)$/i;

let webpOk = null;
function canEncodeWebp() {
    if (webpOk === null) {
        const c = document.createElement('canvas');
        c.width = 1;
        c.height = 1;
        // toBlob silently emits PNG for a type it cannot encode, so the failure
        // mode of assuming WebP is a needlessly large avatar and no error at all.
        webpOk = c.toDataURL('image/webp').startsWith('data:image/webp');
    }
    return webpOk;
}

async function decode(file) {
    if (typeof createImageBitmap === 'function') {
        try {
            // Phones record rotation in EXIF rather than rotating the pixels, and a
            // canvas ignores that unless asked — otherwise portrait photos arrive
            // lying on their side.
            return await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch { /* older engines reject the options bag */ }
        try {
            return await createImageBitmap(file);
        } catch { /* fall through to the <img> path */ }
    }
    return await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t('img.unreadable'))); };
        img.src = url;
    });
}

// Returns a square Blob ready to upload, or throws with a message fit to show.
export async function makeAvatar(file) {
    if (!file) throw new Error(t('img.none_selected'));
    if (file.type && !ACCEPTED.test(file.type)) throw new Error(t('img.bad_type'));
    if (file.size > MAX_SOURCE_BYTES) throw new Error(t('img.too_large'));

    const bmp = await decode(file);
    try {
        const w = bmp.width || bmp.naturalWidth;
        const h = bmp.height || bmp.naturalHeight;
        if (!w || !h) throw new Error(t('img.unreadable'));

        const canvas = document.createElement('canvas');
        canvas.width = AVATAR_PX;
        canvas.height = AVATAR_PX;
        const ctx = canvas.getContext('2d', { alpha: false });

        // A new canvas is transparent black and JPEG carries no alpha, so without
        // this a transparent PNG flattens to a solid black square. White rather
        // than a theme colour: these bytes are baked once and cannot follow a
        // later switch between light and dark.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
        ctx.imageSmoothingQuality = 'high';

        // Centre-crop the largest square the source contains and scale it straight
        // to the destination, so a 4032x3024 phone photo never needs a full-size
        // intermediate canvas (~48 MB of RGBA, past iOS Safari's canvas limit).
        const side = Math.min(w, h);
        ctx.drawImage(bmp, (w - side) / 2, (h - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);

        const type = canEncodeWebp() ? 'image/webp' : 'image/jpeg';
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
        if (!blob) throw new Error(t('img.process_failed'));
        return blob;
    } finally {
        // ImageBitmap holds decoded pixels until released; the <img> path already
        // revoked its object URL.
        if (typeof bmp.close === 'function') bmp.close();
    }
}
