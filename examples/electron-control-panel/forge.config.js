import { VitePlugin } from '@electron-forge/plugin-vite';

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
export default {
  packagerConfig: {
    asar: true,
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
  ],
  plugins: [
    new VitePlugin({
      // Main process source
      build: [
        {
          entry: 'main/index.ts',
          config: 'vite.main.config.ts',
        },
        {
          entry: 'main/preload.ts',
          config: 'vite.preload.config.ts',
        },
      ],
      // Renderer source
      renderer: [
        {
          name: 'main_window',
          config: 'vite.config.ts',
        },
      ],
    }),
  ],
};
