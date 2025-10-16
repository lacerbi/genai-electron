/// <reference types="vite/client" />

// Declare window.api from preload
import type { WindowAPI } from '../main/preload';

declare global {
  interface Window {
    api: WindowAPI;
  }
}

// Electron Forge Vite plugin globals
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

export {};
