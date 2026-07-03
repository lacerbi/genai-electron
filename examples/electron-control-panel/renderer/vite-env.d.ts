/// <reference types="vite/client" />

// window.api is declared (with the richer app-side types) in ./types/api.ts.
// Do NOT re-declare it here from the preload type — two divergent declarations
// of the same global property silently weaken type-checking.

// Electron Forge Vite plugin globals (used by Electron Forge, not directly in code)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const MAIN_WINDOW_VITE_NAME: string;

export {};
