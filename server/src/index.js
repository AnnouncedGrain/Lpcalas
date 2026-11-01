import { loadConfig } from './config.js';
import { createApp, VERSION } from './app.js';

const config = loadConfig();
const app = createApp(config, { log: console });

if (!app.livekit.configured) {
  console.warn('UPOZORENJE: LIVEKIT_API_KEY / LIVEKIT_API_SECRET nisu postavljeni. Chat radi, glasovni kanali ne.');
}

const addr = await app.start();
console.log(`Lpcalas server ${VERSION} sluša na ${addr.address}:${addr.port} (podaci: ${config.dataDir})`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} primljen, gasim server...`);
  const force = setTimeout(() => process.exit(0), 5000);
  force.unref();
  await app.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
