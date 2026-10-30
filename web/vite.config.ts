import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// kerits uses the origin as client_id, so dev must be exactly http://127.0.0.1:5173.
// BASE_PATH: where the build is served from ('/relay/' on GitHub Pages).
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  resolve: {
    alias: { '@pritzlaff/relay-client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)) },
  },
});
