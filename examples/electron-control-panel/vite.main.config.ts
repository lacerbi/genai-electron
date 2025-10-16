import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: '.vite/build',
    lib: {
      entry: resolve(__dirname, 'main/index.ts'),
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
  resolve: {
    browserField: false,
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});
