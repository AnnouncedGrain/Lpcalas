import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp, useClient, useSettings } from '../lib/context';
import { captureKey, isTauri } from '../lib/native';
import { settings, STREAM_PRESETS, presetById, type HotkeyBinding, type StreamCodec, type VoiceMode } from '../lib/settings';
import type { Invite, User } from '../lib/types';
import { Avatar } from './Avatar';
import { checkEncoders, gpuName, type CodecSupport } from '../lib/hw';
import { sounds } from '../lib/sounds';
import { checkForUpdate, currentVersion, installUpdate, updateStore } from '../lib/updater';
import { useStore } from '../lib/store';
import { Icon } from './Icon';

type Tab = 'account' | 'voice' | 'stream' | 'keys' | 'app' | 'admin';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const me = useApp((s) => s.me);
  const [tab, setTab] = useState<Tab>('voice');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tabs: Array<[Tab, string]> = [
    ['account', 'Moj nalog'],
    ['voice', 'Glas'],
    ['stream', 'Stream'],
    ['keys', 'Tipke'],
    ['app', 'Aplikacija'],
  ];
  if (me.role === 'admin') tabs.push(['admin', 'Admin']);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-modal">
        <nav className="settings-nav">
          <div className="settings-nav-title">Postavke</div>
          {tabs.map(([id, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button className="icon-btn close-btn" onClick={onClose} title="Zatvori (Esc)">
            <Icon name="x" size={20} />
          </button>
          {tab === 'account' && <AccountTab />}
          {tab === 'voice' && <VoiceTab />}
          {tab === 'stream' && <StreamTab />}
          {tab === 'keys' && <KeysTab />}
          {tab === 'app' && <AppTab />}
          {tab === 'admin' && <AdminTab />}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <div className="settings-section">
      <h3>{title}</h3>
      {hint && <p className="muted small">{hint}</p>}
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle-row">
      <div>
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

// ---------------- Moj nalog ----------------

function AccountTab() {
  const client = useClient();
  const me = useApp((s) => s.me);
  const [displayName, setDisplayName] = useState(me.displayName);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function run(fn: () => Promise<unknown>, okText: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: okText });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  }

  return (
    <>
      <h2>Moj nalog</h2>
      <div className="account-card">
        <Avatar user={me} size={80} baseUrl={client.api.baseUrl} />
        <div>
          <div className="big-name">{me.displayName}</div>
          <div className="muted">@{me.username} · {me.role === 'admin' ? 'admin' : 'član'}</div>
          <button className="small" onClick={() => fileRef.current?.click()}>Promijeni sliku</button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void run(() => client.api.upload(f, f.name, undefined, undefined, '/api/me/avatar'), 'Slika promijenjena.');
            }}
          />
        </div>
      </div>

      <Section title="Ime za prikaz">
        <div className="row">
          <input value={displayName} maxLength={32} onChange={(e) => setDisplayName(e.target.value)} />
          <button className="primary" disabled={!displayName.trim() || displayName === me.displayName} onClick={() => run(() => client.api.updateMe({ displayName }), 'Ime sačuvano.')}>
            Sačuvaj
          </button>
        </div>
      </Section>

      <Section title="Promjena lozinke" hint="Nakon promjene, odjavit ćeš se na svim drugim uređajima.">
        <div className="col">
          <input type="password" placeholder="Trenutna lozinka" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <input type="password" placeholder="Nova lozinka (min 8 znakova)" value={next} onChange={(e) => setNext(e.target.value)} />
          <button
            className="primary"
            disabled={!current || next.length < 8}
            onClick={() =>
              run(async () => {
                await client.api.updateMe({ password: { current, new: next } });
                setCurrent('');
                setNext('');
              }, 'Lozinka promijenjena.')
            }
          >
            Promijeni lozinku
          </button>
        </div>
      </Section>

      {msg && <p className={msg.ok ? 'hint ok' : 'error'}>{msg.text}</p>}

      <Section title="Odjava">
        <button className="danger" onClick={() => void client.logout()}>
          <Icon name="logout" size={16} /> Odjavi se
        </button>
      </Section>
    </>
  );
}

// ---------------- Glas ----------------

function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        let list = await navigator.mediaDevices.enumerateDevices();
        // Bez dozvole nema imena uređaja - zatraži kratko pristup mikrofonu.
        if (list.some((d) => d.kind === 'audioinput' && !d.label)) {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          s.getTracks().forEach((t) => t.stop());
          list = await navigator.mediaDevices.enumerateDevices();
        }
        if (alive) setDevices(list);
      } catch {
        /* bez dozvole */
      }
    };
    void load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener('devicechange', load);
    };
  }, []);
  return devices;
}

function MicMeter({ thresholdDb }: { thresholdDb: number }) {
  const s = useSettings();
  const [level, setLevel] = useState(-100);
  const [testing, setTesting] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  async function start() {
    if (testing) {
      cleanup.current?.();
      cleanup.current = null;
      setTesting(false);
      setLevel(-100);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: s.inputDeviceId === 'default' ? undefined : { exact: s.inputDeviceId },
          noiseSuppression: s.noiseSuppression,
          echoCancellation: s.echoCancellation,
          autoGainControl: s.autoGainControl,
        },
      });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      let raf = 0;
      const loop = () => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        setLevel(20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9));
        raf = requestAnimationFrame(loop);
      };
      loop();
      cleanup.current = () => {
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
      };
      setTesting(true);
    } catch (e: any) {
      alert(`Mikrofon nije dostupan: ${e.message}`);
    }
  }

  const pct = (db: number) => Math.max(0, Math.min(100, ((db + 80) / 80) * 100));
  return (
    <div className="mic-meter-row">
      <div className="mic-meter">
        <div className={`mic-meter-fill ${level > thresholdDb ? 'active' : ''}`} style={{ width: `${pct(level)}%` }} />
        {s.voiceMode === 'vad' && <div className="mic-meter-threshold" style={{ left: `${pct(thresholdDb)}%` }} />}
      </div>
      <button className="small" onClick={() => void start()}>{testing ? 'Zaustavi test' : 'Testiraj mikrofon'}</button>
    </div>
  );
}

function VoiceTab() {
  const s = useSettings();
  const devices = useDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const outputs = devices.filter((d) => d.kind === 'audiooutput');
  const [capturing, setCapturing] = useState(false);

  async function setPttKey() {
    setCapturing(true);
    try {
      const b = await captureKey();
      if (b) settings.set({ hotkeys: { ...s.hotkeys, ptt: b } });
    } finally {
      setCapturing(false);
    }
  }

  return (
    <>
      <h2>Glas</h2>
      <div className="grid-2">
        <label>
          Mikrofon
          <select value={s.inputDeviceId} onChange={(e) => settings.set({ inputDeviceId: e.target.value })}>
            <option value="default">Windows zadani</option>
            {inputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || 'Mikrofon'}</option>
            ))}
          </select>
        </label>
        <label>
          Slušalice / zvučnici
          <select value={s.outputDeviceId} onChange={(e) => settings.set({ outputDeviceId: e.target.value })}>
            <option value="default">Windows zadani</option>
            {outputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || 'Izlaz'}</option>
            ))}
          </select>
        </label>
      </div>

      <Section title={`Glasnoća drugih: ${Math.round(s.outputVolume * 100)}%`}>
        <input type="range" min={0} max={2} step={0.05} value={s.outputVolume} onChange={(e) => settings.set({ outputVolume: Number(e.target.value) })} />
      </Section>

      <Section title="Način rada mikrofona">
        <div className="radio-group">
          {([
            ['vad', 'Aktivacija glasom', 'Mikrofon se otvara kad pričaš (kao na Discordu).'],
            ['ptt', 'Push-to-talk', 'Pričaš samo dok držiš tipku. Radi i kad si u igri.'],
            ['open', 'Uvijek otvoren', 'Mikrofon stalno šalje (oslanja se na potiskivanje šuma).'],
          ] as Array<[VoiceMode, string, string]>).map(([id, label, hint]) => (
            <label key={id} className={`radio-card ${s.voiceMode === id ? 'active' : ''}`}>
              <input type="radio" name="vm" checked={s.voiceMode === id} onChange={() => settings.set({ voiceMode: id })} />
              <div>
                <div>{label}</div>
                <div className="muted small">{hint}</div>
              </div>
            </label>
          ))}
        </div>
      </Section>

      {s.voiceMode === 'vad' && (
        <Section title={`Osjetljivost: ${s.vadThresholdDb} dB`} hint="Pomjeri tako da se traka upali kad pričaš, a ne kad tipkaš ili je tiho. Bijela crta je prag.">
          <input type="range" min={-80} max={-10} step={1} value={s.vadThresholdDb} onChange={(e) => settings.set({ vadThresholdDb: Number(e.target.value) })} />
          <MicMeter thresholdDb={s.vadThresholdDb} />
        </Section>
      )}

      {s.voiceMode === 'ptt' && (
        <Section title="Push-to-talk tipka" hint={isTauri ? 'Radi globalno, i dok si u igri. Može i dugme miša (Miš 4 / Miš 5).' : 'U browser verziji tipka radi samo dok je prozor u fokusu.'}>
          <div className="row">
            <span className="keycap">{capturing ? 'Pritisni tipku...' : s.hotkeys.ptt?.name || 'Nije postavljeno'}</span>
            <button onClick={() => void setPttKey()} disabled={capturing}>Postavi tipku</button>
            {s.hotkeys.ptt && <button className="small" onClick={() => settings.set({ hotkeys: { ...s.hotkeys, ptt: null } })}>Ukloni</button>}
          </div>
          <label>
            Kašnjenje gašenja: {s.pttReleaseMs} ms
            <input type="range" min={0} max={1000} step={20} value={s.pttReleaseMs} onChange={(e) => settings.set({ pttReleaseMs: Number(e.target.value) })} />
          </label>
        </Section>
      )}

      {s.voiceMode !== 'vad' && (
        <Section title="Test mikrofona">
          <MicMeter thresholdDb={s.vadThresholdDb} />
        </Section>
      )}

      <Section title="Obrada zvuka">
        <Toggle checked={s.noiseSuppression} onChange={(v) => settings.set({ noiseSuppression: v })} label="Potiskivanje šuma" hint="Uklanja ventilator, tipkovnicu i šum u pozadini." />
        <Toggle checked={s.echoCancellation} onChange={(v) => settings.set({ echoCancellation: v })} label="Uklanjanje eha" hint="Potrebno ako koristiš zvučnike umjesto slušalica." />
        <Toggle checked={s.autoGainControl} onChange={(v) => settings.set({ autoGainControl: v })} label="Automatska jačina mikrofona" />
      </Section>
    </>
  );
}

// ---------------- Stream ----------------

function StreamTab() {
  const s = useSettings();
  const preset = presetById(s.streamPreset);
  const bitrate = s.streamBitrateOverride ?? preset.bitrate;
  const codecs: Array<[StreamCodec, string]> = [
    ['auto', 'Automatski — bira kodek koji tvoja grafička enkodira hardverski (preporučeno)'],
    ['h264', 'H.264 — najkompatibilniji'],
    ['av1', 'AV1 — najbolji kvalitet po Mbps (novije grafičke: RX 7000+, RTX 4000+)'],
    ['vp9', 'VP9 — dobar kvalitet, često softverski'],
    ['vp8', 'VP8 — stari, samo za probu'],
  ];
  return (
    <>
      <h2>Stream ekrana</h2>
      <Section title="Kvalitet">
        <select value={s.streamPreset} onChange={(e) => settings.set({ streamPreset: e.target.value, streamBitrateOverride: null })}>
          {STREAM_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </Section>
      <Section
        title={`Bitrate: ${(bitrate / 1_000_000).toFixed(1)} Mbps${s.streamBitrateOverride ? '' : ' (automatski)'}`}
        hint="Više = oštrija slika u brzim scenama, ali treba jači upload. Za 1080p60 je 6–10 Mbps odlično."
      >
        <input
          type="range"
          min={1_000_000}
          max={30_000_000}
          step={500_000}
          value={bitrate}
          onChange={(e) => settings.set({ streamBitrateOverride: Number(e.target.value) })}
        />
        {s.streamBitrateOverride && <button className="small" onClick={() => settings.set({ streamBitrateOverride: null })}>Vrati automatski</button>}
      </Section>
      <HwCheck width={preset.width} height={preset.height} fps={preset.fps} bitrate={bitrate} />
      <Section title="Kodek" hint="Statistika na streamu (ikonica signala) pokazuje da li enkoder radi hardverski — to je ključno da FPS u igri ne pada.">
        <div className="radio-group">
          {codecs.map(([id, label]) => (
            <label key={id} className={`radio-card ${s.streamCodec === id ? 'active' : ''}`}>
              <input type="radio" name="codec" checked={s.streamCodec === id} onChange={() => settings.set({ streamCodec: id })} />
              <div>{label}</div>
            </label>
          ))}
        </div>
      </Section>
      <Section title="Ostalo">
        <Toggle checked={s.streamAudio} onChange={(v) => settings.set({ streamAudio: v })} label="Šalji zvuk sa računara uz stream" hint="Kod dijeljenja cijelog ekrana šalje zvuk igre/sistema." />
        <Toggle checked={s.showStreamStats} onChange={(v) => settings.set({ showStreamStats: v })} label="Uvijek prikaži statistiku na streamu" />
      </Section>
    </>
  );
}

// ---------------- Tipke ----------------

function KeyRow({ label, binding, onSet }: { label: string; binding: HotkeyBinding | null; onSet: (b: HotkeyBinding | null) => void }) {
  const [capturing, setCapturing] = useState(false);
  return (
    <div className="key-row">
      <span>{label}</span>
      <span className="keycap">{capturing ? 'Pritisni tipku...' : binding?.name || '—'}</span>
      <button
        className="small"
        disabled={capturing}
        onClick={async () => {
          setCapturing(true);
          try {
            const b = await captureKey();
            if (b) onSet(b);
          } finally {
            setCapturing(false);
          }
        }}
      >
        Postavi
      </button>
      {binding && <button className="small" onClick={() => onSet(null)}>Ukloni</button>}
    </div>
  );
}

function KeysTab() {
  const s = useSettings();
  const set = (key: keyof typeof s.hotkeys) => (b: HotkeyBinding | null) => settings.set({ hotkeys: { ...s.hotkeys, [key]: b } });
  return (
    <>
      <h2>Tipke</h2>
      <p className="muted">{isTauri ? 'Tipke rade globalno — i kad je igra u prvom planu. Ne "kradu" tipku igri.' : 'U browser verziji tipke rade samo kad je prozor u fokusu.'}</p>
      <KeyRow label="Push-to-talk" binding={s.hotkeys.ptt} onSet={set('ptt')} />
      <KeyRow label="Uključi/isključi mikrofon" binding={s.hotkeys.toggleMute} onSet={set('toggleMute')} />
      <KeyRow label="Uključi/isključi zvuk (deafen)" binding={s.hotkeys.toggleDeafen} onSet={set('toggleDeafen')} />
    </>
  );
}

// ---------------- Aplikacija ----------------

function AppTab() {
  const client = useClient();
  const s = useSettings();
  const server = useApp((st) => st.serverName);
  return (
    <>
      <h2>Aplikacija</h2>
      <Section title="Zvukovi">
        <Toggle checked={s.sounds} onChange={(v) => settings.set({ sounds: v })} label="Zvukovi uključeni" />
        <label>
          Jačina zvukova: {Math.round(s.soundVolume * 100)}%
          <input type="range" min={0.1} max={1} step={0.05} value={s.soundVolume} onChange={(e) => settings.set({ soundVolume: Number(e.target.value) })} />
        </label>
        <Toggle checked={s.messageSounds} onChange={(v) => settings.set({ messageSounds: v })} label="Zvuk za nove poruke" />
        <Toggle
          checked={s.voiceAnnouncements}
          onChange={(v) => settings.set({ voiceAnnouncements: v })}
          label="Glasovna najava"
          hint='Na engleskom: "Microphone muted / activated", "Sound muted / activated" (umjesto tona).'
        />
        <div className="sound-tests">
          <span className="muted small">Poslušaj:</span>
          <button className="small" onClick={() => sounds.join()}>Neko ušao</button>
          <button className="small" onClick={() => sounds.leave()}>Neko izašao</button>
          <button className="small" onClick={() => sounds.mute()}>Mute</button>
          <button className="small" onClick={() => sounds.unmute()}>Unmute</button>
          <button className="small" onClick={() => sounds.deafen()}>Deafen</button>
          <button className="small" onClick={() => sounds.message()}>Poruka</button>
          <button className="small" onClick={() => sounds.poke()}>Poke</button>
          <button className="small" onClick={() => sounds.streamStart()}>Stream počeo</button>
          <button className="small" onClick={() => sounds.streamStop()}>Stream gotov</button>
        </div>
      </Section>
      <Section title="O aplikaciji">
        <p>Lpcalas v{currentVersion()} · {isTauri ? 'Windows aplikacija' : 'web verzija'}</p>
        <UpdateCheck />
        <p className="muted">Server: {server} ({client.api.baseUrl})</p>
      </Section>
    </>
  );
}

// ---------------- Admin ----------------

function AdminTab() {
  const client = useClient();
  const users = useApp((s) => s.users);
  const me = useApp((s) => s.me);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [uses, setUses] = useState(1);
  const [hours, setHours] = useState(48);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = () => client.api.invites().then(setInvites).catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  async function create() {
    try {
      const inv = await client.api.createInvite(uses, hours || null);
      await navigator.clipboard.writeText(inv.code).catch(() => {});
      setCopied(inv.code);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  const userList = Object.values(users).sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <>
      <h2>Admin</h2>
      {error && <p className="error">{error}</p>}
      <Section title="Pozivnice" hint="Ko ima pozivni kod, može napraviti nalog. Pošalji kod u Viber grupu.">
        <div className="row">
          <label className="inline">
            Broj korištenja
            <input type="number" min={1} max={100} value={uses} onChange={(e) => setUses(Number(e.target.value))} />
          </label>
          <label className="inline">
            Važi sati (0 = zauvijek)
            <input type="number" min={0} max={8760} value={hours} onChange={(e) => setHours(Number(e.target.value))} />
          </label>
          <button className="primary" onClick={() => void create()}>Napravi pozivnicu</button>
        </div>
        {copied && <p className="hint ok">Kod <b>{copied}</b> je kopiran — zalijepi ga u Viber.</p>}
        <div className="table">
          {invites.length === 0 && <p className="muted">Nema aktivnih pozivnica.</p>}
          {invites.map((i) => (
            <div key={i.code} className="table-row">
              <span className="keycap">{i.code}</span>
              <span className="muted small">
                {i.usesLeft === 0 ? 'iskorištena' : `još ${i.usesLeft ?? '∞'}×`}
                {i.expiresAt ? ` · ističe ${new Date(i.expiresAt).toLocaleString('bs-BA')}` : ''}
              </span>
              <button className="icon-btn small" title="Kopiraj" onClick={() => void navigator.clipboard.writeText(i.code)}>
                <Icon name="copy" size={14} />
              </button>
              <button className="icon-btn small danger" title="Obriši" onClick={() => client.api.deleteInvite(i.code).then(load)}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Članovi">
        <div className="table">
          {userList.map((u: User) => (
            <div key={u.id} className={`table-row ${u.disabled ? 'disabled' : ''}`}>
              <Avatar user={u} size={28} baseUrl={client.api.baseUrl} />
              <span>
                {u.displayName} <span className="muted small">@{u.username}</span>
              </span>
              <span className="spacer" />
              {u.id !== me.id && (
                <>
                  <button className="small" onClick={() => client.api.updateUser(u.id, { role: u.role === 'admin' ? 'member' : 'admin' }).catch((e) => setError(e.message))}>
                    {u.role === 'admin' ? 'Skini admina' : 'Daj admina'}
                  </button>
                  <button
                    className={`small ${u.disabled ? '' : 'danger'}`}
                    onClick={() => {
                      if (u.disabled || confirm(`Onemogućiti nalog ${u.displayName}? Bit će odjavljen.`)) {
                        client.api.updateUser(u.id, { disabled: !u.disabled }).catch((e) => setError(e.message));
                      }
                    }}
                  >
                    {u.disabled ? 'Omogući' : 'Onemogući'}
                  </button>
                </>
              )}
              {u.role === 'admin' && <span className="pill">admin</span>}
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

function HwCheck({ width, height, fps, bitrate }: { width: number; height: number; fps: number; bitrate: number }) {
  const [list, setList] = useState<CodecSupport[] | null>(null);
  const gpu = gpuName();
  useEffect(() => {
    setList(null);
    void checkEncoders(width, height, fps, bitrate).then(setList);
  }, [width, height, fps, bitrate]);
  const names: Record<string, string> = { h264: 'H.264', av1: 'AV1', vp9: 'VP9', vp8: 'VP8' };
  const text = list
    ? `Grafička: ${gpu}\n` + list.map((c) => `${names[c.codec]}: ${!c.supported ? 'nije podržan' : c.hardware ? 'hardverski' : 'softverski'}`).join('\n')
    : '';
  return (
    <Section title="Hardversko enkodiranje" hint={`Grafička: ${gpu}. Provjera za ${height}p${fps}.`}>
      {!list ? (
        <p className="muted">Provjeravam...</p>
      ) : (
        <div className="hw-grid">
          {list.map((c) => (
            <div key={c.codec} className={`hw-item ${c.hardware ? 'ok' : 'no'}`}>
              <b>{names[c.codec]}</b>
              <span>{!c.supported ? 'nije podržan' : c.hardware ? 'hardverski ✓' : 'softverski ✗'}</span>
            </div>
          ))}
        </div>
      )}
      {list && !list.some((c) => c.hardware) && (
        <p className="hint" style={{ color: 'var(--warn)' }}>
          Nijedan kodek nije hardverski — stream će opterećivati procesor. Pošalji ovo Claudeu.
        </p>
      )}
      {list && (
        <button className="small" onClick={() => void navigator.clipboard.writeText('Lpcalas enkoderi\n' + text)}>
          Kopiraj rezultat
        </button>
      )}
    </Section>
  );
}

function UpdateCheck() {
  const u = useStore(updateStore, (s) => s);
  return (
    <div className="row">
      <button className="small" disabled={u.status === 'checking' || u.status === 'downloading'} onClick={() => void checkForUpdate(true)}>
        Provjeri ažuriranja
      </button>
      {u.status === 'checking' && <span className="muted small">Provjeravam...</span>}
      {u.status === 'uptodate' && <span className="hint ok">Imaš najnoviju verziju.</span>}
      {u.status === 'available' && (
        <button className="primary small" onClick={() => void installUpdate()}>
          Ažuriraj na {u.version}
        </button>
      )}
      {u.status === 'downloading' && <span className="muted small">Skidam... {Math.round(u.progress * 100)}%</span>}
      {u.status === 'error' && <span className="error small">{u.error}</span>}
    </div>
  );
}
