/**
 * Type definitions for genai-electron
 * @module types
 */

// System types
export type {
  GPUInfo,
  CPUInfo,
  MemoryInfo,
  SystemCapabilities,
  SystemRecommendations,
} from './system.js';

// Model types
export type {
  ModelType,
  ModelInfo,
  ModelSource,
  DownloadConfig,
  DownloadProgress,
  DownloadProgressCallback,
  GGUFMetadata,
  MetadataFetchStrategy,
  DiffusionComponentRole,
  DiffusionComponentInfo,
  DiffusionModelComponents,
  DiffusionComponentDownload,
} from './models.js';

// Server types
export type {
  ServerStatus,
  HealthStatus,
  ServerConfig,
  ServerInfo,
  LlamaServerConfig,
  ServerEvent,
  ServerEventData,
  BinaryLogEvent,
} from './servers.js';

// Image generation types
export type {
  ImageSampler,
  ImageGenerationConfig,
  ImageGenerationResult,
  ImageGenerationProgress,
  ImageGenerationStage,
  DiffusionServerConfig,
  DiffusionServerInfo,
  GenerationStatus,
  GenerationState,
} from './images.js';

/**
 * Utility type to make all properties of T optional
 */
export type Optional<T> = {
  [K in keyof T]?: T[K];
};

/**
 * Utility type to extract required keys from T
 */
export type RequiredKeys<T> = {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * Utility type to extract optional keys from T
 */
export type OptionalKeys<T> = {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  [K in keyof T]-?: {} extends Pick<T, K> ? K : never;
}[keyof T];

/**
 * Utility type for JSON-serializable values
 */
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

/**
 * Utility type for async functions
 */
export type AsyncFunction<T = void> = () => Promise<T>;

/**
 * Utility type for cleanup functions
 */
export type CleanupFunction = () => void | Promise<void>;
