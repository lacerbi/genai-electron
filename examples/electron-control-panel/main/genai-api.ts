import {
  systemInfo,
  modelManager,
  llamaServer,
  diffusionServer,
  ResourceOrchestrator,
} from 'genai-electron';
import { BrowserWindow } from 'electron';

/**
 * Forward download progress events to renderer
 * @deprecated This function is a placeholder for future download progress tracking
 */
export function setupDownloadProgressForwarding(): void {
  // Note: In the actual implementation, genai-electron would need to support
  // progress callbacks. For now, this is a placeholder structure.
  // The actual progress forwarding will be implemented when the download API
  // supports onProgress callbacks.
}

/**
 * Forward server events to renderer
 *
 * Note: Gets the window dynamically on each event emission to avoid
 * timing issues where this function is called before window creation.
 */
export function setupServerEventForwarding(): void {
  // LLM server events
  llamaServer.on('started', () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('server:started');
    }
  });

  llamaServer.on('stopped', () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('server:stopped');
    }
  });

  llamaServer.on('crashed', (error: Error) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('server:crashed', {
        message: error.message,
        stack: error.stack,
      });
    }
  });

  llamaServer.on('binary-log', (data: { message: string; level: 'info' | 'warn' | 'error' }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('server:binary-log', data);
    }
  });

  // Diffusion server events
  diffusionServer.on('started', () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('diffusion:started');
    }
  });

  diffusionServer.on('stopped', () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('diffusion:stopped');
    }
  });

  diffusionServer.on('crashed', (error: Error) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('diffusion:crashed', {
        message: error.message,
        stack: error.stack,
      });
    }
  });

  diffusionServer.on(
    'binary-log',
    (data: { message: string; level: 'info' | 'warn' | 'error' }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow) {
        mainWindow.webContents.send('diffusion:binary-log', data);
      }
    }
  );
}

/**
 * Send download progress to renderer
 */
export function sendDownloadProgress(downloaded: number, total: number, modelName: string): void {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (mainWindow) {
    mainWindow.webContents.send('download:progress', {
      downloaded,
      total,
      modelName,
      percentage: total > 0 ? (downloaded / total) * 100 : 0,
    });
  }
}

/**
 * Send download complete event to renderer
 */
export function sendDownloadComplete(modelId: string, modelName: string): void {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (mainWindow) {
    mainWindow.webContents.send('download:complete', { modelId, modelName });
  }
}

/**
 * Send download error event to renderer
 */
export function sendDownloadError(error: Error, modelName: string): void {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (mainWindow) {
    mainWindow.webContents.send('download:error', {
      message: error.message,
      modelName,
    });
  }
}

/**
 * Send component download start event to renderer
 */
export function sendComponentStart(
  role: string,
  filename: string,
  index: number,
  total: number,
  modelName: string
): void {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (mainWindow) {
    mainWindow.webContents.send('download:component-start', {
      role,
      filename,
      index,
      total,
      modelName,
    });
  }
}

/**
 * Send image generation progress to renderer
 */
export function sendImageProgress(
  currentStep: number,
  totalSteps: number,
  stage: 'loading' | 'diffusion' | 'decoding',
  percentage?: number
): void {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (mainWindow) {
    mainWindow.webContents.send('diffusion:progress', {
      currentStep,
      totalSteps,
      stage,
      percentage: percentage ?? (totalSteps > 0 ? (currentStep / totalSteps) * 100 : 0),
    });
  }
}

/**
 * Create ResourceOrchestrator singleton instance
 */
let orchestrator: ResourceOrchestrator | null = null;

export function getOrchestrator(): ResourceOrchestrator {
  if (!orchestrator) {
    orchestrator = new ResourceOrchestrator(systemInfo, llamaServer, diffusionServer, modelManager);
  }
  return orchestrator;
}

// Export genai-electron instances for direct access
export { systemInfo, modelManager, llamaServer, diffusionServer };
