/** Audio helpers: base64 decoding, blob URLs, saving files, and a gapless chunk scheduler for streamed renders. */

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function mimeFor(format: string): string {
  switch (format) {
    case "wav": return "audio/wav";
    case "mp3": return "audio/mpeg";
    case "flac": return "audio/flac";
    case "ogg": return "audio/ogg";
    case "opus": return "audio/ogg; codecs=opus";
    case "m4a": return "audio/mp4";
    default: return "application/octet-stream";
  }
}

export function blobFromBase64(b64: string, format: string): Blob {
  return new Blob([base64ToBytes(b64) as BlobPart], { type: mimeFor(format) });
}

let sharedCtx: AudioContext | null = null;
export function audioContext(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext();
  if (sharedCtx.state === "suspended") void sharedCtx.resume();
  return sharedCtx;
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Save a blob to disk: native dialog inside Tauri, download link in a browser. */
export async function saveBlob(blob: Blob, suggestedName: string): Promise<boolean> {
  const isTauri = "__TAURI_INTERNALS__" in window;
  if (isTauri) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const ext = suggestedName.includes(".") ? (suggestedName.split(".").pop() ?? "mp3") : "mp3";
      const isAudio = ["mp3", "wav", "flac", "ogg", "opus", "m4a"].includes(ext.toLowerCase());
      const path = await save({ defaultPath: suggestedName, filters: [{ name: ext.toUpperCase() + (isAudio ? " audio" : " file"), extensions: [ext] }] });
      if (!path) return false;
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      return true;
    } catch (e) {
      console.error(e);
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return true;
}

/** Microphone recorder producing a webm/opus (or wav fallback) blob. */
export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private stream: MediaStream | null = null;
  analyser: AnalyserNode | null = null;

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const ctx = audioContext();
    const src = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    src.connect(this.analyser);
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
  }

  level(): number {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    return Math.sqrt(sum / data.length);
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = this.rec;
      if (!rec) return resolve(new Blob());
      rec.onstop = () => {
        const type = rec.mimeType || "audio/webm";
        resolve(new Blob(this.chunks, { type }));
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.rec = null;
        this.analyser = null;
      };
      rec.stop();
    });
  }

  get active() {
    return !!this.rec && this.rec.state === "recording";
  }
}
