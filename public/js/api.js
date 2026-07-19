// Fetch helpers. All paths are relative to /connectwell/.

export async function api(path, { method = 'GET', body } = {}) {
    const opts = {
        method,
        headers: { 'X-Requested-With': 'ConnectWell' },
        credentials: 'same-origin',
    };
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const r = await fetch(path, opts);
    let data = null;
    try { data = await r.json(); } catch { /* non-JSON */ }
    if (!r.ok) {
        const e = new Error(data?.error || 'Request failed (' + r.status + ')');
        e.status = r.status;
        throw e;
    }
    return data;
}

// Raw-bytes POST. api() JSON-stringifies its body so it cannot carry binary, and
// upload() is hardwired to the message route, which would post the image into the
// conversation. Sending real bytes also dodges the 64kb express.json limit.
export async function postBytes(path, blob) {
    const r = await fetch(path, {
        method: 'POST',
        headers: {
            'X-Requested-With': 'ConnectWell',
            'Content-Type': blob.type || 'application/octet-stream',
        },
        credentials: 'same-origin',
        body: blob,
    });
    let data = null;
    try { data = await r.json(); } catch { /* non-JSON */ }
    if (!r.ok) {
        const e = new Error(data?.error || 'Request failed (' + r.status + ')');
        e.status = r.status;
        throw e;
    }
    return data;
}

export function upload(convId, blob, { fileName, mime, msgType, duration, onProgress } = {}) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'api/conversations/' + convId + '/upload');
        xhr.setRequestHeader('X-Requested-With', 'ConnectWell');
        xhr.setRequestHeader('Content-Type', mime || blob.type || 'application/octet-stream');
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(fileName || ''));
        if (msgType) xhr.setRequestHeader('X-Msg-Type', msgType);
        if (duration) xhr.setRequestHeader('X-Duration', String(duration));
        xhr.upload.onprogress = (e) => {
            if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
            let data = null;
            try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
            if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
            else reject(new Error(data?.error || 'Upload failed'));
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(blob);
    });
}
