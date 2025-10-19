/**
 * genai-electron - Electron-specific library for managing local AI model servers
 *
 * An Electron-specific library for managing local AI model servers and resources.
 * Complements genai-lite by handling the platform-specific heavy lifting required
 * to run AI models locally on desktop systems.
 *
 * @module genai-electron
 * @version 0.1.0
 * @license MIT
 *
 * @example
 * ```typescript
 * import { systemInfo, modelManager, llamaServer } from 'genai-electron';
 *
 * // Detect system capabilities
 * const capabilities = await systemInfo.detect();
 * console.log('Max model size:', capabilities.recommendations.maxModelSize);
 *
 * // Download a model
 * await modelManager.downloadModel({
 *   source: 'url',
 *   url: 'https://example.com/model.gguf',
 *   name: 'Llama 2 7B',
 *   type: 'llm',
 *   onProgress: (downloaded, total) => {
 *     console.log(`Progress: ${((downloaded / total) * 100).toFixed(1)}%`);
 *   }
 * });
 *
 * // Start llama-server with auto-configuration
 * await llamaServer.start({
 *   modelId: 'llama-2-7b',
 *   port: 8080
 * });
 *
 * // Check server health
 * const healthy = await llamaServer.isHealthy();
 *
 * // Get server logs
 * const logs = await llamaServer.getLogs(50);
 *
 * // Stop server
 * await llamaServer.stop();
 * ```
 */

// ============================================================================
// Singleton Instances (Recommended for most use cases)
// ============================================================================

import { SystemInfo } from './system/SystemInfo.js';
import { ModelManager } from './managers/ModelManager.js';
import { LlamaServerManager } from './managers/LlamaServerManager.js';
import { DiffusionServerManager } from './managers/DiffusionServerManager.js';

/**
 * System information singleton
 *
 * Provides system capability detection, hardware recommendations,
 * and model compatibility validation.
 *
 * @example
 * ```typescript
 * import { systemInfo } from 'genai-electron';
 *
 * const capabilities = await systemInfo.detect();
 * console.log('GPU:', capabilities.gpu);
 * console.log('RAM:', capabilities.memory.total);
 * console.log('Recommended model size:', capabilities.recommendations.maxModelSize);
 * ```
 */
export const systemInfo = SystemInfo.getInstance();

/**
 * Model manager singleton
 *
 * Handles model downloading, storage, and management.
 *
 * @example
 * ```typescript
 * import { modelManager } from 'genai-electron';
 *
 * // List installed models
 * const models = await modelManager.listModels('llm');
 *
 * // Download a model
 * await modelManager.downloadModel({
 *   source: 'url',
 *   url: 'https://huggingface.co/TheBloke/Llama-2-7B-GGUF/resolve/main/llama-2-7b.Q4_K_M.gguf',
 *   name: 'Llama 2 7B',
 *   type: 'llm'
 * });
 *
 * // Delete a model
 * await modelManager.deleteModel('model-id');
 * ```
 */
export const modelManager = ModelManager.getInstance();

/**
 * Llama server manager singleton
 *
 * Manages llama-server lifecycle, including binary downloads,
 * process spawning, health checking, and log management.
 *
 * @example
 * ```typescript
 * import { llamaServer } from 'genai-electron';
 *
 * // Start server
 * await llamaServer.start({
 *   modelId: 'llama-2-7b',
 *   port: 8080,
 *   threads: 8,
 *   gpuLayers: 35
 * });
 *
 * // Listen to events
 * llamaServer.on('started', () => console.log('Server started'));
 * llamaServer.on('stopped', () => console.log('Server stopped'));
 * llamaServer.on('crashed', (error) => console.error('Server crashed:', error));
 *
 * // Check health
 * const healthy = await llamaServer.isHealthy();
 *
 * // Get logs
 * const logs = await llamaServer.getLogs(100);
 *
 * // Stop server
 * await llamaServer.stop();
 * ```
 */
export const llamaServer = new LlamaServerManager();

/**
 * Diffusion server manager singleton (Phase 2)
 *
 * Manages diffusion HTTP wrapper server for stable-diffusion.cpp,
 * including image generation, binary downloads, and resource management.
 *
 * @example
 * ```typescript
 * import { diffusionServer } from 'genai-electron';
 *
 * // Start server
 * await diffusionServer.start({
 *   modelId: 'sdxl-turbo',
 *   port: 8081
 * });
 *
 * // Generate image
 * const result = await diffusionServer.generateImage({
 *   prompt: 'A serene mountain landscape at sunset',
 *   width: 1024,
 *   height: 1024,
 *   steps: 30,
 *   onProgress: (step, total) => console.log(`Step ${step}/${total}`)
 * });
 *
 * // Save image
 * await fs.writeFile('output.png', result.image);
 *
 * // Stop server
 * await diffusionServer.stop();
 * ```
 */
export const diffusionServer = new DiffusionServerManager();

// ============================================================================
// Classes (For advanced usage or custom instances)
// ============================================================================

export { SystemInfo } from './system/SystemInfo.js';
export { ModelManager } from './managers/ModelManager.js';
export { LlamaServerManager } from './managers/LlamaServerManager.js';
export { DiffusionServerManager } from './managers/DiffusionServerManager.js';
export { ResourceOrchestrator } from './managers/ResourceOrchestrator.js';
export { ServerManager } from './managers/ServerManager.js';
export { StorageManager } from './managers/StorageManager.js';
export { ProcessManager } from './process/ProcessManager.js';
export { LogManager } from './process/log-manager.js';
export { Downloader } from './download/Downloader.js';

// ============================================================================
// Utility Functions
// ============================================================================

export { checkHealth, waitForHealthy, isServerResponding } from './process/health-check.js';
export { getCPUInfo, getRecommendedThreads } from './system/cpu-detect.js';
export { getMemoryInfo, estimateVRAM } from './system/memory-detect.js';
export { detectGPU } from './system/gpu-detect.js';
export { getHuggingFaceURL, parseHuggingFaceURL } from './download/huggingface.js';
export { calculateSHA256, verifyChecksum } from './download/checksum.js';
export {
  getPlatform,
  getArchitecture,
  getPlatformKey,
  isMac,
  isWindows,
  isLinux,
  isAppleSilicon,
} from './utils/platform-utils.js';
export {
  ensureDirectory,
  fileExists,
  getFileSize,
  deleteFile,
  moveFile,
  calculateChecksum,
  formatBytes,
  sanitizeFilename,
} from './utils/file-utils.js';
export { detectReasoningSupport, REASONING_MODEL_PATTERNS } from './config/reasoning-models.js';

// ============================================================================
// Configuration and Paths
// ============================================================================

export { PATHS, getBinaryPath, getModelFilePath } from './config/paths.js';
export { BINARY_VERSIONS, DEFAULT_PORTS, DEFAULT_TIMEOUTS } from './config/defaults.js';

// ============================================================================
// Type Exports
// ============================================================================

export type {
  // System types
  GPUInfo,
  CPUInfo,
  MemoryInfo,
  SystemCapabilities,
  SystemRecommendations,
  // Model types
  ModelType,
  ModelInfo,
  ModelSource,
  DownloadConfig,
  DownloadProgress,
  DownloadProgressCallback,
  // Server types
  ServerStatus,
  HealthStatus,
  ServerConfig,
  ServerInfo,
  LlamaServerConfig,
  ServerEvent,
  ServerEventData,
  // Image generation types (Phase 2)
  ImageSampler,
  ImageGenerationConfig,
  ImageGenerationResult,
  DiffusionServerConfig,
  DiffusionServerInfo,
  // Utility types
  Optional,
  RequiredKeys,
  OptionalKeys,
  JSONValue,
} from './types/index.js';

export type { SpawnOptions, SpawnResult } from './process/ProcessManager.js';

export type { HealthCheckResponse } from './process/health-check.js';

export type { LogLevel, LogEntry } from './process/log-manager.js';

// ============================================================================
// Error Exports
// ============================================================================

export {
  GenaiElectronError,
  ModelNotFoundError,
  DownloadError,
  InsufficientResourcesError,
  ServerError,
  PortInUseError,
  FileSystemError,
  ChecksumError,
  BinaryError,
} from './errors/index.js';
