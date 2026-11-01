// Pop-out: stream u zasebnom prozoru koji se može pomjerati, povećavati i staviti iznad svega.
// Prozor dijeli memoriju s aplikacijom (window.open), pa nema nove veze ni dodatnog interneta —
// isti video se samo prikazuje na drugom mjestu.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp, useClient, useVoice } from '../lib/context';
import { isTauri } from '../lib/native';
import { settings } from '../lib/settings';
import type { StreamInfo } from '../lib/voice';
import { Icon } from './Icon';
import { StreamStats, useStreamMedia } from './VoiceView';
import { lang, t } from '../lib/i18n';

export function StreamPopouts() {
  const client = useClient();
  const popouts = useVoice((v) => v.popouts);
  const streams = useVoice((v) => v.streams);

  // Stream je završio (ili si izašao iz kanala) -> zatvori njegov prozor.
  useEffect(() => {
    for (const id of popouts) if (!streams.some((s) => s.identity === id)) client.voice.popIn(id);
  }, [client, popouts, streams]);

  return (
    <>
      {popouts.map((id) => {
        const info = streams.find((s) => s.identity === id);
        return info ? <PopoutWindow key={id} info={info} /> : null;
      })}
    </>
  );
}

// Naslov prozora je ujedno i način da ga Rust pronađe (za "uvijek iznad").
function windowTitle(name: string) {
  return `${name} · Lpcalas`;
}

function copyStyles(from: Document, to: Document) {
  to.head.querySelectorAll('style[data-lpcalas]').forEach((n) => n.remove());
  const css: string[] = [];
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      css.push(Array.from(sheet.cssRules).map((r) => r.cssText).join('\n'));
    } catch {
      /* strani stylesheet - preskoči */
    }
  }
  const style = to.createElement('style');
  style.dataset.lpcalas = '1';
  style.textContent = css.join('\n');
  to.head.appendChild(style);
}

function PopoutWindow({ info }: { info: StreamInfo }) {
  const client = useClient();
  const name = useApp((s) => s.users[info.userId]?.displayName || '?');
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const winRef = useRef<Window | null>(null);

  useEffect(() => {
    const w = window.open('', `lpcalas-stream-${info.userId}`, 'width=960,height=560');
    if (!w) {
      client.voice.popIn(info.identity);
      return;
    }
    winRef.current = w;
    const d = w.document;
    d.title = windowTitle(name);
    d.documentElement.lang = lang();
    copyStyles(document, d);
    d.body.innerHTML = '';
    d.body.className = 'popout-body';
    const root = d.createElement('div');
    root.className = 'popout-root';
    d.body.appendChild(root);
    setContainer(root);

    // Zatvaranje prozora (X) vraća stream u aplikaciju.
    const poll = setInterval(() => {
      if (w.closed) client.voice.popIn(info.identity);
    }, 400);
    const closeWithMain = () => w.close();
    window.addEventListener('beforeunload', closeWithMain);
    return () => {
      clearInterval(poll);
      window.removeEventListener('beforeunload', closeWithMain);
      setContainer(null);
      if (!w.closed) w.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, info.identity, info.userId]);

  useEffect(() => {
    if (winRef.current && !winRef.current.closed) winRef.current.document.title = windowTitle(name);
  }, [name]);

  if (!container || !winRef.current) return null;
  return createPortal(<PopoutContent info={info} name={name} win={winRef.current} />, container);
}

async function nativeControl(win: Window, action: 'pin' | 'unpin' | 'maximize'): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('popout_control', { title: win.document.title, action });
  } catch {
    return false;
  }
}

function PopoutContent({ info, name, win }: { info: StreamInfo; name: string; win: Window }) {
  const client = useClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [showStats, setShowStats] = useState(settings.get().showStreamStats);
  const [pinned, setPinned] = useState(false);
  const viewers = useVoice((v) => v.viewers[info.identity] || []);
  const users = useApp((s) => s.users);
  const viewerNames = viewers.map((id) => users[id]?.displayName || '?').join(', ');

  useStreamMedia(info, true, videoRef, volume, muted);

  const togglePin = async () => {
    if (await nativeControl(win, pinned ? 'unpin' : 'pin')) setPinned(!pinned);
  };
  const toggleMax = async () => {
    if (await nativeControl(win, 'maximize')) return;
    // U browseru: pravi fullscreen tog prozora.
    const d = win.document;
    if (d.fullscreenElement) await d.exitFullscreen().catch(() => {});
    else await d.documentElement.requestFullscreen?.().catch(() => {});
  };

  return (
    <div className={`stream-tile popout ${info.local ? 'own' : ''}`}>
      <video ref={videoRef} autoPlay playsInline muted onDoubleClick={() => void toggleMax()} />
      <div className="stream-bar">
        <span className="live-tag">{t('UŽIVO')}</span>
        <span className="stream-name">{info.local ? `${name} (${t('ti')})` : name}</span>
        <span className="stream-viewers" title={viewers.length ? `${t('Gledaju')}: ${viewerNames}` : t('Niko ne gleda')}>
          <Icon name="eye" size={14} /> {viewers.length}
        </span>
        <span className="spacer" />
        {!info.local && (
          <button
            className={`icon-btn small ${muted ? 'off' : ''}`}
            title={muted ? t('Uključi zvuk streama') : t('Isključi zvuk streama')}
            onClick={() => setMuted((m) => !m)}
          >
            <Icon name={muted ? 'volumeOff' : 'volume'} size={16} />
          </button>
        )}
        {!info.local && !muted && (
          <input
            type="range"
            className="stream-volume"
            min={0}
            max={1.5}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            title={t('Zvuk streama: {v}%', { v: Math.round(volume * 100) })}
          />
        )}
        <button className="icon-btn small" title={t('Statistika')} onClick={() => setShowStats((x) => !x)}>
          <Icon name="signal" size={16} />
        </button>
        {isTauri && (
          <button className={`icon-btn small ${pinned ? 'active' : ''}`} title={pinned ? t('Ne drži iznad drugih prozora') : t('Drži iznad drugih prozora')} onClick={() => void togglePin()}>
            <Icon name="pin" size={16} />
          </button>
        )}
        <button className="icon-btn small" title={t('Povećaj (dupli klik)')} onClick={() => void toggleMax()}>
          <Icon name="maximize" size={16} />
        </button>
        <button className="icon-btn small" title={t('Vrati u aplikaciju')} onClick={() => client.voice.popIn(info.identity)}>
          <Icon name="popin" size={16} />
        </button>
      </div>
      {showStats && <StreamStats info={info} />}
    </div>
  );
}
