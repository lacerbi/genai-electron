import { ipcMain } from 'electron';
import {
  systemInfo,
  modelManager,
  llamaServer,
  diffusionServer,
  getOrchestrator,
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

  ipcMain.handle('server:testMessage', async (_event, message: string, settings?: unknown) => {
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

  // ========================================
  // Diffusion Server Handlers (Phase 2)
  // ========================================

  ipcMain.handle('diffusion:start', async (_event, config) => {
    try {
      await diffusionServer.start(config);
    } catch (error) {
      throw new Error(`Failed to start diffusion server: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('diffusion:stop', async () => {
    try {
      await diffusionServer.stop();
    } catch (error) {
      throw new Error(`Failed to stop diffusion server: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('diffusion:status', () => {
    try {
      return diffusionServer.getInfo();
    } catch (error) {
      throw new Error(`Failed to get diffusion server status: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('diffusion:health', async () => {
    try {
      return await diffusionServer.isHealthy();
    } catch (error) {
      throw new Error(`Failed to check diffusion server health: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('diffusion:logs', async (_event, limit: number) => {
    try {
      const logStrings = await diffusionServer.getLogs(limit);

      // Parse log strings into LogEntry objects
      return logStrings.map((logLine) => {
        const parsed = LogManager.parseEntry(logLine);

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
      throw new Error(`Failed to get diffusion server logs: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('diffusion:clearLogs', async () => {
    try {
      await diffusionServer.clearLogs();
    } catch (error) {
      throw new Error(`Failed to clear diffusion logs: ${(error as Error).message}`);
    }
  });

  // Generate image via HTTP (demonstrates HTTP API pattern)
  ipcMain.handle('diffusion:generate', async (_event, config, port: number = 8081) => {
    try {
      // Make HTTP request to diffusion server wrapper
      const response = await fetch(`http://localhost:${port}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: config.prompt,
          negativePrompt: config.negativePrompt,
          width: config.width || 512,
          height: config.height || 512,
          steps: config.steps || 20,
          cfgScale: config.cfgScale || 7.5,
          seed: config.seed || -1,
          sampler: config.sampler || 'euler_a',
        }),
      });

      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error || 'Image generation failed');
      }

      const result = (await response.json()) as {
        image: string;
        timeTaken: number;
        seed: number;
        width: number;
        height: number;
      };

      // Convert base64 image to data URL for renderer
      return {
        imageDataUrl: `data:image/png;base64,${result.image}`,
        timeTaken: result.timeTaken,
        seed: result.seed,
        width: result.width,
        height: result.height,
      };
    } catch (error) {
      throw new Error(`Failed to generate image: ${(error as Error).message}`);
    }
  });

  // ========================================
  // Resource Orchestrator Handlers (Phase 2)
  // ========================================

  ipcMain.handle('resources:orchestrateGeneration', async (_event, config) => {
    try {
      const orchestrator = getOrchestrator();
      const result = await orchestrator.orchestrateImageGeneration(config);

      // Convert Buffer to base64 data URL
      return {
        imageDataUrl: `data:image/png;base64,${result.image.toString('base64')}`,
        timeTaken: result.timeTaken,
        seed: result.seed,
        width: result.width,
        height: result.height,
      };
    } catch (error) {
      throw new Error(`Failed to orchestrate image generation: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('resources:wouldNeedOffload', async () => {
    try {
      const orchestrator = getOrchestrator();
      return await orchestrator.wouldNeedOffload();
    } catch (error) {
      throw new Error(`Failed to check offload requirement: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('resources:getSavedState', () => {
    try {
      const orchestrator = getOrchestrator();
      const state = orchestrator.getSavedState();

      // Serialize Date to ISO string for IPC transport
      if (state) {
        return {
          ...state,
          savedAt: state.savedAt.toISOString(),
        };
      }
      return null;
    } catch (error) {
      throw new Error(`Failed to get saved state: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('resources:clearSavedState', () => {
    try {
      const orchestrator = getOrchestrator();
      orchestrator.clearSavedState();
    } catch (error) {
      throw new Error(`Failed to clear saved state: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('resources:getUsage', async () => {
    try {
      const memoryInfo = systemInfo.getMemoryInfo();
      const llamaInfo = llamaServer.getInfo();
      const diffusionInfo = diffusionServer.getInfo();

      return {
        memory: memoryInfo,
        llamaServer: llamaInfo,
        diffusionServer: diffusionInfo,
      };
    } catch (error) {
      throw new Error(`Failed to get resource usage: ${(error as Error).message}`);
    }
  });

  // ========================================
  // System Capabilities Handler (Phase 2)
  // ========================================

  ipcMain.handle('system:getCapabilities', async () => {
    try {
      return await systemInfo.detect();
    } catch (error) {
      throw new Error(`Failed to get system capabilities: ${(error as Error).message}`);
    }
  });
}
