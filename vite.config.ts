import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const tauriConfig = JSON.parse(readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as {
  version?: string;
  plugins?: { updater?: { pubkey?: string } };
};
const updaterPublicKey = tauriConfig.plugins?.updater?.pubkey ?? '';
const updaterConfigured = !updaterPublicKey.startsWith('REPLACE_');

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(tauriConfig.version ?? '0.0.0'),
    __UPDATER_CONFIGURED__: JSON.stringify(updaterConfigured),
  },
  plugins: [react()],
  clearScreen: false,
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: { target: 'es2022' },
});
