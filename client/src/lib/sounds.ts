import { settings } from './settings';

// Kratki zvukovi napravljeni u kodu (bez fajlova).
let ctx: AudioContext | null = null;

function tone(freqs: number[], duration = 0.09, gap = 0.02, volume = 0.08) {
  if (!settings.get().sounds) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    let t = ctx.currentTime + 0.01;
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + duration + 0.02);
      t += duration + gap;
    }
  } catch {
    /* audio nije dostupan */
  }
}

export const sounds = {
  join: () => tone([523, 784]),
  leave: () => tone([784, 523]),
  selfJoin: () => tone([523, 659, 784]),
  mute: () => tone([440], 0.07),
  unmute: () => tone([660], 0.07),
  message: () => tone([880], 0.06, 0, 0.05),
  streamStart: () => tone([392, 523, 659], 0.08),
};
