/**
 * DiffusionServerManager - Manages diffusion server lifecycle
 *
 * Creates an HTTP wrapper server for stable-diffusion.cpp executable.
 * Unlike llama-server (native HTTP server), stable-diffusion.cpp is a
 * one-shot executable, so we create our own HTTP server that spawns
 * the executable on-demand.
 *
 * @module managers/DiffusionServerManager
 */

import { ServerManager } from './ServerManager.js';
import { ModelManager } from './ModelManager.js';
import { SystemInfo } from '../system/SystemInfo.js';
import { ProcessManager } from '../process/ProcessManager.js';
import { ResourceOrchestrator } from './ResourceOrchestrator.js';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { getTempPath } from '../config/paths.js';
import { BINARY_VERSIONS, DEFAULT_PORTS } from '../config/defaults.js';
import { deleteFile } from '../utils/file-utils.js';
import { ServerError, ModelNotFoundError, InsufficientResourcesError } from '../errors/index.js';
import type {
  DiffusionServerConfig,
  DiffusionServerInfo,
  ImageGenerationConfig,
  ImageGenerationResult,
  ModelInfo,
  ServerInfo,
} from '../types/index.js';
import type { LlamaServerManager } from './LlamaServerManager.js';

/**
 * DiffusionServerManager class
 *
 * Manages the lifecycle of diffusion HTTP wrapper server.
 *
 * Features:
 * - HTTP server wrapper around stable-diffusion.cpp executable
 * - On-demand spawning of stable-diffusion.cpp for image generation
 * - Progress tracking during generation
 * - Automatic binary download and variant testing
 * - Log capture and retrieval
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
 *   prompt: 'A serene mountain landscape',
 *   width: 1024,
 *   height: 1024
 * });
 *
 * // Stop server
 * await diffusionServer.stop();
 * ```
 */
export class DiffusionServerManager extends ServerManager {
  private processManager: ProcessManager;
  private modelManager: ModelManager;
  private systemInfo: SystemInfo;
  private orchestrator?: ResourceOrchestrator;
  private binaryPath?: string;
  private httpServer?: http.Server;
  private currentGeneration?: {
    promise: Promise<ImageGenerationResult>;
    cancel: () => void;
  };
  private currentModelInfo?: ModelInfo;

  // Time estimates for progress calculation (self-calibrating)
  private modelLoadTime = 2000; // Fixed cost in ms
  private diffusionTimePerStepPerMegapixel = 150; // Time per step per megapixel in ms
  private vaeTimePerMegapixel = 4000; // Time per megapixel in ms

  // Current generation timing and progress tracking
  private generationStartTime?: number;
  private loadStartTime?: number;
  private loadEndTime?: number;
  private diffusionStartTime?: number;
  private diffusionEndTime?: number;
  private vaeStartTime?: number;
  private vaeEndTime?: number;
  private syntheticProgressInterval?: NodeJS.Timeout;
  private currentStage?: 'loading' | 'diffusion' | 'vae';
  private totalEstimatedTime = 0;
  private loadProgress = { current: 0, total: 0 };
  private diffusionProgress = { current: 0, total: 0 };

  /**
   * Create a new DiffusionServerManager
   *
   * @param modelManager - Model manager instance (default: singleton)
   * @param systemInfo - System info instance (default: singleton)
   * @param llamaServer - Optional LLM server manager for automatic resource orchestration
   */
  constructor(
    modelManager: ModelManager = ModelManager.getInstance(),
    systemInfo: SystemInfo = SystemInfo.getInstance(),
    llamaServer?: LlamaServerManager
  ) {
    super();
    this.processManager = new ProcessManager();
    this.modelManager = modelManager;
    this.systemInfo = systemInfo;

    // Create orchestrator if llamaServer is provided (enables automatic resource management)
    if (llamaServer) {
      this.orchestrator = new ResourceOrchestrator(systemInfo, llamaServer, this, modelManager);
    }
  }

  /**
   * Start diffusion HTTP wrapper server
   *
   * Creates an HTTP server that will spawn stable-diffusion.cpp on-demand
   * when image generation requests are received.
   *
   * @param config - Server configuration
   * @returns Server information
   * @throws {ModelNotFoundError} If model doesn't exist or wrong type
   * @throws {PortInUseError} If port is already in use
   * @throws {BinaryError} If binary download/verification fails
   * @throws {InsufficientResourcesError} If system can't run the model
   * @throws {ServerError} If server fails to start
   */
  async start(config: DiffusionServerConfig): Promise<ServerInfo> {
    if (this._status === 'running') {
      throw new ServerError('Server is already running', {
        suggestion: 'Stop the server first with stop()',
      });
    }

    this.setStatus('starting');
    this._config = config as any; // DiffusionServerConfig extends ServerConfig semantically

    try {
      // 1. Validate model exists and is correct type
      const modelInfo = await this.modelManager.getModelInfo(config.modelId);
      if (modelInfo.type !== 'diffusion') {
        throw new ModelNotFoundError(
          `Model ${config.modelId} is not a diffusion model (type: ${modelInfo.type})`
        );
      }
      this.currentModelInfo = modelInfo;

      // 2. Check if system can run this model (check total memory since model loads on-demand)
      const canRun = await this.systemInfo.canRunModel(modelInfo, { checkTotalMemory: true });
      if (!canRun.possible) {
        const memoryInfo = this.systemInfo.getMemoryInfo();
        throw new InsufficientResourcesError(
          `System cannot run model: ${canRun.reason || 'Insufficient resources'}`,
          {
            required: `Model size: ${Math.round(modelInfo.size / 1024 / 1024 / 1024)}GB`,
            available: `Total RAM: ${Math.round(memoryInfo.total / 1024 / 1024 / 1024)}GB`,
            suggestion: canRun.suggestion || canRun.reason || 'Try a smaller model',
          }
        );
      }

      // 3. Ensure binary is downloaded (pass model path for real functionality testing)
      this.binaryPath = await this.ensureBinary(modelInfo.path, config.forceValidation);

      // 4. Check if port is in use
      const port = config.port || DEFAULT_PORTS.diffusion;
      await this.checkPortAvailability(port);

      // 5. Initialize log manager
      await this.initializeLogManager(
        'diffusion-server.log',
        `Starting diffusion server on port ${port}`
      );

      // 6. Create HTTP server
      await this.createHTTPServer(config);

      this._port = port;
      this._startedAt = new Date();
      this.setStatus('running');

      await this.logManager!.write('Diffusion server is running', 'info');

      // Clear system info cache so subsequent memory checks use fresh data
      this.systemInfo.clearCache();

      this.emitEvent('started', this.getInfo());

      return this.getInfo() as DiffusionServerInfo;
    } catch (error) {
      throw await this.handleStartupError('diffusion-server', error, async () => {
        if (this.httpServer) {
          this.httpServer.close();
          this.httpServer = undefined;
        }
      });
    }
  }

  /**
   * Stop diffusion server
   *
   * Closes HTTP wrapper server and cancels any ongoing generation.
   *
   * @throws {ServerError} If stop fails
   */
  async stop(): Promise<void> {
    if (this._status === 'stopped') {
      return;
    }

    this.setStatus('stopping');

    try {
      if (this.logManager) {
        await this.logManager.write('Stopping diffusion server...', 'info');
      }

      // Cancel any ongoing generation
      if (this.currentGeneration) {
        this.currentGeneration.cancel();
        this.currentGeneration = undefined;
      }

      // Close HTTP server
      if (this.httpServer) {
        await new Promise<void>((resolve) => {
          this.httpServer!.close(() => resolve());
        });
        this.httpServer = undefined;
      }

      this.setStatus('stopped');
      this._port = 0;

      if (this.logManager) {
        await this.logManager.write('Diffusion server stopped', 'info');
      }

      // Clear system info cache so subsequent memory checks use fresh data
      this.systemInfo.clearCache();

      this.emitEvent('stopped');
    } catch (error) {
      this.setStatus('stopped');
      throw new ServerError(
        `Failed to stop server: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Generate an image
   *
   * Spawns stable-diffusion.cpp executable with the provided configuration.
   *
   * Note: Cancellation API (cancelImageGeneration) is deferred to Phase 3.
   * For Phase 2, once started, generation runs to completion or error.
   *
   * @param config - Image generation configuration
   * @returns Generated image result
   * @throws {ServerError} If server is not running or already busy
   */
  async generateImage(config: ImageGenerationConfig): Promise<ImageGenerationResult> {
    if (this._status !== 'running') {
      throw new ServerError('Server is not running', {
        suggestion: 'Start the server first with start()',
      });
    }

    if (this.currentGeneration) {
      throw new ServerError('Server is busy generating another image', {
        suggestion: 'Wait for current generation to complete',
      });
    }

    // Use orchestrator if available (automatic resource management)
    // Otherwise use direct execution (legacy behavior)
    console.log('[DiffusionServer] generateImage called');
    console.log('[DiffusionServer] orchestrator exists:', !!this.orchestrator);

    if (this.orchestrator) {
      console.log('[DiffusionServer] Using orchestrator for automatic resource management');
      return this.orchestrator.orchestrateImageGeneration(config);
    } else {
      console.log('[DiffusionServer] No orchestrator - using direct execution');
      return this.executeImageGeneration(config);
    }
  }

  /**
   * Check if server is healthy
   *
   * @returns True if server is running and HTTP server is available
   */
  async isHealthy(): Promise<boolean> {
    return this._status === 'running' && this.httpServer !== undefined;
  }

  /**
   * Get server information with diffusion-specific fields
   *
   * @returns Server information including busy status
   */
  override getInfo(): DiffusionServerInfo {
    const baseInfo = super.getInfo();
    return {
      ...baseInfo,
      busy: !!this.currentGeneration,
    } as DiffusionServerInfo;
  }

  /**
   * Ensure stable-diffusion.cpp binary is downloaded
   *
   * @param modelPath - Optional model path for real functionality testing
   * @param forceValidation - If true, re-run validation tests even if cached validation exists
   * @returns Path to the binary
   * @throws {BinaryError} If download or verification fails
   * @private
   */
  private async ensureBinary(modelPath?: string, forceValidation = false): Promise<string> {
    return this.ensureBinaryHelper('diffusion', 'sd', BINARY_VERSIONS.diffusionCpp, modelPath, forceValidation);
  }

  /**
   * Create HTTP server
   *
   * @param config - Server configuration
   * @private
   */
  private async createHTTPServer(config: DiffusionServerConfig): Promise<void> {
    const port = config.port || DEFAULT_PORTS.diffusion;

    this.httpServer = http.createServer(async (req, res) => {
      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      try {
        // Health endpoint
        if (req.url === '/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', busy: !!this.currentGeneration }));
          return;
        }

        // Image generation endpoint
        if (req.url === '/v1/images/generations' && req.method === 'POST') {
          // Parse request body
          const body = await this.parseRequestBody(req);
          const imageConfig: ImageGenerationConfig = JSON.parse(body);

          // Validate required fields
          if (!imageConfig.prompt) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required field: prompt' }));
            return;
          }

          // Generate image
          const result = await this.generateImage(imageConfig);

          // Return result
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              image: result.image.toString('base64'),
              format: result.format,
              timeTaken: result.timeTaken,
              seed: result.seed,
              width: result.width,
              height: result.height,
            })
          );
          return;
        }

        // Not found
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : 'Internal server error',
          })
        );
      }
    });

    // Start listening
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(port, () => resolve());
      this.httpServer!.on('error', reject);
    });

    await this.logManager?.write(`HTTP server listening on port ${port}`, 'info');
  }

  /**
   * Parse request body
   *
   * @param req - HTTP request
   * @returns Request body as string
   * @private
   */
  private parseRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  /**
   * Execute image generation by spawning stable-diffusion.cpp
   *
   * This is the direct execution method used internally and by ResourceOrchestrator.
   * External callers should use generateImage() which includes automatic resource management.
   *
   * @param config - Image generation configuration
   * @returns Generated image result
   * @internal
   */
  public async executeImageGeneration(
    config: ImageGenerationConfig
  ): Promise<ImageGenerationResult> {
    const startTime = Date.now();

    if (!this.currentModelInfo) {
      throw new ServerError('Model information not available', {
        suggestion: 'This is an internal error - model should have been loaded',
      });
    }

    // Initialize progress tracking
    this.initializeProgressTracking(config);

    // Build command-line arguments
    const args = this.buildDiffusionArgs(config, this.currentModelInfo);

    // Output file path
    const outputPath = getTempPath(`sd-output-${Date.now()}.png`);
    args.push('-o', outputPath);

    await this.logManager?.write(`Generating image: ${this.binaryPath} ${args.join(' ')}`, 'info');

    // Spawn stable-diffusion.cpp
    let cancelled = false;
    let pid: number | undefined;

    const generationPromise = new Promise<ImageGenerationResult>((resolve, reject) => {
      const spawnResult = this.processManager.spawn(this.binaryPath!, args, {
        onStdout: (data) => {
          this.processStdoutForProgress(data, config);
          this.logManager?.write(data, 'info').catch(() => void 0);
        },
        onStderr: (data) => {
          this.logManager?.write(data, 'warn').catch(() => void 0);
        },
        onExit: async (code) => {
          // Clean up synthetic progress interval
          this.cleanupSyntheticProgress();

          if (cancelled) {
            reject(new Error('Image generation cancelled'));
            return;
          }

          if (code !== 0) {
            reject(new ServerError(`stable-diffusion.cpp exited with code ${code}`));
            return;
          }

          // Read generated image
          try {
            const imageBuffer = await fs.readFile(outputPath);
            await deleteFile(outputPath).catch(() => void 0);

            // Update time estimates based on actual generation times
            this.updateTimeEstimates(config);

            resolve({
              image: imageBuffer,
              format: 'png',
              timeTaken: Date.now() - startTime,
              seed: config.seed || -1,
              width: config.width || 512,
              height: config.height || 512,
            });
          } catch (error) {
            reject(
              new ServerError('Failed to read generated image', {
                error: error instanceof Error ? error.message : String(error),
              })
            );
          }
        },
        onError: (error) => {
          this.cleanupSyntheticProgress();
          reject(
            new ServerError('Failed to spawn stable-diffusion.cpp', {
              error: error.message,
            })
          );
        },
      });
      pid = spawnResult.pid;
    });

    // Store cancellation function AFTER promise is created
    this.currentGeneration = {
      promise: generationPromise,
      cancel: () => {
        cancelled = true;
        this.cleanupSyntheticProgress();
        if (pid !== undefined) {
          this.processManager.kill(pid, 5000).catch(() => void 0);
        }
      },
    };

    try {
      const result = await generationPromise;
      this.currentGeneration = undefined;
      return result;
    } catch (error) {
      this.currentGeneration = undefined;
      throw error;
    }
  }

  /**
   * Build command-line arguments for stable-diffusion.cpp
   *
   * @param config - Image generation configuration
   * @param modelInfo - Model information
   * @returns Array of command-line arguments
   * @private
   */
  private buildDiffusionArgs(config: ImageGenerationConfig, modelInfo: ModelInfo): string[] {
    const args: string[] = [];

    // Model path
    args.push('-m', modelInfo.path);

    // Prompt (required)
    if (config.prompt) {
      args.push('-p', config.prompt);
    }

    // Negative prompt (optional)
    if (config.negativePrompt) {
      args.push('-n', config.negativePrompt);
    }

    // Image dimensions
    if (config.width) {
      args.push('-W', String(config.width));
    }
    if (config.height) {
      args.push('-H', String(config.height));
    }

    // Steps
    if (config.steps) {
      args.push('--steps', String(config.steps));
    }

    // CFG scale
    if (config.cfgScale) {
      args.push('--cfg-scale', String(config.cfgScale));
    }

    // Seed
    if (config.seed !== undefined && config.seed !== -1) {
      args.push('-s', String(config.seed));
    }

    // Sampler
    if (config.sampler) {
      args.push('--sampling-method', config.sampler);
    }

    // GPU layers (if configured)
    const serverConfig = this._config as DiffusionServerConfig;
    if (serverConfig.gpuLayers !== undefined && serverConfig.gpuLayers > 0) {
      args.push('--n-gpu-layers', String(serverConfig.gpuLayers));
    }

    // Threads
    if (serverConfig.threads) {
      args.push('-t', String(serverConfig.threads));
    }

    return args;
  }

  /**
   * Initialize progress tracking for a new generation
   * @private
   */
  private initializeProgressTracking(config: ImageGenerationConfig): void {
    const width = config.width || 512;
    const height = config.height || 512;
    const steps = config.steps || 20;
    const megapixels = (width * height) / 1_000_000;

    // Calculate total estimated time
    this.totalEstimatedTime =
      this.modelLoadTime +
      steps * megapixels * this.diffusionTimePerStepPerMegapixel +
      megapixels * this.vaeTimePerMegapixel;

    // Reset tracking variables
    this.generationStartTime = Date.now();
    this.currentStage = undefined;
    this.loadStartTime = undefined;
    this.loadEndTime = undefined;
    this.diffusionStartTime = undefined;
    this.diffusionEndTime = undefined;
    this.vaeStartTime = undefined;
    this.vaeEndTime = undefined;
    this.loadProgress = { current: 0, total: 0 };
    this.diffusionProgress = { current: 0, total: 0 };
  }

  /**
   * Process stdout data for progress tracking
   * @private
   */
  private processStdoutForProgress(data: string, config: ImageGenerationConfig): void {
    // Detect stage transitions
    if (data.includes('loading tensors from')) {
      this.currentStage = 'loading';
      this.loadStartTime = Date.now();
    } else if (data.includes('generating image:') || data.includes('sampling using')) {
      if (this.currentStage === 'loading') {
        this.loadEndTime = Date.now();
      }
      this.currentStage = 'diffusion';
      this.diffusionStartTime = Date.now();
    } else if (data.includes('decoding 1 latents')) {
      if (this.currentStage === 'diffusion') {
        this.diffusionEndTime = Date.now();
      }
      this.currentStage = 'vae';
      this.vaeStartTime = Date.now();
      // Start synthetic progress for VAE stage
      this.startSyntheticVaeProgress(config);
    } else if (data.includes('decode_first_stage completed')) {
      this.vaeEndTime = Date.now();
      this.cleanupSyntheticProgress();
      // Report 100% completion with decoding stage
      if (config.onProgress) {
        config.onProgress(0, 0, 'decoding', 100);
      }
    }

    // Parse progress bar: "| X/Y -"
    const progressMatch = data.match(/\|\s*(\d+)\/(\d+)\s*-/);
    if (progressMatch && progressMatch[1] && progressMatch[2]) {
      const current = parseInt(progressMatch[1], 10);
      const total = parseInt(progressMatch[2], 10);

      if (this.currentStage === 'loading') {
        this.loadProgress = { current, total };
        this.reportProgress(config);
      } else if (this.currentStage === 'diffusion') {
        this.diffusionProgress = { current, total };
        this.reportProgress(config);
      }
    }
  }

  /**
   * Report current progress based on all stage timings
   * @private
   */
  private reportProgress(config: ImageGenerationConfig): void {
    if (!config.onProgress || !this.generationStartTime) return;

    // Calculate overall percentage
    const percentage = this.calculateOverallPercentage();

    // Report progress based on current stage with stage information
    if (this.currentStage === 'loading' && this.loadProgress.total > 0) {
      // For loading: use actual progress bar values with loading stage
      config.onProgress(
        this.loadProgress.current,
        this.loadProgress.total,
        'loading',
        percentage
      );
    } else if (this.currentStage === 'diffusion' && this.diffusionProgress.total > 0) {
      // For diffusion: use actual step count with diffusion stage
      config.onProgress(
        this.diffusionProgress.current,
        this.diffusionProgress.total,
        'diffusion',
        percentage
      );
    } else if (this.currentStage === 'vae') {
      // For VAE: no step count, just percentage with decoding stage
      config.onProgress(0, 0, 'decoding', percentage);
    }
  }

  /**
   * Calculate overall progress percentage
   * @private
   */
  private calculateOverallPercentage(): number {
    if (!this.generationStartTime || this.totalEstimatedTime === 0) return 0;

    let elapsedTotal = 0;

    // Loading stage
    if (this.currentStage === 'loading') {
      const elapsedLoad = Date.now() - (this.loadStartTime || this.generationStartTime);
      elapsedTotal = elapsedLoad;
    }
    // Diffusion stage
    else if (this.currentStage === 'diffusion') {
      const actualLoadTime = this.loadEndTime
        ? this.loadEndTime - (this.loadStartTime || this.generationStartTime)
        : this.modelLoadTime;
      const elapsedDiffusion = Date.now() - (this.diffusionStartTime || Date.now());
      elapsedTotal = actualLoadTime + elapsedDiffusion;
    }
    // VAE stage
    else if (this.currentStage === 'vae') {
      const actualLoadTime = this.loadEndTime
        ? this.loadEndTime - (this.loadStartTime || this.generationStartTime)
        : this.modelLoadTime;
      const actualDiffusionTime = this.diffusionEndTime
        ? this.diffusionEndTime - (this.diffusionStartTime || Date.now())
        : 0;
      const elapsedVae = Date.now() - (this.vaeStartTime || Date.now());
      elapsedTotal = actualLoadTime + actualDiffusionTime + elapsedVae;
    }

    return Math.min(100, Math.round((elapsedTotal / this.totalEstimatedTime) * 100));
  }

  /**
   * Start synthetic progress updates for VAE stage
   * @private
   */
  private startSyntheticVaeProgress(config: ImageGenerationConfig): void {
    if (!config.onProgress) return;

    // Clean up any existing interval
    this.cleanupSyntheticProgress();

    // Update progress every 100ms
    this.syntheticProgressInterval = setInterval(() => {
      // Calculate overall percentage
      const percentage = this.calculateOverallPercentage();

      // Report VAE decoding progress with stage information
      config.onProgress!(0, 0, 'decoding', percentage);
    }, 100);
  }

  /**
   * Clean up synthetic progress interval
   * @private
   */
  private cleanupSyntheticProgress(): void {
    if (this.syntheticProgressInterval) {
      clearInterval(this.syntheticProgressInterval);
      this.syntheticProgressInterval = undefined;
    }
  }

  /**
   * Update time estimates based on actual generation times
   * @private
   */
  private updateTimeEstimates(config: ImageGenerationConfig): void {
    const width = config.width || 512;
    const height = config.height || 512;
    const steps = config.steps || 20;
    const megapixels = (width * height) / 1_000_000;

    // Update model load time (fixed cost)
    if (this.loadStartTime && this.loadEndTime) {
      const actualLoadTime = this.loadEndTime - this.loadStartTime;
      this.modelLoadTime = actualLoadTime;
    }

    // Update diffusion time per step per megapixel
    if (this.diffusionStartTime && this.diffusionEndTime) {
      const actualDiffusionTime = this.diffusionEndTime - this.diffusionStartTime;
      this.diffusionTimePerStepPerMegapixel = actualDiffusionTime / (steps * megapixels);
    }

    // Update VAE time per megapixel
    if (this.vaeStartTime && this.vaeEndTime) {
      const actualVaeTime = this.vaeEndTime - this.vaeStartTime;
      this.vaeTimePerMegapixel = actualVaeTime / megapixels;
    }
  }
}
