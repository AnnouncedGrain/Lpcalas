import { useEffect, useRef, useState } from 'react';
import { Track, type LocalVideoTrack, type RemoteVideoTrack } from 'livekit-client';
import { useApp, useClient, useSettings, useVoice } from '../lib/context';
import { isTauri } from '../lib/native';
import { presetById, settings } from '../lib/settings';
import type { StreamInfo } from '../lib/voice';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

export function VoiceView() {
  const client = useClient();
  const channelId = useVoice((v) => v.channelId);
  const status = useVoice((v) => v.status);
  const streams = useVoice((v) => v.streams);
  const streaming = useVoice((v) => v.streaming);
  const speaking = useVoice((v) => v.speaking);
  const channel = useApp((s) => s.channels.find((c) => c.id === channelId));
  const members = useApp((s) => (channelId !== null ? s.voice[channelId] || [] : []));
  const users = useApp((s) => s.users);
  const s = useSettings();
  const [focused, setFocused] = useState<string | null>(null);
  const [watching, setWatching] = useState<Set<string>>(new Set());

  // Ako fokusirani stream nestane, makni fokus.
  useEffect(() => {
    if (focused && !streams.some((x) => x.identity === focused)) setFocused(null);
  }, [streams, focused]);

  if (channelId === null) {
    return (
      <section className="voice-view empty">
        <Icon name="volume" size={48} />
        <h2>Nisi u glasovnom kanalu</h2>
        <p className="muted">Klikni na glasovni kanal lijevo da uđeš.</p>
      </section>
    );
  }

  const focusedStream = streams.find((x) => x.identity === focused) || null;
  const preset = presetById(s.streamPreset);

  return (
    <section className="voice-view">
      <header className="chat-header">
        <Icon name="volume" size={22} className="muted" />
        <h2>{channel?.name}</h2>
        <span className="spacer" />
        {status === 'connected' && (
          <>
            <select
              className="compact-select"
              value={s.streamPreset}
              onChange={(e) => settings.set({ streamPreset: e.target.value })}
              title="Kvalitet streama"
              disabled={streaming}
            >
              <option value="720p30">720p30</option>
              <option value="1080p30">1080p30</option>
              <option value="1080p60">1080p60</option>
              <option value="1440p60">1440p60</option>
              <option value="2160p60">4K60</option>
            </select>
            <button
              className={streaming ? 'danger' : 'primary'}
              onClick={() => (streaming ? client.voice.stopScreenShare() : client.voice.startScreenShare())}
            >
              <Icon name={streaming ? 'screenOff' : 'screen'} size={18} />
              {streaming ? 'Zaustavi stream' : `Streamaj (${preset.height}p${preset.fps})`}
            </button>
          </>
        )}
      </header>

      {status === 'connecting' && <div className="voice-connecting">Spajam se na glasovni server...</div>}

      {focusedStream ? (
        <div className="stream-focus">
          <StreamTile
            key={focusedStream.identity}
            info={focusedStream}
            name={users[focusedStream.userId]?.displayName || '?'}
            large
            watching
            onUnfocus={() => setFocused(null)}
          />
        </div>
      ) : null}

      <div className={`voice-grid ${focusedStream ? 'compact' : ''}`}>
        {streams
          .filter((x) => x.identity !== focused)
          .map((x) => (
            <StreamTile
              key={x.identity}
              info={x}
              name={users[x.userId]?.displayName || '?'}
              watching={x.local || watching.has(x.identity)}
              onWatch={() => setWatching((w) => new Set(w).add(x.identity))}
              onFocus={() => {
                setWatching((w) => new Set(w).add(x.identity));
                setFocused(x.identity);
              }}
            />
          ))}
        {members.map((m) => {
          const u = users[m.userId];
          return (
            <div key={m.userId} className={`participant-tile ${speaking.includes(m.userId) ? 'speaking' : ''}`}>
              <Avatar user={u} size={72} baseUrl={client.api.baseUrl} speaking={speaking.includes(m.userId)} />
              <div className="participant-name">
                {u?.displayName || '...'}
                {m.muted && !m.deafened && <Icon name="micOff" size={14} />}
                {m.deafened && <Icon name="headphonesOff" size={14} />}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StreamTile({
  info,
  name,
  large = false,
  watching,
  onWatch,
  onFocus,
  onUnfocus,
}: {
  info: StreamInfo;
  name: string;
  large?: boolean;
  watching: boolean;
  onWatch?: () => void;
  onFocus?: () => void;
  onUnfocus?: () => void;
}) {
  const client = useClient();
  const streams = useVoice((v) => v.streams);
  const s = useSettings();
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [showStats, setShowStats] = useState(s.showStreamStats);
  const [streamVolume, setStreamVolume] = useState(1);

  // Spoji video (i zvuk streama) na element dok gledaš.
  useEffect(() => {
    const room = client.voice.getRoom();
    const el = videoRef.current;
    if (!room || !el || !watching) return;
    const p = info.local ? room.localParticipant : room.getParticipantByIdentity(info.identity);
    const videoTrack = p?.getTrackPublication(Track.Source.ScreenShare)?.track;
    const audioTrack = info.local ? undefined : p?.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
    videoTrack?.attach(el);
    let audioEl: HTMLMediaElement | undefined;
    if (audioTrack) {
      audioEl = audioTrack.attach();
      document.body.appendChild(audioEl);
    }
    return () => {
      videoTrack?.detach(el);
      if (audioTrack && audioEl) {
        audioTrack.detach(audioEl);
        audioEl.remove();
      }
    };
  }, [client, info.identity, info.local, watching, streams]);

  useEffect(() => {
    const room = client.voice.getRoom();
    const p = room?.getParticipantByIdentity(info.identity);
    if (p && !info.local && 'setVolume' in p) {
      (p as any).setVolume(streamVolume * settings.get().outputVolume, Track.Source.ScreenShareAudio);
    }
  }, [client, info.identity, info.local, streamVolume]);

  async function toggleFullscreen() {
    const next = !fullscreen;
    setFullscreen(next);
    if (isTauri) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setFullscreen(next).catch(() => {});
    } else if (next) {
      await wrapRef.current?.requestFullscreen().catch(() => {});
    } else if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    }
  }

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div ref={wrapRef} className={`stream-tile ${large ? 'large' : ''} ${fullscreen ? 'fullscreen' : ''}`}>
      {watching ? (
        <video ref={videoRef} autoPlay playsInline muted onDoubleClick={() => void toggleFullscreen()} />
      ) : (
        <div className="stream-placeholder">
          <span className="live-tag">UŽIVO</span>
          <p>{name} streama</p>
          <button className="primary" onClick={onWatch}>
            <Icon name="eye" size={18} /> Gledaj stream
          </button>
        </div>
      )}
      <div className="stream-bar">
        <span className="live-tag">UŽIVO</span>
        <span className="stream-name">{info.local ? `${name} (ti)` : name}</span>
        <span className="spacer" />
        {watching && !info.local && (
          <input
            type="range"
            className="stream-volume"
            min={0}
            max={1.5}
            step={0.05}
            value={streamVolume}
            onChange={(e) => setStreamVolume(Number(e.target.value))}
            title={`Zvuk streama: ${Math.round(streamVolume * 100)}%`}
          />
        )}
        {watching && (
          <button className="icon-btn small" title="Statistika" onClick={() => setShowStats((x) => !x)}>
            <Icon name="signal" size={16} />
          </button>
        )}
        {onFocus && watching && (
          <button className="icon-btn small" title="Uvećaj" onClick={onFocus}>
            <Icon name="maximize" size={16} />
          </button>
        )}
        {onUnfocus && (
          <button className="icon-btn small" title="Smanji" onClick={onUnfocus}>
            <Icon name="x" size={16} />
          </button>
        )}
        {watching && (
          <button className="icon-btn small" title="Preko cijelog ekrana (dupli klik)" onClick={() => void toggleFullscreen()}>
            <Icon name="maximize" size={16} />
          </button>
        )}
      </div>
      {watching && showStats && <StreamStats info={info} />}
    </div>
  );
}

interface StatsView {
  resolution: string;
  fps: number;
  bitrateKbps: number;
  codec: string;
  impl: string;
  hardware: boolean | null;
  limitation?: string;
  dropped?: number;
  encodeMs?: number;
}

function StreamStats({ info }: { info: StreamInfo }) {
  const client = useClient();
  const [stats, setStats] = useState<StatsView | null>(null);

  useEffect(() => {
    let prevBytes = 0;
    let prevTs = 0;
    const tick = async () => {
      const room = client.voice.getRoom();
      const p = info.local ? room?.localParticipant : room?.getParticipantByIdentity(info.identity);
      const track = p?.getTrackPublication(Track.Source.ScreenShare)?.track as LocalVideoTrack | RemoteVideoTrack | undefined;
      if (!track) return;
      const rtc: RTCRtpSender | RTCRtpReceiver | undefined = info.local ? (track as LocalVideoTrack).sender : (track as RemoteVideoTrack).receiver;
      if (!rtc) return;
      const report = await rtc.getStats();
      let main: any = null;
      const codecs = new Map<string, any>();
      report.forEach((r: any) => {
        if (r.type === 'codec') codecs.set(r.id, r);
        if ((r.type === 'outbound-rtp' || r.type === 'inbound-rtp') && r.kind === 'video') {
          if (!main || (r.bytesSent ?? r.bytesReceived ?? 0) > (main.bytesSent ?? main.bytesReceived ?? 0)) main = r;
        }
      });
      if (!main) return;
      const bytes = main.bytesSent ?? main.bytesReceived ?? 0;
      const ts = main.timestamp;
      const kbps = prevTs ? ((bytes - prevBytes) * 8) / (ts - prevTs) : 0;
      prevBytes = bytes;
      prevTs = ts;
      const codec = codecs.get(main.codecId)?.mimeType?.replace('video/', '') || '?';
      setStats({
        resolution: main.frameWidth ? `${main.frameWidth}×${main.frameHeight}` : '?',
        fps: Math.round(main.framesPerSecond || 0),
        bitrateKbps: Math.round(kbps),
        codec,
        impl: main.encoderImplementation || main.decoderImplementation || '?',
        hardware: main.powerEfficientEncoder ?? main.powerEfficientDecoder ?? null,
        limitation: main.qualityLimitationReason,
        dropped: main.framesDropped,
        encodeMs: main.framesEncoded ? Math.round((main.totalEncodeTime / main.framesEncoded) * 1000 * 10) / 10 : undefined,
      });
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => clearInterval(t);
  }, [client, info.identity, info.local]);

  if (!stats) return <div className="stream-stats">Učitavam statistiku...</div>;
  const text = [
    `${stats.resolution} @ ${stats.fps} fps`,
    `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps · ${stats.codec}`,
    `${info.local ? 'Enkoder' : 'Dekoder'}: ${stats.impl}${stats.hardware === null ? '' : stats.hardware ? ' (hardverski ✓)' : ' (softverski ✗)'}`,
    stats.encodeMs !== undefined ? `Enkodiranje: ${stats.encodeMs} ms/frame` : null,
    stats.limitation && stats.limitation !== 'none' ? `Ograničenje: ${stats.limitation === 'cpu' ? 'procesor' : stats.limitation === 'bandwidth' ? 'internet' : stats.limitation}` : null,
    stats.dropped ? `Izgubljeno frameova: ${stats.dropped}` : null,
  ].filter(Boolean);
  return (
    <div className="stream-stats">
      {text.map((t) => (
        <div key={t}>{t}</div>
      ))}
      <button
        className="link small"
        onClick={() => void navigator.clipboard.writeText(`Lpcalas stream (${info.local ? 'slanje' : 'prijem'})\n` + text.join('\n'))}
      >
        Kopiraj dijagnostiku
      </button>
    </div>
  );
}
