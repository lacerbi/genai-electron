// Window API types (from preload)
export interface WindowAPI {
  system: {
    detect: () => Promise<SystemCapabilities>;
    getMemory: () => Promise<MemoryInfo>;
    canRunModel: (modelInfo: ModelInfo) => Promise<{ canRun: boolean; reason?: string }>;
    getOptimalConfig: (modelInfo: ModelInfo) => Promise<ServerConfig>;
  };
  models: {
    list: (type: 'llm' | 'diffusion') => Promise<ModelInfo[]>;
    download: (config: DownloadConfig) => Promise<void>;
    delete: (modelId: string) => Promise<void>;
    getInfo: (modelId: string) => Promise<ModelInfo>;
    verify: (modelId: string) => Promise<boolean>;
    getStorageInfo: () => Promise<StorageInfo>;
  };
  server: {
    start: (config: ServerConfig) => Promise<void>;
    stop: () => Promise<void>;
    restart: () => Promise<void>;
    status: () => Promise<ServerStatus>;
    health: () => Promise<boolean>;
    logs: (limit: number) => Promise<LogEntry[]>;
  };
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  off: (channel: string) => void;
}

// System Info Types
export interface SystemCapabilities {
  cpu: {
    cores: number;
    model: string;
    arch: string;
  };
  memory: {
    total: number;
    available: number;
  };
  gpu: {
    available: boolean;
    type?: string;
    name?: string;
    vram?: number;
    vramAvailable?: number;
  };
  recommendations: {
    maxModelSize: string;
    maxGpuLayers: number;
    recommendedModels: Array<{
      name: string;
      size: string;
      supported: boolean;
    }>;
  };
}

export interface MemoryInfo {
  total: number;
  available: number;
}

// Model Types
export interface ModelInfo {
  id: string;
  name: string;
  type: 'llm' | 'diffusion';
  size: number;
  downloadedAt: string;
  source?: {
    type: string;
    repo?: string;
    file?: string;
    url?: string;
  };
}

export interface DownloadConfig {
  source: 'url' | 'huggingface';
  url?: string;
  repo?: string;
  file?: string;
  name: string;
  type: 'llm' | 'diffusion';
  checksum?: string;
  onProgress?: (downloaded: number, total: number) => void;
}

export interface StorageInfo {
  totalSize: number;
  availableSpace: number;
  modelCount: number;
}

// Server Types
export interface ServerConfig {
  modelId: string;
  port?: number;
  contextSize?: number;
  gpuLayers?: number;
  threads?: number;
  parallelRequests?: number;
  flashAttention?: boolean;
}

export interface ServerStatus {
  status: 'running' | 'stopped' | 'starting' | 'stopping' | 'crashed' | 'error';
  health: 'unknown' | 'healthy' | 'unhealthy';
  modelId: string;
  port: number;
  pid?: number;
  startedAt?: string;
  error?: string;
}

// Log Types
export interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
}

// Global window extension
declare global {
  interface Window {
    api: WindowAPI;
  }
}
