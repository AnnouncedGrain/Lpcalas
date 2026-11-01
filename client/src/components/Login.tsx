import { useEffect, useState, type FormEvent } from 'react';
import { Api, ApiError, normalizeServerUrl } from '../lib/api';
import { loadSession, saveSession } from '../lib/settings';

export function Login({ onLoggedIn }: { onLoggedIn: (api: Api) => void }) {
  const saved = loadSession();
  const [serverUrl, setServerUrl] = useState(saved?.serverUrl || '');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState(saved?.username || '');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<{ name: string; needsFirstUser: boolean } | null>(null);

  // Provjeri server kad korisnik prestane kucati adresu.
  useEffect(() => {
    setInfo(null);
    if (!serverUrl.trim()) return;
    const t = setTimeout(async () => {
      try {
        const api = new Api(normalizeServerUrl(serverUrl));
        const i = await api.serverInfo();
        setInfo({ name: i.name, needsFirstUser: i.needsFirstUser });
        if (i.needsFirstUser) setMode('register');
      } catch {
        setInfo(null);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [serverUrl]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const base = normalizeServerUrl(serverUrl);
      const api = new Api(base);
      await api.serverInfo();
      const res =
        mode === 'login'
          ? await api.login(username, password)
          : await api.register({ username, password, displayName: displayName || username, invite });
      api.token = res.token;
      saveSession({ serverUrl: base, token: res.token, username: res.user.username });
      onLoggedIn(api);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nešto nije u redu.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <div className="brand-mark">LP</div>
          <div>
            <h1>Lpcalas</h1>
            <p className="muted">{info ? `Server: ${info.name}` : 'Glas, stream i chat za ekipu'}</p>
          </div>
        </div>

        <label>
          Adresa servera
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="npr. 85.12.34.56:8080"
            autoFocus={!saved?.serverUrl}
            spellCheck={false}
          />
        </label>
        {info?.needsFirstUser && (
          <p className="hint ok">Server je nov. Prvi nalog postaje admin (pozivni kod je ispisala skripta).</p>
        )}

        <div className="tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Prijava
          </button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            Novi nalog
          </button>
        </div>

        <label>
          Korisničko ime
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} autoFocus={!!saved?.serverUrl} />
        </label>
        {mode === 'register' && (
          <label>
            Ime za prikaz <span className="muted">(opcionalno)</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} />
          </label>
        )}
        <label>
          Lozinka
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>
        {mode === 'register' && (
          <label>
            Pozivni kod
            <input value={invite} onChange={(e) => setInvite(e.target.value.toUpperCase())} placeholder="XXXXX-XXXXX" spellCheck={false} />
          </label>
        )}

        {error && <p className="error">{error}</p>}

        <button className="primary big" disabled={busy || !serverUrl || !username || !password}>
          {busy ? 'Spajam...' : mode === 'login' ? 'Prijavi se' : 'Napravi nalog'}
        </button>
      </form>
    </div>
  );
}
