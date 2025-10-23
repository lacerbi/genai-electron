/**
 * Electron application lifecycle utilities
 * @module utils/electron-lifecycle
 */

import type { App } from 'electron';
import type { LlamaServerManager } from '../managers/LlamaServerManager.js';
import type { DiffusionServerManager } from '../managers/DiffusionServerManager.js';

/**
 * Server managers that can be cleaned up on app quit
 */
export interface ServerManagers {
  /** LLM server manager instance (optional) */
  llamaServer?: LlamaServerManager;
  /** Diffusion server manager instance (optional) */
  diffusionServer?: DiffusionServerManager;
}

/**
 * Attach automatic cleanup handlers to Electron app lifecycle
 *
 * Registers a `before-quit` event listener that gracefully stops all running servers
 * before the application exits. This ensures proper cleanup of resources and processes.
 *
 * **Important**: Call this function after the app is ready, typically in your main process
 * initialization code.
 *
 * @param app - Electron app instance
 * @param managers - Server managers to clean up on app quit
 *
 * @example
 * ```typescript
 * import { app } from 'electron';
 * import { attachAppLifecycle, llamaServer, diffusionServer } from 'genai-electron';
 *
 * app.whenReady().then(() => {
 *   // Setup your app...
 *
 *   // Attach lifecycle handlers for automatic cleanup
 *   attachAppLifecycle(app, { llamaServer, diffusionServer });
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Only cleanup LLM server
 * import { attachAppLifecycle, llamaServer } from 'genai-electron';
 * attachAppLifecycle(app, { llamaServer });
 * ```
 *
 * @example
 * ```typescript
 * // Only cleanup diffusion server
 * import { attachAppLifecycle, diffusionServer } from 'genai-electron';
 * attachAppLifecycle(app, { diffusionServer });
 * ```
 */
export function attachAppLifecycle(app: App, managers: ServerManagers): void {
  app.on('before-quit', async (event) => {
    event.preventDefault();

    try {
      // Stop LLM server if provided and running
      if (managers.llamaServer) {
        const llamaStatus = managers.llamaServer.getStatus();
        if (llamaStatus === 'running') {
          console.log('[genai-electron] Stopping LLM server...');
          await managers.llamaServer.stop();
          console.log('[genai-electron] LLM server stopped');
        }
      }

      // Stop diffusion server if provided and running
      if (managers.diffusionServer) {
        const diffusionStatus = managers.diffusionServer.getStatus();
        if (diffusionStatus === 'running') {
          console.log('[genai-electron] Stopping diffusion server...');
          await managers.diffusionServer.stop();
          console.log('[genai-electron] Diffusion server stopped');
        }
      }
    } catch (error) {
      console.error('[genai-electron] Error during server cleanup:', error);
    } finally {
      // Exit the app
      app.exit(0);
    }
  });
}
