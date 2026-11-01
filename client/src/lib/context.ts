import { createContext, useContext, useEffect, useState } from 'react';
import type { Client, AppState } from './client';
import type { VoiceState } from './voice';
import { useStore } from './store';
import { settings, type Settings } from './settings';

export const ClientContext = createContext<Client | null>(null);

export function useClient(): Client {
  const c = useContext(ClientContext);
  if (!c) throw new Error('Client nije dostupan');
  return c;
}

export function useApp<S>(selector: (s: AppState) => S): S {
  return useStore(useClient().store, selector);
}

export function useVoice<S>(selector: (s: VoiceState) => S): S {
  return useStore(useClient().voice.store, selector);
}

export function useSettings(): Settings {
  const [value, setValue] = useState(settings.get());
  useEffect(() => {
    const unsub = settings.subscribe(setValue);
    return () => {
      unsub();
    };
  }, []);
  return value;
}
