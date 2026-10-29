import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// kerits uses the origin as client_id, so it must be exactly http://127.0.0.1:5173.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  resolve: {
    alias: { '@topics/client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)) },
  },
});
