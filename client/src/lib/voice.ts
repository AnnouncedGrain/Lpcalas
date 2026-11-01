import {
  AudioPresets,
  ConnectionQuality,
  createLocalAudioTrack,
  DisconnectReason,
  LocalAudioTrack,
  LocalTrackPublication,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';
import type { Api } from './api';
import { Store } from './store';
import { presetById, settings, type Settings } from './settings';
import { sounds } from './sounds';
import { iceTargetsFor, setIceOverride } from './ice';
import { pickCodec } from './hw';

export interface StreamInfo {
  userId: number;
  identity: string;
  local: boolean;
}

export interface VoiceState {
  channelId: number | null;
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting';
  error: string | null;
  muted: boolean;
  deafened: boolean;
  transmitting: boolean;
  speaking: number[];
  streaming: boolean;
  streams: StreamInfo[];
  quality: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
  micLevelDb: number;
  watching: string[]; // identity streamova koje gledam
  viewers: Record<string, number[]>; // identity streamera -> userId gledalaca
}

const INITIAL: VoiceState = {
  channelId: null,
  status: 'idle',
  error: null,
  muted: false,
  deafened: false,
  transmitting: false,
  speaking: [],
  streaming: false,
  streams: [],
  quality: 'unknown',
  micLevelDb: -100,
  watching: [],
  viewers: {},
};

// AudioWorklet radi na audio niti, pa ga Windows/Chromium ne usporava kad je igra u prvom planu.
const LEVEL_WORKLET = `
class LpLevel extends AudioWorkletProcessor {
  constructor() { super(); this.acc = 0; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let s = 0;
      for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
      this.acc += s; this.n += ch.length;
      if (this.n >= 960) { this.port.postMessage(Math.sqrt(this.acc / this.n)); this.acc = 0; this.n = 0; }
    }
    return true;
  }
}
registerProcessor('lp-level', LpLevel);
`;

const VAD_HOLD_MS = 350;

export class VoiceManager {
  readonly store = new Store<VoiceState>({ ...INITIAL });
  private room: Room | null = null;
  private mic: LocalAudioTrack | null = null;
  private analyser: { ctx: AudioContext; clone: MediaStreamTrack } | null = null;
  private vadActive = false;
  private lastAboveThreshold = 0;
  private pttDown = false;
  private pttReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSettings: Settings = settings.get();
  private joinSeq = 0;
  private connectedAt = 0;

  constructor(private api: Api) {
    settings.subscribe((s) => this.onSettings(s));
  }

  getRoom(): Room | null {
    return this.room;
  }

  // ---------- ulaz / izlaz ----------

  async join(channelId: number) {
    if (this.store.get().channelId === channelId && this.room) return;
    await this.leave(false);
    const seq = ++this.joinSeq;
    this.connectedAt = 0;
    this.store.set({ channelId, status: 'connecting', error: null, streams: [], speaking: [], streaming: false });
    const s = settings.get();
    try {
      const { token, url } = await this.api.voiceToken(channelId);
      setIceOverride(await iceTargetsFor(this.api.baseUrl));
      if (seq !== this.joinSeq) return;
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        webAudioMix: true,
        audioCaptureDefaults: this.captureOptions(s),
        audioOutput: { deviceId: s.outputDeviceId },
        publishDefaults: {
          audioPreset: AudioPresets.music,
          dtx: true,
          red: true,
        },
        disconnectOnPageLeave: true,
      });
      this.room = room;
      this.bindRoomEvents(room);
      await room.connect(url, token, { autoSubscribe: false });
      this.subscribeDefaults(room);
      if (seq !== this.joinSeq) {
        await room.disconnect();
        return;
      }
      const mic = await createLocalAudioTrack(this.captureOptions(s));
      this.mic = mic;
      await room.localParticipant.publishTrack(mic, { source: Track.Source.Microphone, audioPreset: AudioPresets.music, dtx: true, red: true });
      await room.startAudio().catch(() => {});
      await this.setupAnalyser();
      this.applyGate();
      this.applyVolumes();
      this.store.set({ status: 'connected' });
      this.connectedAt = Date.now();
      this.refreshStreams();
      sounds.selfJoin();
      void this.reportState(true);
    } catch (err: any) {
      if (seq !== this.joinSeq) return;
      await this.cleanup();
      const raw = String(err?.message || '');
      const msg =
        err?.name === 'NotAllowedError'
          ? 'Aplikacija nema pristup mikrofonu. Dozvoli mikrofon u Windows postavkama (Privatnost → Mikrofon).'
          : err?.name === 'NotFoundError'
            ? 'Nije pronađen mikrofon. Provjeri da je priključen i izabran u postavkama.'
            : /signal|websocket|could not establish/i.test(raw)
              ? 'Ne mogu se spojiti na glasovni server. Provjeri da server radi (LiveKit) i da je port 8080 otvoren.'
              : /pc connection|ice|peer connection|timed out|timeout/i.test(raw)
                ? 'Glasovni server je dostupan, ali glas ne prolazi. Provjeri da su na ruteru otvoreni UDP 7882 i TCP 7881.'
                : raw || 'Spajanje na glasovni kanal nije uspjelo.';
      this.store.set({ ...INITIAL, muted: this.store.get().muted, deafened: this.store.get().deafened, error: msg });
    }
  }

  async leave(playSound = true) {
    this.joinSeq++;
    const wasIn = this.store.get().channelId !== null;
    await this.cleanup();
    const { muted, deafened } = this.store.get();
    this.store.set({ ...INITIAL, muted, deafened });
    if (wasIn) {
      if (playSound) sounds.selfLeave();
      void this.api.voiceState({ channelId: null }).catch(() => {});
    }
  }

  private async cleanup() {
    this.teardownAnalyser();
    const room = this.room;
    this.room = null;
    this.mic = null;
    if (room) {
      room.removeAllListeners();
      await room.disconnect().catch(() => {});
    }
    document.querySelectorAll('[data-lp-audio]').forEach((el) => el.remove());
  }

  // ---------- kontrole ----------

  toggleMute() {
    const { muted, deafened } = this.store.get();
    if (deafened) {
      // Kao na Discordu: unmute kad si deafen-ovan skida i deafen.
      this.store.set({ muted: false, deafened: false });
    } else {
      this.store.set({ muted: !muted });
    }
    this.store.get().muted ? sounds.mute() : sounds.unmute();
    this.applyGate();
    this.applyVolumes();
    void this.reportState();
  }

  toggleDeafen() {
    const { deafened } = this.store.get();
    this.store.set({ deafened: !deafened, muted: !deafened ? true : false });
    this.store.get().deafened ? sounds.deafen() : sounds.undeafen();
    this.applyGate();
    this.applyVolumes();
    void this.reportState();
  }

  setPtt(pressed: boolean) {
    if (this.pttReleaseTimer) {
      clearTimeout(this.pttReleaseTimer);
      this.pttReleaseTimer = null;
    }
    if (pressed) {
      this.pttDown = true;
      this.applyGate();
    } else {
      this.pttReleaseTimer = setTimeout(() => {
        this.pttDown = false;
        this.applyGate();
      }, settings.get().pttReleaseMs);
    }
  }

  setUserVolume(userId: number, volume: number) {
    const s = settings.get();
    settings.set({ userVolumes: { ...s.userVolumes, [String(userId)]: volume } });
  }

  // ---------- stream ekrana ----------

  async startScreenShare(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const s = settings.get();
    const preset = presetById(s.streamPreset);
    const bitrate = s.streamBitrateOverride ?? preset.bitrate;
    try {
      const videoCodec = s.streamCodec === 'auto' ? await pickCodec(preset.width, preset.height, preset.fps, bitrate) : s.streamCodec;
      await room.localParticipant.setScreenShareEnabled(
        true,
        {
          audio: s.streamAudio,
          resolution: { width: preset.width, height: preset.height, frameRate: preset.fps },
          contentHint: 'motion',
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          systemAudio: s.streamAudio ? 'include' : 'exclude',
        },
        {
          videoCodec,
          backupCodec: false,
          simulcast: false,
          screenShareEncoding: { maxBitrate: bitrate, maxFramerate: preset.fps, priority: 'high' },
          degradationPreference: 'maintain-framerate',
        },
      );
      this.store.set({ streaming: room.localParticipant.isScreenShareEnabled });
      if (room.localParticipant.isScreenShareEnabled) sounds.streamStart();
      this.refreshStreams();
      void this.reportState();
    } catch (err: any) {
      if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return; // korisnik otkazao
      this.store.set({ error: `Stream nije pokrenut: ${err?.message || err}` });
    }
  }

  async stopScreenShare() {
    const room = this.room;
    if (!room) return;
    await room.localParticipant.setScreenShareEnabled(false).catch(() => {});
    this.store.set({ streaming: false });
    sounds.streamStop();
    this.refreshStreams();
    void this.reportState();
  }

  clearError() {
    this.store.set({ error: null });
  }

  // Gledanje streama: tek tada se video (i zvuk streama) skida sa servera.
  setWatching(identity: string, watch: boolean) {
    const room = this.room;
    if (!room) return;
    const cur = this.store.get().watching;
    const next = watch ? [...new Set([...cur, identity])] : cur.filter((x) => x !== identity);
    this.store.set({ watching: next });
    const p = room.remoteParticipants.get(identity);
    if (p) {
      p.getTrackPublication(Track.Source.ScreenShare)?.setSubscribed(watch);
      p.getTrackPublication(Track.Source.ScreenShareAudio)?.setSubscribed(watch);
    }
    void room.localParticipant.setAttributes({ watching: next.join(',') }).catch(() => {});
  }

  private subscribeDefaults(room: Room) {
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) this.autoSubscribe(pub);
    }
    this.recomputeViewers();
  }

  private autoSubscribe(pub: RemoteTrackPublication) {
    if (pub.source === Track.Source.Microphone) pub.setSubscribed(true);
  }

  private recomputeViewers() {
    const room = this.room;
    if (!room) return;
    const viewers: Record<string, number[]> = {};
    for (const p of room.remoteParticipants.values()) {
      const list = (p.attributes?.watching || '').split(',').filter(Boolean);
      for (const streamer of list) (viewers[streamer] ||= []).push(Number(p.identity));
    }
    const me = room.localParticipant.identity;
    const before = this.store.get().viewers[me]?.length || 0;
    const after = viewers[me]?.length || 0;
    if (this.store.get().streaming && after > before) sounds.viewer();
    this.store.set({ viewers });
  }

  // ---------- interno ----------

  private captureOptions(s: Settings) {
    return {
      deviceId: s.inputDeviceId === 'default' ? undefined : s.inputDeviceId,
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl,
      channelCount: 1,
    };
  }

  private shouldTransmit(): boolean {
    const { muted, deafened } = this.store.get();
    if (muted || deafened || !this.mic) return false;
    const mode = settings.get().voiceMode;
    if (mode === 'open') return true;
    if (mode === 'ptt') return this.pttDown;
    return this.vadActive;
  }

  private applyGate() {
    const send = this.shouldTransmit();
    if (this.store.get().transmitting !== send) this.store.set({ transmitting: send });
    const mic = this.mic;
    if (!mic) return;
    if (send && mic.isMuted) void mic.unmute();
    else if (!send && !mic.isMuted) void mic.mute();
  }

  private applyVolumes() {
    const room = this.room;
    if (!room) return;
    const s = settings.get();
    const deaf = this.store.get().deafened;
    for (const p of room.remoteParticipants.values()) {
      const base = deaf ? 0 : s.outputVolume * (s.userVolumes[p.identity] ?? 1);
      p.setVolume(base, Track.Source.Microphone);
      p.setVolume(deaf ? 0 : s.outputVolume, Track.Source.ScreenShareAudio);
    }
  }

  private async setupAnalyser() {
    this.teardownAnalyser();
    const mic = this.mic;
    if (!mic) return;
    const clone = mic.mediaStreamTrack.clone();
    clone.enabled = true;
    const ctx = new AudioContext();
    try {
      const url = URL.createObjectURL(new Blob([LEVEL_WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const src = ctx.createMediaStreamSource(new MediaStream([clone]));
      const node = new AudioWorkletNode(ctx, 'lp-level');
      node.port.onmessage = (e: MessageEvent<number>) => this.onLevel(e.data);
      src.connect(node);
      // Worklet mora biti spojen na izlaz da bi radio; tihi gain da se ništa ne čuje.
      const silent = ctx.createGain();
      silent.gain.value = 0;
      node.connect(silent).connect(ctx.destination);
      this.analyser = { ctx, clone };
    } catch {
      clone.stop();
      await ctx.close().catch(() => {});
      // Bez analizatora: aktivacija glasom se ponaša kao otvoren mikrofon.
      this.vadActive = true;
    }
  }

  private teardownAnalyser() {
    if (!this.analyser) return;
    this.analyser.clone.stop();
    void this.analyser.ctx.close().catch(() => {});
    this.analyser = null;
  }

  private levelTick = 0;
  private onLevel(rms: number) {
    const db = 20 * Math.log10(rms + 1e-9);
    const now = performance.now();
    if (db > settings.get().vadThresholdDb) this.lastAboveThreshold = now;
    const active = now - this.lastAboveThreshold < VAD_HOLD_MS;
    if (active !== this.vadActive) {
      this.vadActive = active;
      this.applyGate();
    }
    // UI metar osvježavamo rjeđe (svakih ~100 ms).
    if (++this.levelTick % 5 === 0) this.store.set({ micLevelDb: Math.max(-100, db) });
  }

  private onSettings(s: Settings) {
    const prev = this.lastSettings;
    this.lastSettings = s;
    const room = this.room;
    if (!room) return;
    if (
      this.mic &&
      (prev.inputDeviceId !== s.inputDeviceId ||
        prev.noiseSuppression !== s.noiseSuppression ||
        prev.echoCancellation !== s.echoCancellation ||
        prev.autoGainControl !== s.autoGainControl)
    ) {
      void this.mic.restartTrack(this.captureOptions(s)).then(() => this.setupAnalyser()).then(() => this.applyGate());
    }
    if (prev.outputDeviceId !== s.outputDeviceId) {
      void room.switchActiveDevice('audiooutput', s.outputDeviceId).catch(() => {});
    }
    if (prev.voiceMode !== s.voiceMode) this.applyGate();
    if (prev.outputVolume !== s.outputVolume || prev.userVolumes !== s.userVolumes) this.applyVolumes();
  }

  private bindRoomEvents(room: Room) {
    room
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        this.store.set({ speaking: speakers.map((p) => Number(p.identity)).filter(Number.isFinite) });
      })
      .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
        sounds.join();
        this.applyVolumesFor(p);
      })
      .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
        sounds.leave();
        if (this.store.get().watching.includes(p.identity)) {
          this.store.set({ watching: this.store.get().watching.filter((x) => x !== p.identity) });
        }
        this.refreshStreams();
        this.recomputeViewers();
      })
      .on(RoomEvent.ParticipantAttributesChanged, () => this.recomputeViewers())
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
        // Mikrofon drugih se pušta odmah; zvuk streama tek kad ga gledaš (StreamTile).
        if (track.kind === Track.Kind.Audio && pub.source === Track.Source.Microphone) {
          const el = track.attach();
          el.dataset.lpAudio = p.identity;
          document.body.appendChild(el);
        }
        this.applyVolumesFor(p);
        this.refreshStreams();
      })
      .on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication, p: RemoteParticipant) => {
        this.autoSubscribe(pub);
        if (pub.source === Track.Source.ScreenShare) {
          sounds.streamStart();
          if (this.store.get().watching.includes(p.identity)) pub.setSubscribed(true);
        }
        if (pub.source === Track.Source.ScreenShareAudio && this.store.get().watching.includes(p.identity)) pub.setSubscribed(true);
        this.refreshStreams();
      })
      .on(RoomEvent.TrackUnpublished, (pub: RemoteTrackPublication) => {
        if (pub.source === Track.Source.ScreenShare) sounds.streamStop();
        this.refreshStreams();
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => el.remove());
        this.refreshStreams();
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
        if (pub.source === Track.Source.ScreenShare) {
          this.store.set({ streaming: false });
          this.refreshStreams();
          void this.reportState();
        }
      })
      .on(RoomEvent.ConnectionQualityChanged, (q: ConnectionQuality, p: Participant) => {
        if (p.identity === room.localParticipant.identity) this.store.set({ quality: q as VoiceState['quality'] });
      })
      .on(RoomEvent.Reconnecting, () => this.store.set({ status: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => {
        this.store.set({ status: 'connected' });
        void this.reportState(true);
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (this.room !== room) return;
        const msg =
          reason === DisconnectReason.DUPLICATE_IDENTITY
            ? 'Spojio si se na glasovni kanal s drugog uređaja.'
            : reason === DisconnectReason.PARTICIPANT_REMOVED
              ? 'Admin te izbacio iz glasovnog kanala.'
              : reason === DisconnectReason.CLIENT_INITIATED
                ? null
                : this.connectedAt === 0 || Date.now() - this.connectedAt < 45_000
                  ? 'Glasovni server je dostupan, ali glas ne prolazi. Provjeri da LiveKit radi i da su TCP 7881 i UDP 7882 otvoreni (firewall/ruter).'
                  : 'Veza s glasovnim serverom je prekinuta.';
        void this.leave(false).then(() => {
          if (msg) this.store.set({ error: msg });
        });
      })
      .on(RoomEvent.MediaDevicesError, (e: Error) => {
        this.store.set({ error: `Problem s uređajem: ${e.message}` });
      });
  }

  private applyVolumesFor(p: RemoteParticipant) {
    const s = settings.get();
    const deaf = this.store.get().deafened;
    p.setVolume(deaf ? 0 : s.outputVolume * (s.userVolumes[p.identity] ?? 1), Track.Source.Microphone);
    p.setVolume(deaf ? 0 : s.outputVolume, Track.Source.ScreenShareAudio);
  }

  private refreshStreams() {
    const room = this.room;
    if (!room) return;
    const streams: StreamInfo[] = [];
    const lp = room.localParticipant;
    if (lp.getTrackPublication(Track.Source.ScreenShare)?.track) {
      streams.push({ userId: Number(lp.identity), identity: lp.identity, local: true });
    }
    for (const p of room.remoteParticipants.values()) {
      if (p.getTrackPublication(Track.Source.ScreenShare)) {
        streams.push({ userId: Number(p.identity), identity: p.identity, local: false });
      }
    }
    this.store.set({ streams });
  }

  private async reportState(includeChannel = false) {
    const { channelId, muted, deafened, streaming } = this.store.get();
    if (channelId === null) return;
    try {
      await this.api.voiceState({ ...(includeChannel ? { channelId } : {}), muted, deafened, streaming });
    } catch {
      /* nije kritično */
    }
  }
}
