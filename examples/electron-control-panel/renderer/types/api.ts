// Import types from genai-electron library
import type {
  SystemCapabilities,
  MemoryInfo,
  GPUInfo,
  GGUFMetadata,
  ModelInfo,
  DownloadConfig,
  LlamaServerConfig,
  ServerStatus as LibraryServerStatus,
  ServerInfo,
  LogEntry,
  BinaryLogEvent,
  ImageSampler,
  ImageGenerationConfig,
  ImageGenerationStage,
  ImageGenerationProgress,
  DiffusionServerInfo as LibraryDiffusionServerInfo,
  SavedLLMState as LibrarySavedLLMState,
  DiffusionComponentRole,
  DiffusionComponentDownload,
  DiffusionModelComponents,
} from 'genai-electron';

// Re-export library types for convenience
export type {
  SystemCapabilities,
  MemoryInfo,
  GPUInfo,
  GGUFMetadata,
  ModelInfo,
  DownloadConfig,
  LlamaServerConfig,
  LogEntry,
  BinaryLogEvent,
  ImageSampler,
  ImageGenerationConfig,
  ImageGenerationStage,
  ImageGenerationProgress,
  DiffusionComponentRole,
  DiffusionComponentDownload,
  DiffusionModelComponents,
};

// App-specific extension: ImageGenerationResult with imageDataUrl field
// The library returns Buffer, but the app needs data URL for display
export interface ImageGenerationResult {
  imageDataUrl: string; // data:image/png;base64,...
  timeTaken: number;
  seed: number;
  width: number;
  height: number;
}

// App-specific type: Storage information
export interface StorageInfo {
  totalSize: number;
  availableSpace: number;
  modelCount: number;
}

// App-specific adaptation: ServerStatus combines library ServerInfo fields
export interface ServerStatus {
  status: 'running' | 'stopped' | 'starting' | 'stopping' | 'crashed' | 'error';
  health: 'unknown' | 'healthy' | 'unhealthy';
  modelId: string;
  port: number;
  pid?: number;
  startedAt?: string;
  error?: string;
}

// App-specific adaptation: DiffusionServerInfo with additional fields
export interface DiffusionServerInfo extends LibraryDiffusionServerInfo {
  health: 'unknown' | 'healthy' | 'unhealthy';
}

// App-specific adaptation: SavedLLMState with serialized Date
export interface SavedLLMState {
  config: LlamaServerConfig;
  wasRunning: boolean;
  savedAt: string; // ISO timestamp (Date serialized from main process)
}

// App-specific type: Resource usage aggregation
export interface ResourceUsage {
  memory: {
    total: number;
    available: number;
    used: number;
  };
  llamaServer: {
    status: 'running' | 'stopped' | 'starting' | 'stopping' | 'crashed' | 'error';
    pid?: number;
    port: number;
  };
  diffusionServer: {
    status: 'running' | 'stopped' | 'starting' | 'stopping' | 'crashed' | 'error';
    pid?: number;
    port: number;
    busy?: boolean;
  };
}

// Window API types (from preload) - app-specific
export interface WindowAPI {
  system: {
    detect: () => Promise<SystemCapabilities>;
    getMemory: () => Promise<MemoryInfo>;
    getGPU: () => Promise<GPUInfo>;
    canRunModel: (modelInfo: ModelInfo) => Promise<{ canRun: boolean; reason?: string }>;
    getOptimalConfig: (modelInfo: ModelInfo) => Promise<LlamaServerConfig>;
  };
  models: {
    list: (type: 'llm' | 'diffusion') => Promise<ModelInfo[]>;
    download: (config: DownloadConfig) => Promise<void>;
    delete: (modelId: string) => Promise<void>;
    getInfo: (modelId: string) => Promise<ModelInfo>;
    verify: (modelId: string) => Promise<boolean>;
    getStorageInfo: () => Promise<StorageInfo>;
    updateMetadata: (modelId: string) => Promise<ModelInfo>;
  };
  server: {
    start: (config: LlamaServerConfig) => Promise<void>;
    stop: () => Promise<void>;
    restart: () => Promise<void>;
    status: () => Promise<ServerStatus>;
    health: () => Promise<boolean>;
    logs: (limit: number) => Promise<LogEntry[]>;
    clearLogs: () => Promise<void>;
    testMessage: (message: string, settings?: unknown) => Promise<unknown>;
  };
  diffusion: {
    start: (config: {
      modelId: string;
      port?: number;
      threads?: number;
      gpuLayers?: number;
    }) => Promise<void>;
    stop: () => Promise<void>;
    status: () => Promise<DiffusionServerInfo>;
    health: () => Promise<boolean>;
    logs: (limit: number) => Promise<LogEntry[]>;
    clearLogs: () => Promise<void>;
    generateImage: (config: ImageGenerationConfig, port?: number) => Promise<ImageGenerationResult>;
  };
  resources: {
    wouldNeedOffload: () => Promise<boolean>;
    getSavedState: () => Promise<SavedLLMState | null>;
    clearSavedState: () => Promise<void>;
    getUsage: () => Promise<ResourceUsage>;
  };
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  off: (channel: string) => void;
}

// Global window extension
declare global {
  interface Window {
    api: WindowAPI;
  }
}
