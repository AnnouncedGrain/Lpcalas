import { useEffect, useRef, useState } from 'react';
import { useApp, useClient } from '../lib/context';
import { formatTime } from '../lib/format';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { t } from '../lib/i18n';

// Prozor za slanje pokea (otvara se iz menija na članu).
export function PokeComposer() {
  const client = useClient();
  const targetId = useApp((s) => s.pokeTarget);
  const target = useApp((s) => (s.pokeTarget ? s.users[s.pokeTarget] : undefined));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMessage('');
    setError(null);
    if (targetId) setTimeout(() => inputRef.current?.focus(), 0);
  }, [targetId]);

  if (!targetId || !target) return null;
  const close = () => client.openPoke(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const delivered = await client.sendPoke(targetId!, message);
      if (!delivered) {
        setError(t('{name} trenutno nije online.', { name: target!.displayName }));
        return;
      }
      close();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="poke-card">
        <div className="poke-head">
          <Avatar user={target} size={40} baseUrl={client.api.baseUrl} />
          <div>
            <div className="poke-title">{t('Poke za {name}', { name: target.displayName })}</div>
            <div className="muted small">{t('Dobit će zvuk i prozor s porukom.')}</div>
          </div>
        </div>
        <input
          ref={inputRef}
          value={message}
          maxLength={200}
          placeholder={t('Poruka (opcionalno), npr. dođi u Lobby')}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send();
            if (e.key === 'Escape') close();
          }}
        />
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button onClick={close}>{t('Odustani')}</button>
          <button className="primary" disabled={busy} onClick={() => void send()}>
            <Icon name="bell" size={16} /> {t('Pošalji poke')}</button>
        </div>
      </div>
    </div>
  );
}

// Primljeni pokeovi (gore u sredini, ostaju dok ih ne zatvoriš).
export function PokeAlerts() {
  const client = useClient();
  const pokes = useApp((s) => s.pokes);
  const users = useApp((s) => s.users);
  if (pokes.length === 0) return null;
  return (
    <div className="poke-alerts">
      {pokes.map((p) => {
        const from = users[p.from];
        return (
          <div key={p.id} className="poke-alert">
            <Avatar user={from} size={36} baseUrl={client.api.baseUrl} />
            <div className="poke-alert-body">
              <div>
                <b>{from?.displayName || t('Neko')}</b> {t('te pokeao')} <span className="muted small">{formatTime(p.at)}</span>
              </div>
              {p.message && <div className="poke-message">{p.message}</div>}
            </div>
            <button className="small" onClick={() => client.openPoke(p.from)} title={t('Uzvrati poke')}>{t('Uzvrati')}</button>
            <button className="icon-btn small" title={t('Zatvori')} onClick={() => client.dismissPoke(p.id)}>
              <Icon name="x" size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
