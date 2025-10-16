import { systemInfo, modelManager, llamaServer } from 'genai-electron';
import { BrowserWindow } from 'electron';

/**
 * Forward download progress events to renderer
 */
export function setupDownloadProgressForwarding(_downloadId: string): void {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (!mainWindow) return;

  // Note: In the actual implementation, genai-electron would need to support
  // progress callbacks. For now, this is a placeholder structure.
  // The actual progress forwarding will be implemented when the download API
  // supports onProgress callbacks.
}

/**
 * Forward server events to renderer
 */
export function setupServerEventForwarding(): void {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (!mainWindow) return;

  llamaServer.on('started', () => {
    mainWindow.webContents.send('server:started');
  });

  llamaServer.on('stopped', () => {
    mainWindow.webContents.send('server:stopped');
  });

  llamaServer.on('crashed', (error: Error) => {
    mainWindow.webContents.send('server:crashed', {
      message: error.message,
      stack: error.stack,
    });
  });
}

/**
 * Cleanup servers on app quit
 */
export async function cleanupServers(): Promise<void> {
  try {
    const status = llamaServer.getStatus();
    if (status === 'running') {
      await llamaServer.stop();
    }
  } catch (error) {
    console.error('Error stopping server during cleanup:', error);
  }
}

/**
 * Send download progress to renderer
 */
export function sendDownloadProgress(
  downloaded: number,
  total: number,
  modelName: string
): void {
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

// Export genai-electron instances for direct access
export { systemInfo, modelManager, llamaServer };
