import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Console build. The core (src/core) is plain TS; Node-only code lives in src/core/node and is never imported by src/app.
export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: { outDir: 'dist', sourcemap: true },
});
