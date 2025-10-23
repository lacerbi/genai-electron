/// <reference types="vite/client" />

// Declare window.api from preload
import type { WindowAPI } from '../main/preload';

declare global {
  interface Window {
    api: WindowAPI;
  }
}

// Electron Forge Vite plugin globals (used by Electron Forge, not directly in code)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const MAIN_WINDOW_VITE_NAME: string;

export {};
