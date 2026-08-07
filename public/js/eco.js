// Efficiency mode — a per-device switch for people on expensive, congested or
// throttled connections.
//
// It is not a single knob but a posture applied wherever this app spends data:
// voice notes record at half the bitrate, photos are downscaled and re-encoded
// before upload instead of being sent at full camera resolution, and calls drop
// to a smaller, slower video profile.
//
// Calls are the special case. Video is negotiated per pair, but a call is only as
// cheap as its most constrained participant, so the mode is SHARED: if anybody in
// the call has it on, everyone sends the reduced profile, and the others are told
// who. One person on a bad connection should not have to ask the rest to turn it
// down.
//
// Stored per device rather than per account, because the constraint belongs to
// the network the device is on, not to the person.

const KEY = 'cw_eco';
const listeners = new Set();

let on = false;
try { on = localStorage.getItem(KEY) === '1'; } catch { /* private mode */ }

export function ecoOn() { return on; }

export function setEco(v) {
    on = !!v;
    try {
        if (on) localStorage.setItem(KEY, '1');
        else localStorage.removeItem(KEY);
    } catch { /* private mode: applies to this page only */ }
    for (const fn of listeners) { try { fn(on); } catch { /* listener's problem */ } }
}

// Called when the switch flips, so a live call can renegotiate its bitrate
// without being restarted.
export function onEcoChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// The switch is per device, and a second tab is the same device. Without this the
// two tabs disagree with each other and with what is stored: one keeps uploading
// full-size photos while its own settings screen reads "On".
try {
    window.addEventListener('storage', (ev) => {
        if (ev.key !== KEY && ev.key !== null) return;   // null = storage cleared
        let stored = false;
        try { stored = localStorage.getItem(KEY) === '1'; } catch { /* private mode */ }
        if (stored === on) return;
        on = stored;
        for (const fn of listeners) { try { fn(on); } catch { /* listener's problem */ } }
    });
} catch { /* no window (tests) */ }

/* Image downscaling. A phone photo is routinely 3-6 MB; at 1280px and JPEG q0.7
   the same picture is usually 150-350 KB and still looks right in a chat bubble.
   Only photos are touched — documents, audio and video are passed through
   untouched, since re-encoding those would be lossy in ways the sender did not
   ask for. */
const ECO_MAX_DIM = 1280;
const ECO_QUALITY = 0.7;

export async function shrinkImage(file) {
    if (!on || !/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type || '')) return file;
    try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        try {
            const scale = Math.min(1, ECO_MAX_DIM / Math.max(bmp.width, bmp.height));
            // Already small enough: re-encoding would only lose quality.
            if (scale >= 1) return file;
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(bmp.width * scale);
            canvas.height = Math.round(bmp.height * scale);
            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.fillStyle = '#ffffff';               // JPEG has no alpha
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', ECO_QUALITY));
            // Never send the "shrunk" version if it came out bigger.
            if (!blob || blob.size >= file.size) return file;
            const name = (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
            return new File([blob], name, { type: 'image/jpeg' });
        } finally {
            if (typeof bmp.close === 'function') bmp.close();
        }
    } catch {
        return file;    // undecodable here: send the original rather than nothing
    }
}
