import { contextBridge, ipcRenderer } from 'electron';

console.log('[PRELOAD] Script is running');
console.log('[PRELOAD] contextBridge available:', !!contextBridge);
console.log('[PRELOAD] ipcRenderer available:', !!ipcRenderer);

// Expose protected methods that allow the renderer process to use ipcRenderer
contextBridge.exposeInMainWorld('api', {
  // System Info APIs
  system: {
    detect: () => ipcRenderer.invoke('system:detect'),
    getMemory: () => ipcRenderer.invoke('system:getMemory'),
    canRunModel: (modelInfo: unknown) => ipcRenderer.invoke('system:canRunModel', modelInfo),
    getOptimalConfig: (modelInfo: unknown) =>
      ipcRenderer.invoke('system:getOptimalConfig', modelInfo),
  },

  // Model Management APIs
  models: {
    list: (type: string) => ipcRenderer.invoke('models:list', type),
    download: (config: unknown) => ipcRenderer.invoke('models:download', config),
    delete: (modelId: string) => ipcRenderer.invoke('models:delete', modelId),
    getInfo: (modelId: string) => ipcRenderer.invoke('models:getInfo', modelId),
    verify: (modelId: string) => ipcRenderer.invoke('models:verify', modelId),
    updateMetadata: (modelId: string) => ipcRenderer.invoke('models:updateMetadata', modelId),
    getStorageInfo: () => ipcRenderer.invoke('models:getStorageInfo'),
  },

  // Server Control APIs
  server: {
    start: (config: unknown) => ipcRenderer.invoke('server:start', config),
    stop: () => ipcRenderer.invoke('server:stop'),
    restart: () => ipcRenderer.invoke('server:restart'),
    status: () => ipcRenderer.invoke('server:status'),
    health: () => ipcRenderer.invoke('server:health'),
    logs: (limit: number) => ipcRenderer.invoke('server:logs', limit),
    clearLogs: () => ipcRenderer.invoke('server:clearLogs'),
    testMessage: (message: string, settings?: unknown) =>
      ipcRenderer.invoke('server:testMessage', message, settings),
  },

  // Diffusion Server APIs (Phase 2)
  diffusion: {
    start: (config: unknown) => ipcRenderer.invoke('diffusion:start', config),
    stop: () => ipcRenderer.invoke('diffusion:stop'),
    status: () => ipcRenderer.invoke('diffusion:status'),
    health: () => ipcRenderer.invoke('diffusion:health'),
    logs: (limit: number) => ipcRenderer.invoke('diffusion:logs', limit),
    clearLogs: () => ipcRenderer.invoke('diffusion:clearLogs'),
    generateImage: (config: unknown, port?: number) =>
      ipcRenderer.invoke('diffusion:generate', config, port),
  },

  // Resource Orchestrator APIs (Phase 2)
  resources: {
    orchestrateGeneration: (config: unknown) =>
      ipcRenderer.invoke('resources:orchestrateGeneration', config),
    wouldNeedOffload: () => ipcRenderer.invoke('resources:wouldNeedOffload'),
    getSavedState: () => ipcRenderer.invoke('resources:getSavedState'),
    clearSavedState: () => ipcRenderer.invoke('resources:clearSavedState'),
    getUsage: () => ipcRenderer.invoke('resources:getUsage'),
  },

  // Debug APIs
  debug: {
    getLLMConfig: () => ipcRenderer.invoke('debug:llmConfig'),
    getSystemCapabilities: () => ipcRenderer.invoke('debug:systemCapabilities'),
    getOptimalConfig: (modelId: string) => ipcRenderer.invoke('debug:optimalConfig', modelId),
    getResourceEstimates: () => ipcRenderer.invoke('debug:resourceEstimates'),
  },

  // Event listeners
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const validChannels = [
      'download:progress',
      'download:complete',
      'download:error',
      'server:started',
      'server:stopped',
      'server:crashed',
      'server:binary-log',
      'diffusion:started',
      'diffusion:stopped',
      'diffusion:crashed',
      'diffusion:binary-log',
      'diffusion:progress',
    ];

    if (validChannels.includes(channel)) {
      // Remove existing listeners to prevent duplicates
      ipcRenderer.removeAllListeners(channel);
      // Add new listener
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    } else {
      console.error(`Invalid channel: ${channel}`);
    }
  },

  // Remove event listeners
  off: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});

console.log('[PRELOAD] window.api exposed successfully');

// Type declaration for the window object (to be used in renderer)
export type WindowAPI = {
  system: {
    detect: () => Promise<unknown>;
    getMemory: () => Promise<unknown>;
    canRunModel: (modelInfo: unknown) => Promise<{ canRun: boolean; reason?: string }>;
    getOptimalConfig: (modelInfo: unknown) => Promise<unknown>;
  };
  models: {
    list: (type: string) => Promise<unknown[]>;
    download: (config: unknown) => Promise<void>;
    delete: (modelId: string) => Promise<void>;
    getInfo: (modelId: string) => Promise<unknown>;
    verify: (modelId: string) => Promise<boolean>;
    getStorageInfo: () => Promise<unknown>;
  };
  server: {
    start: (config: unknown) => Promise<void>;
    stop: () => Promise<void>;
    restart: () => Promise<void>;
    status: () => Promise<unknown>;
    health: () => Promise<boolean>;
    logs: (limit: number) => Promise<unknown[]>;
    clearLogs: () => Promise<void>;
    testMessage: (message: string, settings?: unknown) => Promise<unknown>;
  };
  diffusion: {
    start: (config: unknown) => Promise<void>;
    stop: () => Promise<void>;
    status: () => Promise<unknown>;
    health: () => Promise<boolean>;
    logs: (limit: number) => Promise<unknown[]>;
    clearLogs: () => Promise<void>;
    generateImage: (config: unknown, port?: number) => Promise<unknown>;
  };
  resources: {
    orchestrateGeneration: (config: unknown) => Promise<unknown>;
    wouldNeedOffload: () => Promise<boolean>;
    getSavedState: () => Promise<unknown>;
    clearSavedState: () => Promise<void>;
    getUsage: () => Promise<unknown>;
  };
  debug: {
    getLLMConfig: () => Promise<unknown>;
    getSystemCapabilities: () => Promise<unknown>;
    getOptimalConfig: (modelId: string) => Promise<unknown>;
    getResourceEstimates: () => Promise<unknown>;
  };
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  off: (channel: string) => void;
};
