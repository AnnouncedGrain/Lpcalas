// Automatsko ažuriranje: aplikacija sama provjerava GitHub Releases, skida novu verziju
// (potpisanu našim ključem) i ponovo se pokreće.
import { isTauri } from './native';
import { Store } from './store';
import { t } from './i18n';

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'uptodate' | 'error';
  version: string | null;
  notes: string | null;
  progress: number; // 0..1
  error: string | null;
  dismissed: boolean;
}

export const updateStore = new Store<UpdateState>({
  status: 'idle',
  version: null,
  notes: null,
  progress: 0,
  error: null,
  dismissed: false,
});

let pending: any = null;

export async function checkForUpdate(manual = false): Promise<void> {
  if (!isTauri) {
    if (manual) updateStore.set({ status: 'error', error: t('Ažuriranje radi samo u Windows aplikaciji.') });
    return;
  }
  const cur = updateStore.get().status;
  if (cur === 'downloading' || cur === 'installing' || cur === 'checking') return;
  updateStore.set({ status: 'checking', error: null });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check({ timeout: 20000 });
    if (update) {
      pending = update;
      updateStore.set({ status: 'available', version: update.version, notes: update.body ?? null, dismissed: manual ? false : updateStore.get().dismissed });
    } else {
      updateStore.set({ status: 'uptodate' });
    }
  } catch (e: any) {
    // Tiha greška pri automatskoj provjeri (npr. nema interneta); prikaži samo kad korisnik sam klikne.
    updateStore.set({ status: manual ? 'error' : 'idle', error: manual ? String(e?.message || e) : null });
  }
}

export async function installUpdate(): Promise<void> {
  if (!pending) return;
  let total = 0;
  let done = 0;
  updateStore.set({ status: 'downloading', progress: 0, error: null });
  try {
    await pending.downloadAndInstall((event: any) => {
      if (event.event === 'Started') total = event.data.contentLength || 0;
      else if (event.event === 'Progress') {
        done += event.data.chunkLength;
        if (total) updateStore.set({ progress: done / total });
      } else if (event.event === 'Finished') updateStore.set({ status: 'installing', progress: 1 });
    });
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (e: any) {
    updateStore.set({ status: 'error', error: String(e?.message || e) });
  }
}

let autoStarted = false;
export function startAutoUpdateChecks() {
  if (!isTauri || autoStarted) return;
  autoStarted = true;
  setTimeout(() => void checkForUpdate(), 5000);
  setInterval(() => void checkForUpdate(), 30 * 60 * 1000);
}

export function currentVersion(): string {
  return __APP_VERSION__;
}
