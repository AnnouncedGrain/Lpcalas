import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri očekuje fiksni port u dev modu i build u ../dist.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'chrome120',
    outDir: 'dist',
    sourcemap: false,
  },
});
