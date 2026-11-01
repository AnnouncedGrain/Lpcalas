import { useCallback, useEffect, useState } from 'react';
import { Api, ApiError } from './lib/api';
import { Client } from './lib/client';
import { ClientContext, useApp } from './lib/context';
import { loadSession, saveSession, settings } from './lib/settings';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { VoiceView } from './components/VoiceView';
import { MemberList } from './components/MemberList';
import { SettingsModal } from './components/SettingsModal';
import { PokeAlerts, PokeComposer } from './components/Poke';
import { UpdateBanner } from './components/UpdateBanner';
import { startAutoUpdateChecks } from './lib/updater';
import { t } from './lib/i18n';

type Phase = { kind: 'loading' } | { kind: 'login' } | { kind: 'ready'; client: Client } | { kind: 'offline'; message: string };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  // Promjena jezika: ponovo iscrtaj cijelu aplikaciju (ništa nije memoizirano).
  const [lang, setLang] = useState(settings.get().language);
  useEffect(() => settings.subscribe((v) => setLang(v.language)) as () => void, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  const toLogin = useCallback(() => setPhase({ kind: 'login' }), []);

  const start = useCallback(async (api: Api) => {
    try {
      const boot = await api.bootstrap();
      setPhase({ kind: 'ready', client: new Client(api, boot, toLogin) });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        saveSession({ serverUrl: api.baseUrl, token: null });
        setPhase({ kind: 'login' });
      } else {
        setPhase({ kind: 'offline', message: err instanceof Error ? err.message : t('Server nije dostupan.') });
      }
    }
  }, [toLogin]);

  const resume = useCallback(() => {
    const s = loadSession();
    if (s?.token) void start(new Api(s.serverUrl, s.token));
    else setPhase({ kind: 'login' });
  }, [start]);

  useEffect(() => {
    resume();
  }, [resume]);

  // Spriječi da prevučen fajl otvori novi prozor ako promaši chat.
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  if (phase.kind === 'loading') return <div className="splash"><div className="brand-mark big">LP</div></div>;
  if (phase.kind === 'login') return <Login onLoggedIn={(api) => void start(api)} />;
  if (phase.kind === 'offline') {
    return (
      <div className="splash">
        <div className="offline-card">
          <h2>{t('Server nije dostupan')}</h2>
          <p className="muted">{phase.message}</p>
          <div className="row">
            <button className="primary" onClick={() => { setPhase({ kind: 'loading' }); resume(); }}>{t('Pokušaj ponovo')}</button>
            <button onClick={() => setPhase({ kind: 'login' })}>{t('Promijeni server')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ClientContext.Provider value={phase.client}>
      <Shell />
    </ClientContext.Provider>
  );
}

function Shell() {
  const view = useApp((s) => s.view);
  const activeText = useApp((s) => s.activeTextChannelId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => startAutoUpdateChecks(), []);

  return (
    <div className="app">
      <Sidebar onOpenSettings={() => setSettingsOpen(true)} />
      <main className="main">
        <UpdateBanner />
        {view === 'voice' ? <VoiceView /> : activeText !== null ? <ChatView channelId={activeText} /> : <div className="voice-view empty"><h2>{t('Nema kanala')}</h2></div>}
      </main>
      <MemberList />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <PokeComposer />
      <PokeAlerts />
    </div>
  );
}
