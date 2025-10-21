// Window API types (from preload)
export interface WindowAPI {
  system: {
    detect: () => Promise<SystemCapabilities>;
    getMemory: () => Promise<MemoryInfo>;
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
    orchestrateGeneration: (config: ImageGenerationConfig) => Promise<ImageGenerationResult>;
    wouldNeedOffload: () => Promise<boolean>;
    getSavedState: () => Promise<SavedLLMState | null>;
    clearSavedState: () => Promise<void>;
    getUsage: () => Promise<ResourceUsage>;
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
export interface GGUFMetadata {
  version?: number;
  tensor_count?: bigint | number;
  kv_count?: bigint | number;
  architecture?: string;
  general_name?: string;
  file_type?: number;
  block_count?: number;
  context_length?: number;
  attention_head_count?: number;
  embedding_length?: number;
  feed_forward_length?: number;
  vocab_size?: number;
  rope_dimension_count?: number;
  rope_freq_base?: number;
  attention_layer_norm_rms_epsilon?: number;
  raw?: Record<string, unknown>;
}

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
  ggufMetadata?: GGUFMetadata;
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
export interface LlamaServerConfig {
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

// Binary Download/Testing Log Event
export interface BinaryLogEvent {
  message: string;
  level: 'info' | 'warn' | 'error';
}

// ========================================
// Phase 2: Image Generation Types
// ========================================

export type ImageSampler =
  | 'euler_a'
  | 'euler'
  | 'heun'
  | 'dpm2'
  | 'dpm++2s_a'
  | 'dpm++2m'
  | 'dpm++2mv2'
  | 'lcm';

export interface ImageGenerationConfig {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: number;
  sampler?: ImageSampler;
}

export interface ImageGenerationResult {
  imageDataUrl: string; // data:image/png;base64,...
  timeTaken: number;
  seed: number;
  width: number;
  height: number;
}

export interface DiffusionServerInfo {
  status: 'running' | 'stopped' | 'starting' | 'stopping' | 'crashed' | 'error';
  health: 'unknown' | 'healthy' | 'unhealthy';
  modelId: string;
  port: number;
  pid?: number;
  startedAt?: string;
  error?: string;
  busy?: boolean;
}

export interface SavedLLMState {
  config: LlamaServerConfig;
  wasRunning: boolean;
  savedAt: string; // ISO timestamp (Date serialized from main process)
}

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

// Global window extension
declare global {
  interface Window {
    api: WindowAPI;
  }
}
