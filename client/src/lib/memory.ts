// Praćenje memorije (dijagnostika curenja). Svake minute zapamti koliko troši Lpcalas,
// da se kasnije vidi šta raste: JavaScript, ili neki WebView2 proces (npr. video dekodiranje).
import { isTauri } from './native';

export interface ProcMem {
  pid: number;
  name: string;
  private_mb: number;
  working_set_mb: number;
}

export interface MemSample {
  at: number;
  totalMb: number;
  jsMb: number | null;
  biggestMb: number;
  streams: number;
}

const history: MemSample[] = [];
let started = false;
let streamCount: () => number = () => 0;

export function jsHeapMb(): number | null {
  const m = (performance as any).memory;
  return m?.usedJSHeapSize ? Math.round(m.usedJSHeapSize / 1_048_576) : null;
}

export async function readProcesses(): Promise<ProcMem[]> {
  if (!isTauri) return [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<ProcMem[]>('memory_usage');
  } catch {
    return [];
  }
}

async function sample() {
  const procs = await readProcesses();
  history.push({
    at: Date.now(),
    totalMb: Math.round(procs.reduce((a, p) => a + p.private_mb, 0)),
    jsMb: jsHeapMb(),
    biggestMb: Math.round(procs[0]?.private_mb ?? 0),
    streams: streamCount(),
  });
  if (history.length > 240) history.shift(); // 4 sata
}

export function startMemoryMonitor(countStreams: () => number) {
  streamCount = countStreams;
  if (started) return;
  started = true;
  void sample();
  setInterval(() => void sample(), 60_000);
}

export function memoryHistory(): MemSample[] {
  return history;
}
