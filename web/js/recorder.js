// Cross-platform MediaRecorder wrapper. Audio never leaves the browser tab.
// Handles iOS Safari quirks: user-gesture requirement (caller ensures), MIME
// negotiation (mp4/AAC on older iOS, webm/opus elsewhere), and the "dataavailable
// only fires on stop" behavior on some Safari versions (we omit the timeslice there).

const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) ||
  (/iP(hone|ad|od)/.test(navigator.userAgent));

export function pickMime() {
  const candidates = [
    'audio/webm;codecs=opus', 'audio/webm',
    'audio/ogg;codecs=opus', 'audio/ogg',
    'audio/mp4', 'audio/aac',
  ];
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  for (const m of candidates) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

export function recordingSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

export class Recorder {
  constructor() { this.stream = null; this.mr = null; this.chunks = []; this.mime = ''; this.startedAt = 0; }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    this.mime = pickMime();
    this.chunks = [];
    this.mr = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.mr.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    // Safari: start() without a timeslice (older versions only emit on stop).
    if (IS_SAFARI) this.mr.start(); else this.mr.start(1000);
    this.startedAt = Date.now();
  }

  isActive() { return this.mr && this.mr.state === 'recording'; }

  stop() {
    return new Promise((resolve) => {
      if (!this.mr) return resolve(null);
      const finalize = () => {
        const type = this.mime || (this.chunks[0] && this.chunks[0].type) || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this._cleanup();
        resolve(blob);
      };
      this.mr.onstop = finalize;
      try { if (this.mr.state !== 'inactive') this.mr.stop(); else finalize(); }
      catch { finalize(); }
    });
  }

  _cleanup() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null; this.mr = null;
  }
}

export function extForMime(mime) {
  if (!mime) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  return 'webm';
}

export async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
