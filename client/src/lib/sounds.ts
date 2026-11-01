import { settings } from './settings';

// Svaki događaj ima svoj, jasno različit zvuk (napravljen u kodu, bez fajlova).
// Razlike: visina, smjer melodije, boja tona (sinus/trougao/kvadrat) i ritam.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function audio(): { ctx: AudioContext; out: GainNode } | null {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      // Blagi kompresor da glasniji zvukovi ne pucaju.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    master!.gain.value = settings.get().soundVolume;
    return { ctx, out: master! };
  } catch {
    return null;
  }
}

interface Note {
  f: number; // frekvencija (Hz)
  t: number; // početak (s)
  d: number; // trajanje (s)
  type?: OscillatorType;
  v?: number; // jačina 0..1
  to?: number; // klizanje do frekvencije
}

function play(notes: Note[]) {
  if (!settings.get().sounds) return;
  const a = audio();
  if (!a) return;
  const start = a.ctx.currentTime + 0.01;
  for (const n of notes) {
    const osc = a.ctx.createOscillator();
    const gain = a.ctx.createGain();
    osc.type = n.type || 'sine';
    osc.frequency.setValueAtTime(n.f, start + n.t);
    if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, start + n.t + n.d);
    const v = n.v ?? 0.3;
    gain.gain.setValueAtTime(0.0001, start + n.t);
    gain.gain.exponentialRampToValueAtTime(v, start + n.t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + n.t + n.d);
    osc.connect(gain).connect(a.out);
    osc.start(start + n.t);
    osc.stop(start + n.t + n.d + 0.05);
  }
}

// Kratka glasovna najava ("Mikrofon isključen"), ako je uključena u postavkama.
function say(text: string) {
  if (!settings.get().voiceAnnouncements || !settings.get().sounds) return;
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = synth.getVoices();
    const local = voices.find((v) => /^(bs|hr|sr)/i.test(v.lang));
    if (local) {
      u.voice = local;
      u.lang = local.lang;
    } else {
      u.lang = 'hr-HR';
    }
    u.rate = 1.15;
    u.volume = Math.min(1, settings.get().soundVolume);
    synth.speak(u);
  } catch {
    /* nema govora */
  }
}

export const sounds = {
  // Ti ušao u glasovni kanal: vedar uzlazni akord (trougao).
  selfJoin: () =>
    play([
      { f: 523, t: 0, d: 0.12, type: 'triangle', v: 0.35 },
      { f: 659, t: 0.08, d: 0.12, type: 'triangle', v: 0.35 },
      { f: 784, t: 0.16, d: 0.25, type: 'triangle', v: 0.4 },
    ]),
  // Neko drugi ušao: dva visoka "zvona" gore.
  join: () =>
    play([
      { f: 880, t: 0, d: 0.18, v: 0.4 },
      { f: 1320, t: 0.12, d: 0.3, v: 0.4 },
    ]),
  // Neko izašao: dva niža tona dole, sporije.
  leave: () =>
    play([
      { f: 660, t: 0, d: 0.2, v: 0.38 },
      { f: 392, t: 0.15, d: 0.35, v: 0.38 },
    ]),
  // Ti izašao: klizanje naniže.
  selfLeave: () => play([{ f: 700, to: 260, t: 0, d: 0.35, type: 'triangle', v: 0.35 }]),
  // Mute: dubok, "tup" kvadratni ton naniže + glas.
  mute: () => {
    play([
      { f: 330, to: 180, t: 0, d: 0.16, type: 'square', v: 0.18 },
      { f: 220, t: 0.13, d: 0.12, type: 'square', v: 0.14 },
    ]);
    say('Mikrofon isključen');
  },
  // Unmute: kratko "klik-klik" naviše + glas.
  unmute: () => {
    play([
      { f: 440, t: 0, d: 0.07, type: 'square', v: 0.16 },
      { f: 880, t: 0.08, d: 0.1, type: 'square', v: 0.16 },
    ]);
    say('Mikrofon uključen');
  },
  // Deafen: tri silazna tona, prigušeno.
  deafen: () => {
    play([
      { f: 600, t: 0, d: 0.1, type: 'sawtooth', v: 0.1 },
      { f: 450, t: 0.09, d: 0.1, type: 'sawtooth', v: 0.1 },
      { f: 300, t: 0.18, d: 0.18, type: 'sawtooth', v: 0.1 },
    ]);
    say('Zvuk isključen');
  },
  undeafen: () => {
    play([
      { f: 300, t: 0, d: 0.1, type: 'sawtooth', v: 0.1 },
      { f: 450, t: 0.09, d: 0.1, type: 'sawtooth', v: 0.1 },
      { f: 600, t: 0.18, d: 0.18, type: 'sawtooth', v: 0.1 },
    ]);
    say('Zvuk uključen');
  },
  // Nova poruka: kratki dvostruki "pop" visoko.
  message: () =>
    play([
      { f: 1568, t: 0, d: 0.06, v: 0.25 },
      { f: 2093, t: 0.07, d: 0.09, v: 0.22 },
    ]),
  // Neko počeo streamati: uzlazni "swoosh" + akord.
  streamStart: () =>
    play([
      { f: 300, to: 900, t: 0, d: 0.25, type: 'triangle', v: 0.25 },
      { f: 988, t: 0.22, d: 0.3, v: 0.3 },
    ]),
  streamStop: () => play([{ f: 900, to: 300, t: 0, d: 0.3, type: 'triangle', v: 0.25 }]),
  // Neko počeo gledati tvoj stream: diskretan visoki tik.
  viewer: () => play([{ f: 1760, t: 0, d: 0.05, v: 0.15 }]),
  // Za test u postavkama.
  test: () => play([{ f: 880, t: 0, d: 0.2, v: 0.35 }]),
};
