// Most prema Tauri (Rust) dijelu aplikacije. U običnom browseru sve ima rezervu.
import type { HotkeyBinding } from './settings';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

type HotkeyAction = 'ptt' | 'toggleMute' | 'toggleDeafen';
type HotkeyHandler = (action: HotkeyAction, pressed: boolean) => void;

let unlistenNative: (() => void) | null = null;
let browserCleanup: (() => void) | null = null;

export async function setHotkeys(
  bindings: Partial<Record<HotkeyAction, HotkeyBinding | null>>,
  onHotkey: HotkeyHandler,
): Promise<void> {
  const list = Object.entries(bindings)
    .filter(([, b]) => b && b.vk > 0)
    .map(([action, b]) => ({ action, vk: b!.vk }));

  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    await invoke('set_hotkeys', { bindings: list });
    if (!unlistenNative) {
      unlistenNative = await listen<{ action: HotkeyAction; pressed: boolean }>('hotkey', (e) => {
        currentHandler?.(e.payload.action, e.payload.pressed);
      });
    }
    currentHandler = onHotkey;
    return;
  }

  // Browser: radi samo dok je prozor u fokusu.
  currentHandler = onHotkey;
  browserCleanup?.();
  const byVk = new Map(list.map((b) => [b.vk, b.action as HotkeyAction]));
  const down = new Set<number>();
  const onKey = (pressed: boolean) => (e: KeyboardEvent) => {
    const vk = e.keyCode;
    const action = byVk.get(vk);
    if (!action) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (pressed && (tag === 'INPUT' || tag === 'TEXTAREA')) return;
    if (pressed === down.has(vk)) return;
    if (pressed) down.add(vk);
    else down.delete(vk);
    currentHandler?.(action, pressed);
  };
  const kd = onKey(true);
  const ku = onKey(false);
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);
  browserCleanup = () => {
    window.removeEventListener('keydown', kd);
    window.removeEventListener('keyup', ku);
  };
}

let currentHandler: HotkeyHandler | null = null;

// Čeka sljedeću pritisnutu tipku ili dugme miša (globalno u Tauri aplikaciji).
export async function captureKey(): Promise<HotkeyBinding | null> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<HotkeyBinding | null>('capture_key');
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), 10000);
    const finish = (b: HotkeyBinding | null) => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      resolve(b);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === 'Escape') return finish(null);
      finish({ vk: e.keyCode, name: e.code.replace(/^Key/, '').replace(/^Digit/, '') || e.key });
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) finish({ vk: 0x05, name: 'Miš 4' });
      else if (e.button === 4) finish({ vk: 0x06, name: 'Miš 5' });
      else if (e.button === 1) finish({ vk: 0x04, name: 'Srednji klik' });
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
  });
}

export async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

export async function flashWindow(critical = false) {
  if (!isTauri || document.hasFocus()) return;
  try {
    const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
    await getCurrentWindow().requestUserAttention(critical ? UserAttentionType.Critical : UserAttentionType.Informational);
  } catch {
    /* nije kritično */
  }
}
