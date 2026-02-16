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
  sendComponentStart,
  sendImageProgress,
} from './genai-api.js';
import { MetadataFetchStrategy, formatErrorForUI } from 'genai-electron';
import { LLMService, ImageService } from 'genai-lite';

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

  ipcMain.handle('system:getGPU', async () => {
    try {
      return await systemInfo.getGPUInfo();
    } catch (error) {
      throw new Error(`Failed to get GPU info: ${(error as Error).message}`);
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
        onComponentStart: (info: {
          role: string;
          filename: string;
          index: number;
          total: number;
        }) => {
          sendComponentStart(info.role, info.filename, info.index, info.total, modelName);
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

  ipcMain.handle(
    'models:updateMetadata',
    async (_event, modelId: string, options?: { source?: MetadataFetchStrategy }) => {
      try {
        return await modelManager.updateModelMetadata(modelId, options);
      } catch (error) {
        throw new Error(`Failed to update model metadata: ${(error as Error).message}`);
      }
    }
  );

  // Note: getStorageInfo will be added in a future version of genai-electron
  // For now, storage info can be calculated from model list

  // ========================================
  // Server Control Handlers
  // ========================================

  ipcMain.handle('server:start', async (_event, config) => {
    try {
      await llamaServer.start(config);
    } catch (error) {
      const formatted = formatErrorForUI(error);
      throw new Error(`${formatted.title}: ${formatted.message}`);
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
      // Use new getStructuredLogs() API from genai-electron
      return await llamaServer.getStructuredLogs(limit);
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
      // DEBUG: Log incoming settings
      console.log('[DEBUG] Test message settings:', JSON.stringify(settings, null, 2));

      // Create LLMService instance (llama.cpp doesn't need real API keys)
      const llmService = new LLMService(async () => 'not-needed');

      // Get server info to determine the port
      const serverInfo = llamaServer.getInfo();
      console.log('[DEBUG] Server info:', {
        status: serverInfo.status,
        port: serverInfo.port,
        modelId: serverInfo.modelId,
      });

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

      // DEBUG: Log response details
      console.log('[DEBUG] Response object type:', response.object);
      if (response.object === 'chat.completion') {
        console.log('[DEBUG] Response usage:', response.usage);
        console.log('[DEBUG] Finish reason:', response.choices[0]?.finish_reason);
        console.log(
          '[DEBUG] Response length:',
          response.choices[0]?.message?.content?.length,
          'chars'
        );
      }

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
      // Use new getStructuredLogs() API from genai-electron
      return await diffusionServer.getStructuredLogs(limit);
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

  // Generate image using genai-lite ImageService (with automatic orchestration)
  ipcMain.handle('diffusion:generate', async (_event, config) => {
    try {
      // Create ImageService instance (genai-electron-images doesn't need API keys)
      const imageService = new ImageService(async () => 'not-needed');

      // Get diffusion server info to ensure it's running
      const serverInfo = diffusionServer.getInfo();
      if (serverInfo.status !== 'running') {
        throw new Error('Diffusion server is not running');
      }

      // Track generation time
      const startTime = Date.now();

      // Generate image using genai-lite with genai-electron-images provider
      const result = await imageService.generateImage({
        providerId: 'genai-electron-images',
        modelId: 'stable-diffusion', // Generic ID for whatever model is loaded
        prompt: config.prompt,
        settings: {
          width: config.width || 512,
          height: config.height || 512,
          diffusion: {
            negativePrompt: config.negativePrompt,
            steps: config.steps || 20,
            cfgScale: config.cfgScale || 7.5,
            seed: config.seed || -1,
            sampler: config.sampler || 'euler_a',
            // Progress callback to send updates to renderer
            onProgress: (progress) => {
              sendImageProgress(
                progress.currentStep,
                progress.totalSteps,
                progress.stage,
                progress.percentage
              );
            },
          },
        },
      });

      const timeTaken = Date.now() - startTime;

      // Handle error response
      if (result.object === 'error') {
        throw new Error(result.error.message);
      }

      // Extract image data from genai-lite response
      const imageData = result.data[0];

      // Return in format expected by renderer
      return {
        imageDataUrl: `data:image/png;base64,${imageData.data.toString('base64')}`,
        timeTaken,
        seed: imageData.seed || -1,
        width: imageData.width,
        height: imageData.height,
      };
    } catch (error) {
      throw new Error(`Failed to generate image: ${(error as Error).message}`);
    }
  });

  // ========================================
  // Resource Orchestrator Handlers (Phase 2)
  // ========================================

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

  // ========================================
  // Debug Handlers
  // ========================================

  ipcMain.handle('debug:llmConfig', () => {
    try {
      const config = llamaServer.getConfig();
      const info = llamaServer.getInfo();

      console.log('\n=== LLM Server Config ===');
      console.log('Status:', info.status);
      if (config) {
        console.log('Model ID:', config.modelId);
        console.log('Port:', config.port);
        console.log('GPU Layers:', config.gpuLayers);
        console.log('Threads:', config.threads);
        console.log('Context Size:', config.contextSize);
        console.log('Parallel Requests:', config.parallelRequests);
        console.log('Flash Attention:', config.flashAttention);
      } else {
        console.log('No config (server not started)');
      }
      console.log('=========================\n');

      return { config, info };
    } catch (error) {
      throw new Error(`Failed to get LLM config: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('debug:systemCapabilities', async () => {
    try {
      const capabilities = await systemInfo.detect();

      console.log('\n=== System Capabilities ===');
      console.log('CPU Cores:', capabilities.cpu.cores);
      console.log('CPU Model:', capabilities.cpu.model);
      console.log('Architecture:', capabilities.cpu.architecture);
      console.log('Total RAM:', (capabilities.memory.total / 1024 ** 3).toFixed(2), 'GB');
      console.log('Available RAM:', (capabilities.memory.available / 1024 ** 3).toFixed(2), 'GB');
      console.log('GPU Available:', capabilities.gpu.available);
      if (capabilities.gpu.available) {
        console.log('GPU Type:', capabilities.gpu.type);
        console.log('GPU Name:', capabilities.gpu.name);
        if (capabilities.gpu.vram) {
          console.log('VRAM:', (capabilities.gpu.vram / 1024 ** 3).toFixed(2), 'GB');
        }
        console.log('CUDA:', capabilities.gpu.cuda);
        console.log('Metal:', capabilities.gpu.metal);
        console.log('Vulkan:', capabilities.gpu.vulkan);
      }
      console.log('===========================\n');

      return capabilities;
    } catch (error) {
      throw new Error(`Failed to get system capabilities: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('debug:optimalConfig', async (_event, modelId: string) => {
    try {
      const modelInfo = await modelManager.getModelInfo(modelId);
      const optimalConfig = await systemInfo.getOptimalConfig(modelInfo);

      console.log('\n=== Optimal Config for', modelInfo.name, '===');
      console.log('Model Size:', (modelInfo.size / 1024 ** 3).toFixed(2), 'GB');
      console.log('Recommended Threads:', optimalConfig.threads);
      console.log('Recommended GPU Layers:', optimalConfig.gpuLayers);
      console.log('Recommended Context Size:', optimalConfig.contextSize);
      console.log('Recommended Parallel Requests:', optimalConfig.parallelRequests);
      console.log('Flash Attention:', optimalConfig.flashAttention);
      console.log('===============================\n');

      return { modelInfo, optimalConfig };
    } catch (error) {
      throw new Error(`Failed to get optimal config: ${(error as Error).message}`);
    }
  });

  ipcMain.handle('debug:resourceEstimates', async () => {
    try {
      const orchestrator = getOrchestrator();
      const capabilities = await systemInfo.detect();
      const memory = systemInfo.getMemoryInfo();

      // Get configs
      const llamaConfig = llamaServer.getConfig();
      const diffusionConfig = diffusionServer.getConfig();

      console.log('\n=== Resource Estimates ===');

      // LLM estimates
      if (llamaConfig) {
        const llamaModel = await modelManager.getModelInfo(llamaConfig.modelId);
        const gpuLayers = llamaConfig.gpuLayers || 0;
        const totalLayers = 32; // estimate
        const gpuRatio = gpuLayers > 0 ? Math.min(gpuLayers / totalLayers, 1.0) : 0;

        const llamaRam = llamaModel.size * (1 - gpuRatio) * 1.2;
        const llamaVram = llamaModel.size * gpuRatio * 1.2;

        console.log('LLM Model:', llamaConfig.modelId);
        console.log('LLM Size:', (llamaModel.size / 1024 ** 3).toFixed(2), 'GB');
        console.log('LLM GPU Layers:', gpuLayers, '/', totalLayers);
        console.log('LLM RAM Usage:', (llamaRam / 1024 ** 3).toFixed(2), 'GB');
        console.log('LLM VRAM Usage:', (llamaVram / 1024 ** 3).toFixed(2), 'GB');
      } else {
        console.log('LLM: Not running');
      }

      // Diffusion estimates
      if (diffusionConfig) {
        const diffusionModel = await modelManager.getModelInfo(diffusionConfig.modelId);
        const diffusionUsage = diffusionModel.size * 1.2;

        console.log('Diffusion Model:', diffusionConfig.modelId);
        console.log('Diffusion Size:', (diffusionModel.size / 1024 ** 3).toFixed(2), 'GB');
        console.log('Diffusion RAM Usage:', (diffusionUsage / 1024 ** 3).toFixed(2), 'GB');
        console.log('Diffusion VRAM Usage:', (diffusionUsage / 1024 ** 3).toFixed(2), 'GB');
      } else {
        console.log('Diffusion: Not running');
      }

      // System resources
      console.log('\n--- System Resources ---');
      console.log('Total RAM:', (memory.total / 1024 ** 3).toFixed(2), 'GB');
      console.log('Available RAM:', (memory.available / 1024 ** 3).toFixed(2), 'GB');
      if (capabilities.gpu.vram) {
        console.log('Total VRAM:', (capabilities.gpu.vram / 1024 ** 3).toFixed(2), 'GB');
      }

      // Offload decision
      const wouldOffload = await orchestrator.wouldNeedOffload();
      console.log('\n--- Orchestration ---');
      console.log('Would need offload:', wouldOffload);
      console.log('==========================\n');

      return { capabilities, memory, wouldOffload };
    } catch (error) {
      throw new Error(`Failed to get resource estimates: ${(error as Error).message}`);
    }
  });
}
