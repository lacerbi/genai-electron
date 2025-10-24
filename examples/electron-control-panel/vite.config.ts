import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'renderer'),
  build: {
    outDir: resolve(__dirname, '.vite/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      external: ['electron', 'genai-electron', 'genai-lite'],
    },
  },
  server: {
    port: 3100,
  },
});
