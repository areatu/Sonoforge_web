import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Ensure synthetic echo fixtures are present in publicDir/samples before Vite resolves publicDir
const fixturesSrc = path.resolve(import.meta.dirname, 'spike/fixtures');
const publicSamplesDst = path.resolve(import.meta.dirname, 'spike/web-proto/public/samples');
if (fs.existsSync(fixturesSrc)) {
  fs.mkdirSync(publicSamplesDst, { recursive: true });
  fs.cpSync(fixturesSrc, publicSamplesDst, { recursive: true });
}

export default defineConfig({
  plugins: [react()],
  publicDir: 'spike/web-proto/public',
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  worker: {
    format: 'es',
  },
  assetsInclude: ['**/*.wasm', '**/*.dcm'],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
