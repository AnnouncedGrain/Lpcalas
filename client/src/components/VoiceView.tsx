import { useEffect, useRef, useState } from 'react';
import { Track, type LocalVideoTrack, type RemoteVideoTrack } from 'livekit-client';
import { useApp, useClient, useSettings, useVoice } from '../lib/context';
import { isTauri } from '../lib/native';
import { presetById, settings } from '../lib/settings';
import { gpuName } from '../lib/hw';
import type { StreamInfo } from '../lib/voice';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

// Preko cijelog ekrana: jedno mjesto koje pali/gasi i Windows prozor, da ne ostane "zaglavljen".
async function setWindowFullscreen(on: boolean) {
  if (isTauri) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setFullscreen(on);
    } catch {
      /* ignore */
    }
  } else if (on) {
    await document.documentElement.requestFullscreen?.().catch(() => {});
  } else if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
  }
}

export function VoiceView() {
  const client = useClient();
  const channelId = useVoice((v) => v.channelId);
  const status = useVoice((v) => v.status);
  const streams = useVoice((v) => v.streams);
  const streaming = useVoice((v) => v.streaming);
  const speaking = useVoice((v) => v.speaking);
  const watching = useVoice((v) => v.watching);
  const viewers = useVoice((v) => v.viewers);
  const channel = useApp((s) => s.channels.find((c) => c.id === channelId));
  const members = useApp((s) => (channelId !== null ? s.voice[channelId] || [] : []));
  const users = useApp((s) => s.users);
  const meId = useApp((s) => s.me.id);
  const s = useSettings();
  const [fullscreen, setFullscreen] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridW, setGridW] = useState(0);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setGridW(el.clientWidth));
    ro.observe(el);
    setGridW(el.clientWidth);
    return () => ro.disconnect();
  });

  // Ako stream nestane dok je preko cijelog ekrana, izađi iz tog načina.
  useEffect(() => {
    if (fullscreen && !streams.some((x) => x.identity === fullscreen)) setFullscreen(null);
  }, [streams, fullscreen]);

  useEffect(() => {
    void setWindowFullscreen(fullscreen !== null);
  }, [fullscreen]);

  useEffect(() => () => void setWindowFullscreen(false), []);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFullscreen(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  if (channelId === null) {
    return (
      <section className="voice-view empty">
        <Icon name="volume" size={48} />
        <h2>Nisi u glasovnom kanalu</h2>
        <p className="muted">Klikni na glasovni kanal lijevo da uđeš.</p>
      </section>
    );
  }

  const preset = presetById(s.streamPreset);
  const myViewers = viewers[String(meId)] || [];
  const names = (ids: number[]) => ids.map((id) => users[id]?.displayName || '?').join(', ');
  const cols = Math.min(s.streamColumns || (streams.length <= 1 ? 1 : streams.length <= 4 ? 2 : 3), Math.max(1, streams.length));
  // Veličina pločice (16:9) računa se u pikselima: širina kolone, ali ne viša od ~68% ekrana.
  const GAP = 10;
  const PAD = 14;
  const tileW = Math.max(160, Math.min((gridW - PAD * 2 - GAP * (cols - 1)) / cols, (window.innerHeight * 0.68 * 16) / 9));
  const tileH = Math.round((tileW * 9) / 16);

  return (
    <section className="voice-view">
      <header className="chat-header">
        <Icon name="volume" size={22} className="muted" />
        <h2>{channel?.name}</h2>
        {streaming && (
          <span className="viewer-pill" title={myViewers.length ? `Gledaju: ${names(myViewers)}` : 'Niko još ne gleda'}>
            <Icon name="eye" size={15} /> {myViewers.length}
            <span className="viewer-names">{myViewers.length ? names(myViewers) : 'niko ne gleda'}</span>
          </span>
        )}
        <span className="spacer" />
        {streams.length > 1 && (
          <div className="layout-switch" title="Raspored streamova">
            <Icon name="grid" size={16} />
            {([0, 1, 2, 3] as const).map((n) => (
              <button key={n} className={s.streamColumns === n ? 'active' : ''} onClick={() => settings.set({ streamColumns: n })}>
                {n === 0 ? 'Auto' : n}
              </button>
            ))}
          </div>
        )}
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

      {streams.length > 0 && (
        <div ref={gridRef} className="stream-grid" style={{ gridTemplateColumns: `repeat(${cols}, ${Math.floor(tileW)}px)`, gap: GAP, padding: PAD }}>
          {streams.map((x) => (
            <StreamTile
              key={x.identity}
              info={x}
              name={users[x.userId]?.displayName || '?'}
              watching={x.local || watching.includes(x.identity)}
              viewerIds={viewers[x.identity] || []}
              viewerNames={names(viewers[x.identity] || [])}
              fullscreen={fullscreen === x.identity}
              onWatch={() => client.voice.setWatching(x.identity, true)}
              onStop={() => {
                if (fullscreen === x.identity) setFullscreen(null);
                client.voice.setWatching(x.identity, false);
              }}
              onToggleFullscreen={() => setFullscreen((f) => (f === x.identity ? null : x.identity))}
              size={{ width: Math.floor(tileW), height: tileH }}
            />
          ))}
        </div>
      )}

      <div className={`participant-strip ${streams.length ? 'compact' : ''}`}>
        {members.map((m) => {
          const u = users[m.userId];
          return (
            <div key={m.userId} className={`participant-tile ${speaking.includes(m.userId) ? 'speaking' : ''}`}>
              <Avatar user={u} size={streams.length ? 40 : 72} baseUrl={client.api.baseUrl} speaking={speaking.includes(m.userId)} />
              <div className="participant-name">
                {u?.displayName || '...'}
                {m.streaming && <span className="live-tag">UŽIVO</span>}
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
  watching,
  viewerIds,
  viewerNames,
  fullscreen,
  onWatch,
  onStop,
  onToggleFullscreen,
  size,
}: {
  info: StreamInfo;
  name: string;
  watching: boolean;
  viewerIds: number[];
  viewerNames: string;
  fullscreen: boolean;
  onWatch: () => void;
  onStop: () => void;
  onToggleFullscreen: () => void;
  size: { width: number; height: number };
}) {
  const client = useClient();
  const streams = useVoice((v) => v.streams);
  const s = useSettings();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showStats, setShowStats] = useState(s.showStreamStats);
  const [streamVolume, setStreamVolume] = useState(1);
  const [tick, setTick] = useState(0);

  // Spoji video (i zvuk streama) dok gledaš. Track stiže tek nakon pretplate, pa slušamo i događaje.
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
    const retry = !videoTrack ? setTimeout(() => setTick((t) => t + 1), 500) : undefined;
    return () => {
      clearTimeout(retry);
      videoTrack?.detach(el);
      if (audioTrack && audioEl) {
        audioTrack.detach(audioEl);
        audioEl.remove();
      }
    };
  }, [client, info.identity, info.local, watching, streams, tick]);

  useEffect(() => {
    const room = client.voice.getRoom();
    const p = room?.remoteParticipants.get(info.identity);
    if (p && !info.local) p.setVolume(streamVolume * settings.get().outputVolume, Track.Source.ScreenShareAudio);
  }, [client, info.identity, info.local, streamVolume, streams]);

  return (
    <div className={`stream-tile ${fullscreen ? 'fullscreen' : ''} ${info.local ? 'own' : ''}`} style={fullscreen ? undefined : size}>
      {watching ? (
        <video ref={videoRef} autoPlay playsInline muted onDoubleClick={onToggleFullscreen} />
      ) : (
        <div className="stream-placeholder">
          <span className="live-tag">UŽIVO</span>
          <p>{name} streama</p>
          <button className="primary" onClick={onWatch}>
            <Icon name="eye" size={18} /> Gledaj stream
          </button>
        </div>
      )}

      {watching && !info.local && (
        <button className="stream-close" title="Prestani gledati" onClick={onStop}>
          <Icon name="x" size={18} />
        </button>
      )}

      <div className="stream-bar">
        <span className="live-tag">UŽIVO</span>
        <span className="stream-name">{info.local ? `${name} (ti)` : name}</span>
        <span className="stream-viewers" title={viewerIds.length ? `Gledaju: ${viewerNames}` : 'Niko ne gleda'}>
          <Icon name="eye" size={14} /> {viewerIds.length}
        </span>
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
        {watching && (
          <button className="icon-btn small" title={fullscreen ? 'Izađi iz punog ekrana (Esc)' : 'Preko cijelog ekrana (dupli klik)'} onClick={onToggleFullscreen}>
            <Icon name={fullscreen ? 'minimize' : 'maximize'} size={16} />
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
        onClick={() => void navigator.clipboard.writeText(`Lpcalas stream (${info.local ? 'slanje' : 'prijem'}) · ${gpuName()}\n` + text.join('\n'))}
      >
        Kopiraj dijagnostiku
      </button>
    </div>
  );
}
