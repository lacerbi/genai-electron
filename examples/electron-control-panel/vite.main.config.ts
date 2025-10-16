import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: '.vite/build',
    lib: {
      entry: resolve(__dirname, 'main/index.ts'),
      formats: ['cjs'],
      fileName: () => 'main.cjs',
    },
    rollupOptions: {
      external: ['electron', 'genai-electron', 'genai-lite'],
      output: {
        format: 'cjs',
      },
    },
  },
  resolve: {
    browserField: false,
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});
