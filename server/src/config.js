import path from 'node:path';

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} mora biti broj, dobio: ${v}`);
  return n;
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    port: int('PORT', 8080),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    serverName: env.SERVER_NAME || 'Lpcalas',
    maxUploadBytes: int('MAX_UPLOAD_MB', 500) * 1024 * 1024,
    livekit: {
      apiKey: env.LIVEKIT_API_KEY || '',
      apiSecret: env.LIVEKIT_API_SECRET || '',
      // Adresa na kojoj backend vidi LiveKit (unutar docker mreže).
      internalUrl: (env.LIVEKIT_URL_INTERNAL || 'http://livekit:7880').replace(/\/$/, ''),
      // Adresa koju dobijaju klijenti. Prazno = ista adresa kao backend (signal ide kroz proxy).
      publicUrl: (env.LIVEKIT_URL_PUBLIC || '').replace(/\/$/, ''),
    },
    // Iza reverse proxyja (Caddy) vjerujemo X-Forwarded-* headerima.
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    ...overrides,
  };
  if (overrides.livekit) cfg.livekit = { ...cfg.livekit, ...overrides.livekit };
  return cfg;
}
