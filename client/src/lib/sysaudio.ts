// Zvuk računara za stream, bez zvuka Lpcalasa (snima ga Rust dio, vidi src-tauri/src/sysaudio.rs).
// Ovdje ga pretvaramo u MediaStreamTrack koji LiveKit šalje kao "zvuk streama".
import { isTauri } from './native';

// Audio nit: prima f32 stereo (interleaved) blokove i pušta ih bez zastoja.
const WORKLET = `
class LpSysAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(48000 * 2); // 0.5 s stereo
    this.read = 0; this.write = 0; this.size = 0; this.started = false;
    this.port.onmessage = (e) => {
      const d = e.data; const cap = this.buf.length;
      for (let i = 0; i < d.length; i++) { this.buf[this.write] = d[i]; this.write = (this.write + 1) % cap; }
      this.size += d.length;
      if (this.size > cap) { this.read = (this.write) % cap; this.size = cap; }
      // Ne dozvoli da kašnjenje naraste preko ~120 ms.
      const max = 48000 * 2 * 0.12;
      if (this.size > max) { const drop = this.size - 48000 * 2 * 0.04; this.read = (this.read + drop) % cap; this.size -= drop; }
      if (!this.started && this.size >= 48000 * 2 * 0.04) this.started = true;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0]; const L = out[0]; const R = out[1] || out[0]; const cap = this.buf.length;
    for (let i = 0; i < L.length; i++) {
      if (this.started && this.size >= 2) {
        L[i] = this.buf[this.read]; R[i] = this.buf[(this.read + 1) % cap];
        this.read = (this.read + 2) % cap; this.size -= 2;
      } else { L[i] = 0; R[i] = 0; if (this.size < 2) this.started = false; }
    }
    return true;
  }
}
registerProcessor('lp-sysaudio', LpSysAudio);
`;

export interface SystemAudio {
  track: MediaStreamTrack;
  stop: () => Promise<void>;
}

export async function startSystemAudio(): Promise<SystemAudio | null> {
  if (!isTauri) return null;
  const { invoke, Channel } = await import('@tauri-apps/api/core');
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'lp-sysaudio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    node.connect(dest);
    const channel = new Channel<ArrayBuffer | number[]>();
    channel.onmessage = (data) => {
      const bytes = data instanceof ArrayBuffer ? data : new Uint8Array(data as number[]).buffer;
      const samples = new Float32Array(bytes);
      node.port.postMessage(samples, [samples.buffer]);
    };
    await invoke('start_system_audio', { onData: channel });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const track = dest.stream.getAudioTracks()[0];
    return {
      track,
      stop: async () => {
        await invoke('stop_system_audio').catch(() => {});
        track.stop();
        await ctx.close().catch(() => {});
      },
    };
  } catch (err) {
    await ctx.close().catch(() => {});
    console.warn('[lpcalas] zvuk sistema bez aplikacije nije dostupan:', err);
    return null;
  }
}
