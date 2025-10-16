import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: '.vite/build',
    lib: {
      entry: resolve(__dirname, 'main/preload.ts'),
      formats: ['cjs'],
      fileName: () => 'preload.cjs',
    },
    rollupOptions: {
      external: ['electron'],
      output: {
        format: 'cjs',
      },
    },
  },
});
