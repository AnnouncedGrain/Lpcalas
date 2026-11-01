export type VoiceMode = 'vad' | 'ptt' | 'open';
export type StreamCodec = 'h264' | 'vp9' | 'av1' | 'vp8';

export interface HotkeyBinding {
  vk: number;
  name: string;
}

export interface StreamPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number; // bps
}

export const STREAM_PRESETS: StreamPreset[] = [
  { id: '720p30', label: '720p · 30 fps (štedi internet)', width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  { id: '1080p30', label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 4_500_000 },
  { id: '1080p60', label: '1080p · 60 fps (preporučeno)', width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
  { id: '1440p60', label: '1440p · 60 fps', width: 2560, height: 1440, fps: 60, bitrate: 12_000_000 },
  { id: '2160p60', label: '4K · 60 fps (jak upload)', width: 3840, height: 2160, fps: 60, bitrate: 20_000_000 },
];

export interface Settings {
  inputDeviceId: string;
  outputDeviceId: string;
  voiceMode: VoiceMode;
  vadThresholdDb: number; // -70 .. -10
  pttReleaseMs: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  outputVolume: number; // 0..2
  userVolumes: Record<string, number>; // userId -> 0..2
  hotkeys: { ptt: HotkeyBinding | null; toggleMute: HotkeyBinding | null; toggleDeafen: HotkeyBinding | null };
  streamPreset: string;
  streamCodec: StreamCodec;
  streamBitrateOverride: number | null; // bps
  streamAudio: boolean;
  sounds: boolean;
  showStreamStats: boolean;
}

const DEFAULTS: Settings = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  voiceMode: 'vad',
  vadThresholdDb: -50,
  pttReleaseMs: 200,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  outputVolume: 1,
  userVolumes: {},
  hotkeys: { ptt: null, toggleMute: null, toggleDeafen: null },
  streamPreset: '1080p60',
  streamCodec: 'h264',
  streamBitrateOverride: null,
  streamAudio: true,
  sounds: true,
  showStreamStats: false,
};

const KEY = 'lpcalas.settings.v1';
type Listener = (s: Settings) => void;

class SettingsStore {
  private value: Settings;
  private listeners = new Set<Listener>();

  constructor() {
    let stored: Partial<Settings> = {};
    try {
      stored = JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch {
      /* oštećeno - koristi default */
    }
    this.value = { ...DEFAULTS, ...stored, hotkeys: { ...DEFAULTS.hotkeys, ...(stored.hotkeys || {}) } };
  }

  get(): Settings {
    return this.value;
  }

  set(patch: Partial<Settings>) {
    this.value = { ...this.value, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value));
    } catch {
      /* pun storage */
    }
    for (const l of this.listeners) l(this.value);
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const settings = new SettingsStore();

export function presetById(id: string): StreamPreset {
  return STREAM_PRESETS.find((p) => p.id === id) || STREAM_PRESETS[2];
}

// ---- sesija (adresa servera + token) ----

const SESSION_KEY = 'lpcalas.session.v1';

export interface SavedSession {
  serverUrl: string;
  token: string | null;
  username?: string;
}

export function loadSession(): SavedSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s && typeof s.serverUrl === 'string' ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: SavedSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}
