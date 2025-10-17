import { ipcMain } from 'electron';
import {
  systemInfo,
  modelManager,
  llamaServer,
  setupServerEventForwarding,
  sendDownloadProgress,
  sendDownloadComplete,
  sendDownloadError,
} from './genai-api.js';
import { LogManager } from 'genai-electron';
import { LLMService } from 'genai-lite';

/**
 * Register all IPC handlers
 */
export function registerIpcHandlers(): void {
  // Setup server event forwarding
  setupServerEventForwarding();

  // ========================================
  // System Info Handlers
  // ========================================

  ipcMain.handle('system:detect', async () => {
    try {
      return await systemInfo.detect();
    } catch (error) {
      throw new Error(`Failed to detect system: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('system:getMemory', () => {
    try {
      return systemInfo.getMemoryInfo();
    } catch (error) {
      throw new Error(`Failed to get memory info: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('system:canRunModel', async (_event, modelInfo) => {
    try {
      return await systemInfo.canRunModel(modelInfo);
    } catch (error) {
      throw new Error(`Failed to check model compatibility: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('system:getOptimalConfig', async (_event, modelInfo) => {
    try {
      return await systemInfo.getOptimalConfig(modelInfo);
    } catch (error) {
      throw new Error(`Failed to get optimal config: ${(error as Error).message}`);
    }
  });

  // ========================================
  // Model Management Handlers
  // ========================================

  ipcMain.handle('models:list', async (_event, type: 'llm' | 'diffusion') => {
    try {
      return await modelManager.listModels(type);
    } catch (error) {
      throw new Error(`Failed to list models: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('models:download', async (_event, config) => {
    try {
      // Extract model name for progress events
      const modelName = config.name || 'Unknown Model';

      // Download with progress callback
      await modelManager.downloadModel({
        ...config,
        onProgress: (downloaded: number, total: number) => {
          sendDownloadProgress(downloaded, total, modelName);
        },
      });

      // Send completion event
      sendDownloadComplete(config.name, modelName);
    } catch (error) {
      // Send error event
      sendDownloadError(error as Error, config.name || 'Unknown Model');
      throw new Error(`Failed to download model: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('models:delete', async (_event, modelId: string) => {
    try {
      await modelManager.deleteModel(modelId);
    } catch (error) {
      throw new Error(`Failed to delete model: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('models:getInfo', async (_event, modelId: string) => {
    try {
      return await modelManager.getModelInfo(modelId);
    } catch (error) {
      throw new Error(`Failed to get model info: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('models:verify', async (_event, modelId: string) => {
    try {
      return await modelManager.verifyModel(modelId);
    } catch (error) {
      throw new Error(`Failed to verify model: ${(error as Error).message}`);
    }
  });

  // Note: getStorageInfo will be added in a future version of genai-electron
  // For now, storage info can be calculated from model list

  // ========================================
  // Server Control Handlers
  // ========================================

  ipcMain.handle('server:start', async (_event, config) => {
    try {
      await llamaServer.start(config);
    } catch (error) {
      const err = error as Error;
      // Provide helpful error messages
      if (err.message.includes('RAM') || err.message.includes('memory')) {
        throw new Error(`Insufficient RAM: ${err.message}`);
      } else if (err.message.includes('port')) {
        throw new Error(`Port conflict: ${err.message}`);
      } else if (err.message.includes('model')) {
        throw new Error(`Model error: ${err.message}`);
      }
      throw new Error(`Failed to start server: ${err.message}`);
    }
  });

  ipcMain.handle('server:stop', async () => {
    try {
      await llamaServer.stop();
    } catch (error) {
      throw new Error(`Failed to stop server: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('server:restart', async () => {
    try {
      await llamaServer.restart();
    } catch (error) {
      throw new Error(`Failed to restart server: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('server:status', () => {
    try {
      return llamaServer.getInfo();
    } catch (error) {
      throw new Error(`Failed to get server status: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('server:health', async () => {
    try {
      return await llamaServer.isHealthy();
    } catch (error) {
      throw new Error(`Failed to check server health: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('server:logs', async (_event, limit: number) => {
    try {
      const logStrings = await llamaServer.getLogs(limit);

      // Parse log strings into LogEntry objects
      return logStrings.map((logLine) => {
        const parsed = LogManager.parseEntry(logLine);

        // If parsing fails, create a fallback entry
        if (!parsed) {
          return {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: logLine,
          };
        }

        return parsed;
      });
    } catch (error) {
      throw new Error(`Failed to get server logs: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('server:clearLogs', async () => {
    try {
      await llamaServer.clearLogs();
    } catch (error) {
      throw new Error(`Failed to clear logs: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('server:testMessage', async (_event, message: string, settings?: any) => {
    try {
      // Create LLMService instance (llama.cpp doesn't need real API keys)
      const llmService = new LLMService(async () => 'not-needed');

      // Get server info to determine the port
      const serverInfo = llamaServer.getInfo();

      if (serverInfo.status !== 'running' || !serverInfo.port) {
        throw new Error('Server is not running');
      }

      // Send message using genai-lite
      const response = await llmService.sendMessage({
        providerId: 'llamacpp',
        modelId: serverInfo.modelId || 'unknown-model',
        messages: [
          {
            role: 'user',
            content: message,
          },
        ],
        settings: settings || {},
      });

      return response;
    } catch (error) {
      throw new Error(`Failed to send test message: ${(error as Error).message}`);
    }
  });
}
