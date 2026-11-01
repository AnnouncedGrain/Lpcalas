import { useStore } from '../lib/store';
import { installUpdate, updateStore } from '../lib/updater';
import { useVoice } from '../lib/context';
import { Icon } from './Icon';

export function UpdateBanner() {
  const u = useStore(updateStore, (s) => s);
  const inVoice = useVoice((v) => v.channelId !== null);
  const show = (u.status === 'available' && !u.dismissed) || u.status === 'downloading' || u.status === 'installing';
  if (!show) return null;
  return (
    <div className="update-banner">
      <Icon name="download" size={18} />
      {u.status === 'available' && (
        <>
          <span>
            Nova verzija <b>{u.version}</b> je dostupna.
            {inVoice && <span className="muted"> Aplikacija će se restartovati (izaći ćeš iz kanala).</span>}
          </span>
          <span className="spacer" />
          <button className="primary small" onClick={() => void installUpdate()}>Ažuriraj sada</button>
          <button className="small" onClick={() => updateStore.set({ dismissed: true })}>Kasnije</button>
        </>
      )}
      {u.status === 'downloading' && (
        <>
          <span>Skidam verziju {u.version}... {Math.round(u.progress * 100)}%</span>
          <div className="update-progress"><div style={{ width: `${u.progress * 100}%` }} /></div>
        </>
      )}
      {u.status === 'installing' && <span>Instaliram i ponovo pokrećem aplikaciju...</span>}
    </div>
  );
}
