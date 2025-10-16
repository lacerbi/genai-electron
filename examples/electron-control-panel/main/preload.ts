import { contextBridge, ipcRenderer } from 'electron';

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
  };
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  off: (channel: string) => void;
};
