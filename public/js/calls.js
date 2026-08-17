// Audio/video calls: WebRTC mesh (1:1 and small groups) with perfect
// negotiation per peer. Signaling rides the app WebSocket ('rtc' events).

import { api } from './api.js';
import { t } from './i18n.js';
import { ecoOn, onEcoChange } from './eco.js';
import {
    S, $, h, net, toast, avatarEl, userName, convTitle, ringStart, ringStop,
    ringbackStart, ringbackStop, userById, userAvatar, convAvatarSrc,
} from './core.js';

let iceServers = null;
async function getIce() {
    if (!iceServers) {
        try { iceServers = (await api('api/ice')).iceServers; }
        catch { iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }]; }
    }
    return iceServers;
}

let cur = null;   // { callId, convId, kind, local, peers, timer, startedAt, facing, pinLocal }
let ring = null;  // { callId, convId, kind, from, timeout }

const inCall = () => !!cur;

/* ---------------- media ----------------
   Bandwidth is capped deliberately. Left alone, WebRTC negotiates whatever the
   link will bear — a reported 30-minute call moved ~1.5 GB, i.e. ~6.7 Mbps
   counting both directions, which is punishing on mobile data. Two limits do the
   work: the capture constraints keep the encoder from starting at a large
   resolution/frame rate, and applyEncodingCaps() puts a hard ceiling on what the
   sender transmits.

   Sizing it honestly, because these numbers get quoted:
     - maxBitrate bounds MEDIA in ONE direction. It excludes RTP/UDP/IP/SRTP
       headers (~10% on video, and far more on audio, whose packets are small).
     - So 500 + 32 kbps out is ~585 kbps on the wire, and a 1:1 call receives
       about the same again — roughly 1.2 Mbps combined, ~260 MB per 30 minutes.
     - That is ~5.5x less than before, not 12x. Both parties need this build:
       a cap only limits what THIS side sends.
     - On a relayed (TURN) leg coturn adds its own per-packet header on top. */

const VIDEO_CAPTURE = {
    width: { ideal: 640, max: 1280 },
    height: { ideal: 360, max: 720 },
    frameRate: { ideal: 24, max: 30 },
};
const VIDEO_KBPS = 500;       // per peer, before the mesh split below
const VIDEO_MIN_KBPS = 150;   // never degrade past unwatchable
const AUDIO_KBPS = 32;        // speech; Opus sounds fine well under this
const MAX_FPS = 24;

/* Efficiency mode. One participant on a bad link cannot fix anything alone: what
   arrives at their device is what the OTHERS send. So the flag is shared — if
   anybody in the call turns it on, every client drops to this profile, roughly a
   quarter of the normal bitrate (~55 MB per 30 minutes on a 1:1 video call). */
const ECO_VIDEO_CAPTURE = {
    width: { ideal: 320, max: 640 },
    height: { ideal: 180, max: 360 },
    frameRate: { ideal: 15, max: 15 },
};
const ECO_VIDEO_KBPS = 120;
const ECO_VIDEO_MIN_KBPS = 60;
const ECO_AUDIO_KBPS = 16;
const ECO_MAX_FPS = 15;

// True when THIS call is in efficiency mode, which is not the same as this
// device having the switch on: the server's shared verdict wins once it arrives.
const callEco = () => (cur ? cur.eco : ecoOn());

async function getMedia(kind, facing = 'user') {
    try {
        return await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: kind === 'video'
                ? { ...(ecoOn() ? ECO_VIDEO_CAPTURE : VIDEO_CAPTURE), facingMode: { ideal: facing } }
                : false,
        });
    } catch (e) {
        toast(kind === 'video'
            ? t('call.need_camera_mic')
            : t('call.need_mic'));
        return null;
    }
}

// This is a full mesh: every extra participant is another complete copy of your
// own video going up, so the per-peer budget has to shrink as the call grows or
// a 4-way call would quadruple the uplink.
function videoBudgetBps() {
    const peers = Math.max(1, cur ? cur.peers.size : 1);
    const eco = callEco();
    const budget = eco ? ECO_VIDEO_KBPS : VIDEO_KBPS;
    const floor = eco ? ECO_VIDEO_MIN_KBPS : VIDEO_MIN_KBPS;
    return Math.max(floor, Math.round(budget / peers)) * 1000;
}

// Re-negotiating capture is what actually saves the uplink: capping the encoder
// while still grabbing 640x360 at 24 fps makes it throw most of that away.
async function applyCaptureProfile() {
    if (!cur || cur.kind !== 'video') return;
    const want = callEco() ? ECO_VIDEO_CAPTURE : VIDEO_CAPTURE;
    for (const track of cur.local.getVideoTracks()) {
        try { await track.applyConstraints({ ...want, facingMode: { ideal: cur.facing } }); }
        catch { /* device refused the profile; the bitrate cap still applies */ }
    }
}

// Re-applied whenever the peer set changes, on connect, and after a camera swap:
// replaceTrack and renegotiation can both reset a sender's parameters.
async function applyEncodingCaps(pc) {
    for (const sender of pc.getSenders()) {
        if (!sender.track) continue;
        const isVideo = sender.track.kind === 'video';
        let params;
        try { params = sender.getParameters(); } catch { continue; }
        // getParameters() can return no encodings before negotiation settles;
        // setting one is how a cap is expressed in that case.
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        for (const enc of params.encodings) {
            enc.maxBitrate = isVideo
                ? videoBudgetBps()
                : (callEco() ? ECO_AUDIO_KBPS : AUDIO_KBPS) * 1000;
            if (isVideo) {
                enc.maxFramerate = callEco() ? ECO_MAX_FPS : MAX_FPS;
                // In a larger mesh the per-peer budget is too small to hold 360p;
                // halving the resolution matches the picture to the bitrate
                // instead of making the encoder fight for it.
                enc.scaleResolutionDownBy = cur && cur.peers.size > 2 ? 2 : 1;
            }
        }
        if (isVideo) {
            // 'balanced' lets the encoder trade resolution for smoothness, which
            // is right for a moving face. 'maintain-resolution' is the
            // screen-share setting: it pins the resolution and pays in dropped
            // frames and blockiness instead.
            params.degradationPreference = 'balanced';
            // Same hint for engines that ignore degradationPreference entirely
            // (Firefox and Safari drop the unknown member).
            try { sender.track.contentHint = 'motion'; } catch { /* read-only */ }
        }
        try { await sender.setParameters(params); } catch { /* not supported here */ }
    }
}

function applyAllEncodingCaps() {
    if (!cur) return;
    for (const peer of cur.peers.values()) applyEncodingCaps(peer.pc);
}

/* ---------------- camera ---------------- */

async function videoInputs() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((d) => d.kind === 'videoinput');
    } catch { return []; }
}

// Cycle to the next camera without renegotiating: replaceTrack swaps the outgoing
// track inside the existing sender, so the call never drops.
//
// Cycling deviceId rather than asking for facingMode 'environment' means this
// also works on a desktop with two webcams — and, more importantly, it cannot
// offer a switch that then always fails, which an `exact: 'environment'`
// constraint does on every machine whose cameras report no facing mode.
async function switchCamera() {
    if (!cur || cur.kind !== 'video' || cur.switching) return;
    cur.switching = true;
    try {
        const cams = await videoInputs();
        if (!cur) return;
        if (cams.length < 2) { toast(t('call.no_other_camera')); return; }

        const currentId = cur.local.getVideoTracks()[0]?.getSettings?.().deviceId;
        const at = cams.findIndex((d) => d.deviceId === currentId);
        const next = cams[((at < 0 ? 0 : at) + 1) % cams.length];

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                // The eco profile has to be re-requested here: this is a fresh
                // getUserMedia, so it does not inherit the current track's constraints.
                video: {
                    ...(callEco() ? ECO_VIDEO_CAPTURE : VIDEO_CAPTURE),
                    deviceId: { exact: next.deviceId },
                },
            });
        } catch { if (cur) toast(t('call.no_other_camera')); return; }

        const track = stream.getVideoTracks()[0];
        // The call can end while getUserMedia is resolving. The new track is not
        // in cur.local yet, so teardown() would never stop it — the camera would
        // stay live, light and all, after the call was over.
        if (!cur || !track) { stream.getTracks().forEach((tr) => tr.stop()); return; }

        const old = cur.local.getVideoTracks()[0];
        // Inherit the muted state: flipping must not silently start broadcasting
        // again for someone who had turned their camera off.
        track.enabled = old ? old.enabled : true;

        for (const peer of cur.peers.values()) {
            const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            if (sender) await sender.replaceTrack(track).catch(() => { });
            if (!cur) { track.stop(); return; }      // hung up mid-swap
        }

        if (old) { cur.local.removeTrack(old); old.stop(); }
        cur.local.addTrack(track);
        // Most desktop webcams report no facingMode; anything not explicitly the
        // rear camera is treated as front-facing, which is the mirrored case.
        cur.facing = track.getSettings?.().facingMode === 'environment' ? 'environment' : 'user';
        applyAllEncodingCaps();   // replaceTrack can reset the sender's caps
        renderGrid();
    } finally {
        if (cur) cur.switching = false;
    }
}

/* ---------------- peers (perfect negotiation) ---------------- */

function ensurePeer(connId, userId) {
    if (cur.peers.has(connId)) return cur.peers.get(connId);
    const polite = S.connId < connId; // deterministic role per pair
    // iceServers is prefetched before any peer is created (startCall/joinCall),
    // so this runs with no await between the has() check and the set() below —
    // that prevents two RTCPeerConnections being built for the same connId.
    const pc = new RTCPeerConnection({ iceServers: iceServers || [{ urls: ['stun:stun.l.google.com:19302'] }] });
    const peer = {
        connId, userId, pc, polite,
        makingOffer: false, ignoreOffer: false, restarted: false,
        stream: null, el: null, candidates: [],
    };
    cur.peers.set(connId, peer);

    for (const track of cur.local.getTracks()) pc.addTrack(track, cur.local);
    // Cap before the first offer so the initial encoding is already bounded.
    applyEncodingCaps(pc);

    pc.onnegotiationneeded = async () => {
        try {
            peer.makingOffer = true;
            await pc.setLocalDescription();
            net.send('rtc', { callId: cur.callId, toConn: connId, data: { description: pc.localDescription } });
        } catch (e) { console.error(e); }
        finally { peer.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => {
        if (candidate) net.send('rtc', { callId: cur.callId, toConn: connId, data: { candidate } });
    };
    pc.ontrack = ({ streams }) => {
        peer.stream = streams[0];
        attachStream(peer);
    };
    pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        // Re-assert the caps once connected: negotiation can hand back a sender
        // whose parameters were rebuilt, silently dropping the ceiling.
        if (st === 'connected') { peer.restarted = false; applyEncodingCaps(pc); return; }
        if (st === 'failed') {
            // Try to recover the leg once via ICE restart before dropping it,
            // so a transient network failure does not kill it for the whole call.
            if (!peer.restarted && typeof pc.restartIce === 'function') {
                peer.restarted = true;
                try { pc.restartIce(); } catch { dropPeer(connId); }
            } else {
                dropPeer(connId);
            }
        } else if (st === 'closed') {
            dropPeer(connId);
        }
    };
    renderGrid();
    return peer;
}

async function handleRtc(d) {
    if (!cur || d.callId !== cur.callId) return;
    const peer = await ensurePeer(d.fromConn, d.fromUser);
    const { pc } = peer;
    const { description, candidate } = d.data || {};
    try {
        if (description) {
            const collision = description.type === 'offer'
                && (peer.makingOffer || pc.signalingState !== 'stable');
            peer.ignoreOffer = !peer.polite && collision;
            if (peer.ignoreOffer) return;
            await pc.setRemoteDescription(description);
            for (const c of peer.candidates.splice(0)) {
                await pc.addIceCandidate(c).catch(() => { });
            }
            if (description.type === 'offer') {
                await pc.setLocalDescription();
                net.send('rtc', { callId: cur.callId, toConn: d.fromConn, data: { description: pc.localDescription } });
            }
        } else if (candidate) {
            if (!pc.remoteDescription) peer.candidates.push(candidate);
            else await pc.addIceCandidate(candidate).catch((e) => { if (!peer.ignoreOffer) throw e; });
        }
    } catch (e) { console.error('rtc', e); }
}

function dropPeer(connId) {
    const peer = cur?.peers.get(connId);
    if (!peer) return;
    try { peer.pc.close(); } catch { }
    cur.peers.delete(connId);
    renderGrid();
}

/* ---------------- start / join / leave ---------------- */

export async function startCall(convId, kind) {
    if (inCall()) { toast(t('call.already_in_call')); return; }
    const existing = S.calls.get(convId);
    if (existing) { joinCall(existing.callId, convId, existing.kind); return; }
    const local = await getMedia(kind);
    if (!local) return;
    await getIce(); // load ICE config before any peer exists so ensurePeer is sync
    cur = {
        callId: null, convId, kind, local, peers: new Map(), timer: null,
        startedAt: Date.now(), facing: 'user', pinLocal: false, eco: ecoOn(), ecoUsers: [],
    };
    net.send('call:start', { convId, kind, eco: ecoOn() });
    showOverlay();
    ringbackStart();
}

export async function joinCall(callId, convId, kind) {
    if (inCall()) { toast(t('call.already_in_call')); return; }
    dismissRing();
    const local = await getMedia(kind);
    if (!local) return;
    await getIce(); // load ICE config before any peer exists so ensurePeer is sync
    cur = {
        callId, convId, kind, local, peers: new Map(), timer: null,
        startedAt: Date.now(), facing: 'user', pinLocal: false, eco: ecoOn(), ecoUsers: [],
    };
    net.send('call:join', { callId, eco: ecoOn() });
    showOverlay();
}

export function hangup() {
    if (!cur) return;
    if (cur.callId) net.send('call:leave', { callId: cur.callId });
    teardown();
}

function teardown() {
    if (!cur) return;
    ringbackStop();
    for (const [id] of cur.peers) dropPeer(id);
    cur.local?.getTracks().forEach((track) => track.stop());
    clearInterval(cur.timer);
    cur = null;
    $('call-overlay').hidden = true;
    updateChip();
}

/* ---------------- server events ---------------- */

export function onCallState(d) {
    S.calls.set(d.convId, d);
    // My own join confirmed anywhere (this or another device) stops the ring.
    if (ring && ring.callId === d.callId && d.participants.some((p) => p.userId === S.me.id)) {
        dismissRing();
    }
    if (cur && (cur.callId === d.callId || (cur.callId === null && d.convId === cur.convId))) {
        cur.callId = d.callId;
        // Adopt the shared verdict before any peer is built, so a new sender's
        // very first setParameters already carries the right ceiling.
        const wasEco = cur.eco;
        cur.eco = !!d.eco;
        cur.ecoUsers = d.ecoUsers || [];
        const present = new Set();
        for (const p of d.participants) {
            present.add(p.connId);
            if (p.connId !== S.connId) ensurePeer(p.connId, p.userId);
        }
        for (const connId of [...cur.peers.keys()]) {
            if (!present.has(connId)) dropPeer(connId);
        }
        // The per-peer video budget is divided by the mesh size, so it has to be
        // recomputed whenever somebody joins or leaves.
        applyAllEncodingCaps();
        // Somebody picked up — the ringback has done its job.
        if (cur.peers.size > 0) ringbackStop();
        if (cur.eco !== wasEco) applyCaptureProfile();
        // What the server thinks THIS connection asked for. If the local switch
        // has moved since — flipped before the call had an id, or flipped while
        // the socket was down and the message went nowhere — re-assert it.
        const mine = d.participants.find((p) => p.connId === S.connId);
        if (mine && mine.eco !== ecoOn()) {
            net.send('call:eco', { callId: cur.callId, eco: ecoOn() });
        }
        renderEcoNote();
        renderGrid();
    }
    updateChip();
}

export function onCallRing(d) {
    if (inCall() || d.from === S.me.id) return;
    dismissRing();
    const conv = S.convs.get(d.convId);
    ring = { ...d, timeout: setTimeout(dismissRing, 60_000) };
    $('ring-title').textContent = userName(d.from);
    // One key per rendered sentence: the kind word and the ' · <group>' tail are
    // not separable fragments a translator could safely reorder.
    $('ring-sub').textContent = conv?.type === 'group'
        ? t(d.kind === 'video' ? 'call.ring_sub_video_group' : 'call.ring_sub_voice_group',
            { title: convTitle(conv) })
        : t(d.kind === 'video' ? 'call.ring_sub_video' : 'call.ring_sub_voice');
    const av = $('ring-avatar');
    av.replaceWith(Object.assign(
        avatarEl(userName(d.from), { src: userAvatar(userById(d.from)) }), { id: 'ring-avatar' }));
    $('ring-banner').hidden = false;
    ringStart();
}

export function onCallDeclined(d) {
    if (!cur || cur.callId !== d.callId) return;
    toast(t('call.declined', { name: userName(d.userId) }));
    // In a one-to-one call the only person who could answer just said no, so
    // ringing on until the no-answer timeout is only noise. A group call may
    // still be picked up by somebody else, so it keeps ringing there.
    const conv = S.convs.get(cur.convId);
    if (conv?.type !== 'group') ringbackStop();
}

export function onCallEnded(d) {
    if (d.convId) S.calls.delete(d.convId);
    else for (const [k, v] of S.calls) if (v.callId === d.callId) S.calls.delete(k);
    if (ring && ring.callId === d.callId) dismissRing();
    if (cur && cur.callId === d.callId) {
        teardown();
        toast(t(d.reason === 'no_answer' ? 'call.no_answer' : 'call.ended'));
    }
    updateChip();
}

export function onRtc(d) { handleRtc(d); }

function dismissRing() {
    if (!ring) return;
    clearTimeout(ring.timeout);
    ring = null;
    $('ring-banner').hidden = true;
    ringStop();
}

/* ---------------- UI ---------------- */

function attachStream(peer) {
    if (!peer.el) renderGrid();
    const video = peer.el?.querySelector('video');
    if (video && peer.stream && video.srcObject !== peer.stream) {
        video.srcObject = peer.stream;
        video.play().catch(() => { });
    }
}

// `src` has to be threaded in: only a pre-resolved name is in scope here, so
// without it nobody's photo (including your own) reaches a call tile.
function tileEl(name, { pip = false, mirror = false, muted = false, hasVideo = true, src = null } = {}) {
    const tile = h('div', {
        class: 'call-tile' + (pip ? ' pip' : '') + (mirror ? ' mirror' : '') + (hasVideo ? '' : ' audio-only'),
    });
    const video = h('video', { autoplay: '', playsinline: '' });
    if (muted) video.muted = true;   // only ever the local preview
    tile.append(video);
    if (!hasVideo) tile.append(avatarEl(name, { size: 'big', src }));
    tile.append(h('span', { class: 'tile-name', text: name }));
    if (pip) {
        tile.title = t('call.swap');
        tile.addEventListener('click', () => {
            if (!cur) return;
            cur.pinLocal = !cur.pinLocal;
            renderGrid();
        });
    }
    return tile;
}

function renderGrid() {
    if (!cur) return;
    const grid = $('call-grid');
    grid.textContent = '';
    const hasVideo = cur.kind === 'video';
    const peers = [...cur.peers.values()];
    // With nobody else present there is no second stream to swap with, and
    // pinning would leave no PiP to tap to get back.
    if (!peers.length) cur.pinLocal = false;

    // There is exactly one small floating slot. It normally holds your own
    // preview; tapping it swaps, so the peer goes small and you go large.
    const pipPeer = cur.pinLocal ? peers[0] : null;
    const gridPeers = pipPeer ? peers.slice(1) : peers;

    for (const peer of gridPeers) {
        peer.el = tileEl(userName(peer.userId), { hasVideo, src: userAvatar(userById(peer.userId)) });
        grid.append(peer.el);
        attachStream(peer);
    }

    // Local preview: large when pinned, otherwise the floating tile. Mirrored
    // only for the front camera, wherever it is drawn.
    const localTile = tileEl(t('call.you'), {
        pip: !cur.pinLocal, mirror: cur.facing !== 'environment', muted: true,
        hasVideo, src: userAvatar(S.me),
    });
    const lv = localTile.querySelector('video');
    lv.srcObject = cur.local;
    lv.play().catch(() => { });

    if (cur.pinLocal) grid.append(localTile);

    if (peers.length === 0) {
        // The fallback literal has no id, which is why convAvatarSrc guards on one
        // rather than emitting a request for "cundefined".
        const conv = S.convs.get(cur.convId) || { type: 'group', name: '…', members: [] };
        grid.append(h('div', { class: 'call-tile audio-only' }, [
            avatarEl(convTitle(conv), { size: 'big', src: convAvatarSrc(conv) }),
            h('span', { class: 'tile-name', text: t('call.calling') }),
        ]));
    }

    if (pipPeer) {
        pipPeer.el = tileEl(userName(pipPeer.userId), {
            pip: true, hasVideo, src: userAvatar(userById(pipPeer.userId)),
        });
        grid.append(pipPeer.el);
        attachStream(pipPeer);
    }
    if (!cur.pinLocal) grid.append(localTile);

    $('call-cam').hidden = !hasVideo;
    // Only offered when the device actually has another camera to switch to.
    $('call-flip').hidden = !(hasVideo && cur.canFlip);
}

// Names whoever pulled the call down to the low-bitrate profile, so the drop in
// picture quality reads as somebody's bad connection rather than a fault.
function renderEcoNote() {
    const note = $('call-eco');
    if (!note) return;
    if (!cur || !cur.eco) { note.hidden = true; return; }
    const others = (cur.ecoUsers || []).filter((id) => id !== S.me.id);
    note.textContent = others.length
        ? t('call.eco_note', {
            n: others.length,
            names: others.map((id) => userName(id)).join(t('call.eco_join')),
        })
        : t('call.eco_note_self');
    note.hidden = false;
}

function showOverlay() {
    $('call-overlay').hidden = false;
    renderEcoNote();
    renderGrid();
    // Device labels/count are only meaningful once permission is granted, which
    // getMedia has just done. Re-render when the answer arrives.
    if (cur.kind === 'video') {
        videoInputs().then((cams) => {
            if (cur) { cur.canFlip = cams.length > 1; $('call-flip').hidden = !cur.canFlip; }
        });
    }
    clearInterval(cur.timer);
    cur.timer = setInterval(() => {
        if (!cur) return;
        const s = Math.floor((Date.now() - cur.startedAt) / 1000);
        $('call-status').textContent = cur.peers.size === 0 ? t('call.calling')
            : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, 1000);
    updateChip();
}

export function updateChip() {
    const chip = $('call-chip');
    const call = S.activeConvId ? S.calls.get(S.activeConvId) : null;
    if (call && (!cur || cur.callId !== call.callId)) {
        $('call-chip-label').textContent = t(
            call.kind === 'video' ? 'call.chip_video' : 'call.chip_voice',
            { count: call.participants.length });
        chip.hidden = false;
        chip.dataset.callId = call.callId;
        chip.dataset.kind = call.kind;
    } else {
        chip.hidden = true;
    }
}

/* ---------------- init ---------------- */

export function initCalls() {
    $('btn-call-audio').addEventListener('click', () => S.activeConvId && startCall(S.activeConvId, 'audio'));
    $('btn-call-video').addEventListener('click', () => S.activeConvId && startCall(S.activeConvId, 'video'));

    $('call-hangup').addEventListener('click', hangup);
    $('call-mute').addEventListener('click', () => {
        if (!cur) return;
        const tracks = cur.local.getAudioTracks();
        const on = !tracks[0]?.enabled;
        tracks.forEach((track) => { track.enabled = on; });
        $('call-mute').classList.toggle('off', !on);
    });
    $('call-cam').addEventListener('click', () => {
        if (!cur) return;
        const tracks = cur.local.getVideoTracks();
        const on = !tracks[0]?.enabled;
        tracks.forEach((track) => { track.enabled = on; });
        $('call-cam').classList.toggle('off', !on);
    });
    $('call-flip').addEventListener('click', switchCamera);

    $('ring-accept').addEventListener('click', () => {
        if (ring) joinCall(ring.callId, ring.convId, ring.kind);
    });
    $('ring-decline').addEventListener('click', () => {
        if (ring) { net.send('call:decline', { callId: ring.callId }); dismissRing(); }
    });

    $('call-chip-join').addEventListener('click', () => {
        const chip = $('call-chip');
        if (chip.dataset.callId) joinCall(chip.dataset.callId, S.activeConvId, chip.dataset.kind);
    });

    // Flipping the switch from the profile while a call is up applies to that
    // call immediately, for everyone in it.
    onEcoChange((on) => {
        if (!cur) return;
        // Turning it on needs no confirmation from anyone: one participant asking
        // for it is what makes the whole call eco, so it is already true here.
        // Turning it off does need it — somebody else may still be asking.
        if (on && !cur.eco) {
            cur.eco = true;
            applyAllEncodingCaps();
            applyCaptureProfile();
            renderEcoNote();
        }
        // No id yet means the call is still being set up; onCallState re-asserts
        // this against the server as soon as there is something to assert it to.
        if (cur.callId) net.send('call:eco', { callId: cur.callId, eco: on });
    });

    window.addEventListener('beforeunload', () => { if (cur?.callId) net.send('call:leave', { callId: cur.callId }); });
}
