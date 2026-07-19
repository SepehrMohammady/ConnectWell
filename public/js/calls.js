// Audio/video calls: WebRTC mesh (1:1 and small groups) with perfect
// negotiation per peer. Signaling rides the app WebSocket ('rtc' events).

import { api } from './api.js';
import {
    S, $, h, net, toast, avatarEl, userName, convTitle, ringStart, ringStop,
    userById, userAvatar, convAvatarSrc,
} from './core.js';

let iceServers = null;
async function getIce() {
    if (!iceServers) {
        try { iceServers = (await api('api/ice')).iceServers; }
        catch { iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }]; }
    }
    return iceServers;
}

let cur = null;   // { callId, convId, kind, local, peers: Map<connId, peer>, timer, startedAt }
let ring = null;  // { callId, convId, kind, from, timeout }

const inCall = () => !!cur;

/* ---------------- media ---------------- */

async function getMedia(kind) {
    try {
        return await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: kind === 'video' ? { facingMode: 'user', width: { ideal: 960 } } : false,
        });
    } catch (e) {
        toast(kind === 'video'
            ? 'Camera & microphone access is needed for video calls'
            : 'Microphone access is needed for calls');
        return null;
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
        if (st === 'connected') { peer.restarted = false; return; }
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
    if (inCall()) { toast('You are already in a call'); return; }
    const existing = S.calls.get(convId);
    if (existing) { joinCall(existing.callId, convId, existing.kind); return; }
    const local = await getMedia(kind);
    if (!local) return;
    await getIce(); // load ICE config before any peer exists so ensurePeer is sync
    cur = { callId: null, convId, kind, local, peers: new Map(), timer: null, startedAt: Date.now() };
    net.send('call:start', { convId, kind });
    showOverlay();
}

export async function joinCall(callId, convId, kind) {
    if (inCall()) { toast('You are already in a call'); return; }
    dismissRing();
    const local = await getMedia(kind);
    if (!local) return;
    await getIce(); // load ICE config before any peer exists so ensurePeer is sync
    cur = { callId, convId, kind, local, peers: new Map(), timer: null, startedAt: Date.now() };
    net.send('call:join', { callId });
    showOverlay();
}

export function hangup() {
    if (!cur) return;
    if (cur.callId) net.send('call:leave', { callId: cur.callId });
    teardown();
}

function teardown() {
    if (!cur) return;
    for (const [id] of cur.peers) dropPeer(id);
    cur.local?.getTracks().forEach((t) => t.stop());
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
        const present = new Set();
        for (const p of d.participants) {
            present.add(p.connId);
            if (p.connId !== S.connId) ensurePeer(p.connId, p.userId);
        }
        for (const connId of [...cur.peers.keys()]) {
            if (!present.has(connId)) dropPeer(connId);
        }
        renderGrid();
    }
    updateChip();
}

export function onCallRing(d) {
    if (inCall() || d.from === S.me.id) return;
    dismissRing();
    const conv = S.convs.get(d.convId);
    ring = { ...d, timeout: setTimeout(dismissRing, 45_000) };
    $('ring-title').textContent = userName(d.from);
    $('ring-sub').textContent = 'Incoming ' + (d.kind === 'video' ? 'video' : 'voice') + ' call'
        + (conv?.type === 'group' ? ' · ' + convTitle(conv) : '');
    const av = $('ring-avatar');
    av.replaceWith(Object.assign(
        avatarEl(userName(d.from), { src: userAvatar(userById(d.from)) }), { id: 'ring-avatar' }));
    $('ring-banner').hidden = false;
    ringStart();
}

export function onCallDeclined(d) {
    if (cur && cur.callId === d.callId) toast(userName(d.userId) + ' declined');
}

export function onCallEnded(d) {
    if (d.convId) S.calls.delete(d.convId);
    else for (const [k, v] of S.calls) if (v.callId === d.callId) S.calls.delete(k);
    if (ring && ring.callId === d.callId) dismissRing();
    if (cur && cur.callId === d.callId) { teardown(); toast('Call ended'); }
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
function tileEl(name, { local = false, hasVideo = true, src = null } = {}) {
    const tile = h('div', { class: 'call-tile' + (local ? ' local' : '') + (hasVideo ? '' : ' audio-only') });
    const video = h('video', { autoplay: '', playsinline: '' });
    if (local) video.muted = true;
    tile.append(video);
    if (!hasVideo) tile.append(avatarEl(name, { size: 'big', src }));
    tile.append(h('span', { class: 'tile-name', text: name }));
    return tile;
}

function renderGrid() {
    if (!cur) return;
    const grid = $('call-grid');
    grid.textContent = '';

    for (const peer of cur.peers.values()) {
        const hasVideo = cur.kind === 'video';
        peer.el = tileEl(userName(peer.userId), { hasVideo, src: userAvatar(userById(peer.userId)) });
        grid.append(peer.el);
        attachStream(peer);
    }
    if (cur.peers.size === 0) {
        // The fallback literal has no id, which is why convAvatarSrc guards on one
        // rather than emitting a request for "cundefined".
        const conv = S.convs.get(cur.convId) || { type: 'group', name: '…', members: [] };
        grid.append(h('div', { class: 'call-tile audio-only' }, [
            avatarEl(convTitle(conv), { size: 'big', src: convAvatarSrc(conv) }),
            h('span', { class: 'tile-name', text: 'Calling…' }),
        ]));
    }

    const localTile = tileEl('You', {
        local: true, hasVideo: cur.kind === 'video', src: userAvatar(S.me),
    });
    grid.append(localTile);
    const lv = localTile.querySelector('video');
    lv.srcObject = cur.local;
    lv.play().catch(() => { });

    $('call-cam').hidden = cur.kind !== 'video';
}

function showOverlay() {
    $('call-overlay').hidden = false;
    renderGrid();
    clearInterval(cur.timer);
    cur.timer = setInterval(() => {
        if (!cur) return;
        const s = Math.floor((Date.now() - cur.startedAt) / 1000);
        $('call-status').textContent = cur.peers.size === 0 ? 'Calling…'
            : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, 1000);
    updateChip();
}

export function updateChip() {
    const chip = $('call-chip');
    const call = S.activeConvId ? S.calls.get(S.activeConvId) : null;
    if (call && (!cur || cur.callId !== call.callId)) {
        $('call-chip-label').textContent = 'Ongoing ' + (call.kind === 'video' ? 'video' : 'voice')
            + ' call · ' + call.participants.length + ' in';
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
        tracks.forEach((t) => { t.enabled = on; });
        $('call-mute').classList.toggle('off', !on);
    });
    $('call-cam').addEventListener('click', () => {
        if (!cur) return;
        const tracks = cur.local.getVideoTracks();
        const on = !tracks[0]?.enabled;
        tracks.forEach((t) => { t.enabled = on; });
        $('call-cam').classList.toggle('off', !on);
    });

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

    window.addEventListener('beforeunload', () => { if (cur?.callId) net.send('call:leave', { callId: cur.callId }); });
}
