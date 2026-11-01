import { useStore } from '../lib/store';
import { installUpdate, updateStore } from '../lib/updater';
import { useVoice } from '../lib/context';
import { Icon } from './Icon';
import { t } from '../lib/i18n';

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
          <span>{t('Nova verzija {v} je dostupna.', { v: u.version || '' })}
            {inVoice && <span className="muted"> {t('Aplikacija će se restartovati (izaći ćeš iz kanala).')}</span>}
          </span>
          <span className="spacer" />
          <button className="primary small" onClick={() => void installUpdate()}>{t('Ažuriraj sada')}</button>
          <button className="small" onClick={() => updateStore.set({ dismissed: true })}>{t('Kasnije')}</button>
        </>
      )}
      {u.status === 'downloading' && (
        <>
          <span>{t('Skidam verziju {v}...', { v: u.version || '' })} {Math.round(u.progress * 100)}%</span>
          <div className="update-progress"><div style={{ width: `${u.progress * 100}%` }} /></div>
        </>
      )}
      {u.status === 'installing' && <span>{t('Instaliram i ponovo pokrećem aplikaciju...')}</span>}
    </div>
  );
}
