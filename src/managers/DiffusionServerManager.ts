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
import { GenerationRegistry } from './GenerationRegistry.js';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { getTempPath, PATHS } from '../config/paths.js';
import {
  BINARY_VERSIONS,
  DEFAULT_PORTS,
  DIFFUSION_VRAM_THRESHOLDS,
  DIFFUSION_COMPONENT_FLAGS,
  DIFFUSION_COMPONENT_ORDER,
} from '../config/defaults.js';
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
  /** Fields accepted by DiffusionServerManager.start() (DiffusionServerConfig) */
  private static readonly VALID_CONFIG_FIELDS: ReadonlySet<string> = new Set([
    'modelId',
    'port',
    'threads',
    'gpuLayers',
    'forceValidation',
    'clipOnCpu',
    'vaeOnCpu',
    'batchSize',
    'offloadToCpu',
    'diffusionFlashAttention',
  ]);

  private processManager: ProcessManager;
  private modelManager: ModelManager;
  private systemInfo: SystemInfo;
  private orchestrator?: ResourceOrchestrator;
  private registry: GenerationRegistry;
  private binaryPath?: string;
  private httpServer?: http.Server;
  private currentGeneration?: {
    promise: Promise<ImageGenerationResult>;
    cancel: () => void;
  };
  private currentModelInfo?: ModelInfo;

  // Time estimates for progress calculation (self-calibrating)
  private modelLoadTime = 2000; // Fixed cost in ms
  private diffusionTimePerStepPerMegapixel = 1000; // Time per step per megapixel in ms
  private vaeTimePerMegapixel = 8000; // Time per megapixel in ms

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

    // Initialize generation registry for async API
    this.registry = new GenerationRegistry({
      maxResultAgeMs: parseInt(process.env.IMAGE_RESULT_TTL_MS || '300000', 10), // 5 minutes default
      cleanupIntervalMs: parseInt(process.env.IMAGE_CLEANUP_INTERVAL_MS || '60000', 10), // 1 minute default
    });

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

    // Validate config fields before proceeding
    this.validateConfigFields(
      config as unknown as Record<string, unknown>,
      DiffusionServerManager.VALID_CONFIG_FIELDS,
      'DiffusionServerManager'
    );

    this.setStatus('starting');
    // DiffusionServerConfig has optional port (resolved later), so cast via unknown
    this._config = config as unknown as typeof this._config;

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

      // 3. Ensure binary is downloaded (pass model info for real functionality testing)
      this.binaryPath = await this.ensureBinary(modelInfo, config.forceValidation);

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

      if (this.logManager) {
        await this.logManager.write('Diffusion server is running', 'info');
      }

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
          this.httpServer?.close(() => resolve());
        });
        this.httpServer = undefined;
      }

      // Cleanup registry
      this.registry.destroy();

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

    if (this.orchestrator) {
      return this.orchestrator.orchestrateImageGeneration(config);
    } else {
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
   * @param modelInfo - Optional model info for real functionality testing (Phase 2)
   * @param forceValidation - If true, re-run validation tests even if cached validation exists
   * @returns Path to the binary
   * @throws {BinaryError} If download or verification fails
   * @private
   */
  private async ensureBinary(modelInfo?: ModelInfo, forceValidation = false): Promise<string> {
    // Build the correct test model args based on single-file vs multi-component
    let testModelArgs: string[] | undefined;
    if (modelInfo?.components) {
      testModelArgs = [];
      for (const role of DIFFUSION_COMPONENT_ORDER) {
        const component = modelInfo.components[role];
        if (component) {
          testModelArgs.push(DIFFUSION_COMPONENT_FLAGS[role], component.path);
        }
      }
    }

    return this.ensureBinaryHelper(
      'diffusion',
      'sd-cli',
      BINARY_VERSIONS.diffusionCpp,
      modelInfo?.path,
      forceValidation,
      testModelArgs
    );
  }

  /**
   * Create HTTP server with async generation endpoints
   *
   * @param config - Server configuration
   * @private
   */
  private async createHTTPServer(config: DiffusionServerConfig): Promise<void> {
    const port = config.port || DEFAULT_PORTS.diffusion;

    this.httpServer = http.createServer(async (req, res) => {
      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
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

        // Start async image generation (POST /v1/images/generations)
        if (req.url === '/v1/images/generations' && req.method === 'POST') {
          await this.handleStartGeneration(req, res);
          return;
        }

        // Get generation status/result (GET /v1/images/generations/:id)
        const getMatch = req.url?.match(/^\/v1\/images\/generations\/([^/]+)$/);
        if (getMatch && getMatch[1] && req.method === 'GET') {
          const generationId = getMatch[1];
          await this.handleGetGeneration(generationId, res);
          return;
        }

        // Not found
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Not found', code: 'NOT_FOUND' } }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : 'Internal server error',
              code: 'INTERNAL_ERROR',
            },
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
   * Handle POST /v1/images/generations - Start async generation
   * @private
   */
  private async handleStartGeneration(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Parse request body
    const body = await this.parseRequestBody(req);
    const imageConfig: ImageGenerationConfig = JSON.parse(body);

    // Validate required fields
    if (!imageConfig.prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'Missing required field: prompt', code: 'INVALID_REQUEST' },
        })
      );
      return;
    }

    // Validate count parameter
    if (imageConfig.count !== undefined) {
      if (imageConfig.count < 1 || imageConfig.count > 5) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'count must be between 1 and 5', code: 'INVALID_REQUEST' },
          })
        );
        return;
      }
    }

    // Check if server is busy
    if (this.currentGeneration) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: 'Server is busy generating another image',
            code: 'SERVER_BUSY',
            suggestion: 'Wait for current generation to complete and try again',
          },
        })
      );
      return;
    }

    // Create generation entry in registry
    const id = this.registry.create(imageConfig);

    // Start generation asynchronously (don't await)
    this.runAsyncGeneration(id, imageConfig).catch((error) => {
      this.registry.update(id, {
        status: 'error',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: this.mapErrorCode(error),
        },
      });
    });

    // Return generation ID immediately
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        status: 'pending',
        createdAt: Date.now(),
      })
    );
  }

  /**
   * Handle GET /v1/images/generations/:id - Get generation status/result
   * @private
   */
  private async handleGetGeneration(id: string, res: http.ServerResponse): Promise<void> {
    const state = this.registry.get(id);

    if (!state) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Generation not found', code: 'NOT_FOUND' } }));
      return;
    }

    // Build response based on status
    const response: any = {
      id: state.id,
      status: state.status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };

    if (state.status === 'in_progress' && state.progress) {
      response.progress = state.progress;
    }

    if (state.status === 'complete' && state.result) {
      response.result = state.result;
    }

    if (state.status === 'error' && state.error) {
      response.error = state.error;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  /**
   * Run async generation and update registry
   * @private
   */
  private async runAsyncGeneration(id: string, config: ImageGenerationConfig): Promise<void> {
    const startTime = Date.now();

    // Update to in_progress
    this.registry.update(id, { status: 'in_progress' });

    // Wrap onProgress to update registry
    const wrappedConfig: ImageGenerationConfig = {
      ...config,
      onProgress: (currentStep, totalSteps, stage, percentage) => {
        this.registry.update(id, {
          progress: {
            currentStep,
            totalSteps,
            stage,
            percentage,
            currentImage:
              config.count && config.count > 1
                ? Math.floor((percentage || 0) / (100 / config.count)) + 1
                : undefined,
            totalImages: config.count && config.count > 1 ? config.count : undefined,
          },
        });
        // Also call original callback if provided
        config.onProgress?.(currentStep, totalSteps, stage, percentage);
      },
    };

    // Generate images (batch or single, with orchestration if available)
    const count = config.count || 1;
    let results: ImageGenerationResult[];

    if (count > 1) {
      // Batch generation (orchestration not yet supported for batch)
      results = await this.executeBatchGeneration(wrappedConfig);
    } else {
      // Single image: use orchestrator if available (same logic as public generateImage method)
      if (this.orchestrator) {
        results = [await this.orchestrator.orchestrateImageGeneration(wrappedConfig)];
      } else {
        results = [await this.executeImageGeneration(wrappedConfig)];
      }
    }

    // Convert results to base64 for JSON response
    const images = results.map((result) => ({
      image: result.image.toString('base64'),
      seed: result.seed,
      width: result.width,
      height: result.height,
    }));

    // Update registry with complete result
    this.registry.update(id, {
      status: 'complete',
      result: {
        images,
        format: 'png',
        timeTaken: Date.now() - startTime,
      },
    });
  }

  /**
   * Map error to error code
   * @private
   */
  private mapErrorCode(error: unknown): string {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (message.includes('server is busy')) return 'SERVER_BUSY';
      if (message.includes('not running')) return 'SERVER_NOT_RUNNING';
      if (message.includes('failed to spawn')) return 'BACKEND_ERROR';
      if (message.includes('exited with code')) return 'BACKEND_ERROR';
      if (message.includes('failed to read')) return 'IO_ERROR';
    }
    return 'UNKNOWN_ERROR';
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

    // Normalize seed: generate random seed if not provided or negative
    const normalizedConfig = {
      ...config,
      seed: config.seed === undefined || config.seed < 0 ? this.generateRandomSeed() : config.seed,
    };

    // Initialize progress tracking
    this.initializeProgressTracking(normalizedConfig);

    // Compute VRAM optimizations (fresh GPU info, respects user overrides)
    const optimizations = await this.computeDiffusionOptimizations();

    // Build command-line arguments
    const args = this.buildDiffusionArgs(normalizedConfig, this.currentModelInfo, optimizations);

    // Output file path
    const outputPath = getTempPath(`sd-output-${Date.now()}.png`);
    args.push('-o', outputPath);

    await this.logManager?.write(`Generating image: ${this.binaryPath} ${args.join(' ')}`, 'info');
    await this.logManager?.write(
      `Model info: id=${this.currentModelInfo.id}, components=${this.currentModelInfo.components ? Object.keys(this.currentModelInfo.components).join(',') : 'none'}, path=${this.currentModelInfo.path}`,
      'info'
    );

    // Spawn stable-diffusion.cpp
    let cancelled = false;
    let pid: number | undefined;
    const stderrLines: string[] = [];
    const MAX_STDERR_LINES = 20;

    const generationPromise = new Promise<ImageGenerationResult>((resolve, reject) => {
      const spawnResult = this.processManager.spawn(this.binaryPath!, args, {
        onStdout: (data) => {
          this.processStdoutForProgress(data, normalizedConfig);
          this.logManager?.write(data, 'info').catch(() => void 0);
        },
        onStderr: (data) => {
          this.logManager?.write(data, 'warn').catch(() => void 0);
          // Accumulate stderr for error diagnostics (sliding window of last N lines)
          const lines = data.split('\n').filter((line: string) => line.trim() !== '');
          for (const line of lines) {
            stderrLines.push(line);
          }
          if (stderrLines.length > MAX_STDERR_LINES) {
            stderrLines.splice(0, stderrLines.length - MAX_STDERR_LINES);
          }
        },
        onExit: async (code) => {
          // Clean up synthetic progress interval
          this.cleanupSyntheticProgress();

          if (cancelled) {
            reject(new Error('Image generation cancelled'));
            return;
          }

          if (code !== 0) {
            const stderrOutput = stderrLines.length > 0 ? stderrLines.join('\n') : '';
            const argsStr = args.join(' ');
            reject(
              new ServerError(
                `stable-diffusion.cpp exited with code ${code}${stderrOutput ? `\n${stderrOutput}` : ''}\nArgs: ${argsStr}`,
                {
                  exitCode: code,
                  stderr: stderrOutput || undefined,
                  args: argsStr,
                }
              )
            );
            return;
          }

          // Read generated image
          try {
            const imageBuffer = await fs.readFile(outputPath);
            await deleteFile(outputPath).catch(() => void 0);

            // Update time estimates based on actual generation times
            this.updateTimeEstimates(normalizedConfig);

            resolve({
              image: imageBuffer,
              format: 'png',
              timeTaken: Date.now() - startTime,
              seed: normalizedConfig.seed,
              width: normalizedConfig.width || 512,
              height: normalizedConfig.height || 512,
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
   * Execute batch image generation (multiple images sequentially)
   *
   * Generates multiple images by calling executeImageGeneration in a loop.
   * Updates progress to reflect overall batch progress.
   *
   * @param config - Image generation configuration with count parameter
   * @returns Array of generated image results
   * @internal
   */
  public async executeBatchGeneration(
    config: ImageGenerationConfig
  ): Promise<ImageGenerationResult[]> {
    const count = config.count || 1;
    const images: ImageGenerationResult[] = [];

    for (let i = 0; i < count; i++) {
      // Calculate seed for this image
      // If user provided a non-negative seed, use seed+i for variations
      // Otherwise, generate a fresh random seed for each image
      const imageSeed =
        config.seed !== undefined && config.seed >= 0 ? config.seed + i : this.generateRandomSeed();

      // Wrap progress callback to include batch information
      const wrappedConfig: ImageGenerationConfig = {
        ...config,
        seed: imageSeed,
        onProgress: config.onProgress
          ? (currentStep, totalSteps, stage, percentage) => {
              // Calculate overall batch percentage
              const completedImages = i;
              const currentImageProgress = (percentage || 0) / 100;
              const overallPercentage = ((completedImages + currentImageProgress) / count) * 100;

              // Call original progress callback with batch information
              config.onProgress!(currentStep, totalSteps, stage, overallPercentage);
            }
          : undefined,
      };

      // Generate single image
      const result = await this.executeImageGeneration(wrappedConfig);
      images.push(result);
    }

    return images;
  }

  /**
   * Compute VRAM optimization flags based on current GPU state and model size.
   *
   * Called at generation time (not start time) so headroom reflects the current
   * VRAM landscape — the orchestrator may have offloaded the LLM between start()
   * and generation.
   *
   * User-provided overrides in DiffusionServerConfig always win via nullish coalescing.
   *
   * @returns Resolved optimization flags: clipOnCpu, vaeOnCpu, batchSize
   * @private
   */
  private async computeDiffusionOptimizations(): Promise<{
    clipOnCpu: boolean;
    vaeOnCpu: boolean;
    offloadToCpu: boolean;
    diffusionFlashAttention: boolean;
    batchSize?: number;
  }> {
    const serverConfig = this._config as DiffusionServerConfig;
    const modelSize = this.currentModelInfo?.size ?? 0;
    const modelFootprint = modelSize * DIFFUSION_VRAM_THRESHOLDS.modelOverheadMultiplier;

    let autoClipOnCpu = false;
    let autoVaeOnCpu = false;
    let autoOffloadToCpu = false;

    try {
      const gpu = await this.systemInfo.getGPUInfo();

      if (!gpu.available || gpu.vram === undefined) {
        // No GPU or no VRAM info — safe default: clip on CPU, VAE stays on GPU
        autoClipOnCpu = true;
        autoVaeOnCpu = false;
        autoOffloadToCpu = false;
      } else {
        const headroom = gpu.vram - modelFootprint;

        autoClipOnCpu = headroom < DIFFUSION_VRAM_THRESHOLDS.clipOnCpuHeadroomBytes;
        autoVaeOnCpu = headroom < DIFFUSION_VRAM_THRESHOLDS.vaeOnCpuHeadroomBytes;

        // Auto-enable offload-to-cpu when model footprint > 85% of VRAM
        // (disabled for CUDA backend — --offload-to-cpu crashes sd.cpp CUDA builds)
        autoOffloadToCpu = modelFootprint > gpu.vram * 0.85;
        if (autoOffloadToCpu) {
          const isCuda = await this.isInstalledVariantCuda();
          if (isCuda) {
            autoOffloadToCpu = false;
          }
        }

        // Escalation: if vramAvailable is known and critically low, force clip-on-cpu
        if (gpu.vramAvailable !== undefined && gpu.vramAvailable - modelFootprint < 2 * 1024 ** 3) {
          autoClipOnCpu = true;
        }
      }
    } catch {
      // GPU detection failed — use safe defaults
      autoClipOnCpu = true;
      autoVaeOnCpu = false;
      autoOffloadToCpu = false;
    }

    // Auto-enable diffusion flash attention when model has an 'llm' component (Flux 2)
    const hasLLMComponent = !!this.currentModelInfo?.components?.llm;
    const autoDiffusionFlashAttention = hasLLMComponent;

    const clipOnCpu = serverConfig.clipOnCpu ?? autoClipOnCpu;
    const vaeOnCpu = serverConfig.vaeOnCpu ?? autoVaeOnCpu;
    const offloadToCpu = serverConfig.offloadToCpu ?? autoOffloadToCpu;
    const diffusionFlashAttention =
      serverConfig.diffusionFlashAttention ?? autoDiffusionFlashAttention;
    const batchSize = serverConfig.batchSize;

    await this.logManager?.write(
      `VRAM optimizations: clipOnCpu=${clipOnCpu}, vaeOnCpu=${vaeOnCpu}, offloadToCpu=${offloadToCpu}, diffusionFa=${diffusionFlashAttention}${batchSize !== undefined ? `, batchSize=${batchSize}` : ''} (auto: clip=${autoClipOnCpu}, vae=${autoVaeOnCpu}, offload=${autoOffloadToCpu}, fa=${autoDiffusionFlashAttention})`,
      'info'
    );

    return { clipOnCpu, vaeOnCpu, offloadToCpu, diffusionFlashAttention, batchSize };
  }

  /**
   * Check if the installed diffusion binary is the CUDA variant.
   * Reads the variant cache written by BinaryManager after variant selection.
   * @returns true if the installed variant is CUDA
   * @private
   */
  private async isInstalledVariantCuda(): Promise<boolean> {
    try {
      const variantCachePath = `${PATHS.binaries.diffusion}/.variant.json`;
      const content = await fs.readFile(variantCachePath, 'utf-8');
      const cache = JSON.parse(content);
      return cache.variant === 'cuda';
    } catch {
      return false; // No cache or unreadable — assume not CUDA
    }
  }

  /**
   * Build command-line arguments for stable-diffusion.cpp
   *
   * @param config - Image generation configuration
   * @param modelInfo - Model information
   * @param optimizations - Resolved VRAM optimization flags
   * @returns Array of command-line arguments
   * @private
   */
  private buildDiffusionArgs(
    config: ImageGenerationConfig,
    modelInfo: ModelInfo,
    optimizations?: {
      clipOnCpu: boolean;
      vaeOnCpu: boolean;
      offloadToCpu: boolean;
      diffusionFlashAttention: boolean;
      batchSize?: number;
    }
  ): string[] {
    const args: string[] = [];

    // Model path(s) — multi-component or single-file
    if (modelInfo.components) {
      // Validate that the components map includes the primary diffusion_model
      if (!modelInfo.components.diffusion_model) {
        throw new ServerError(
          'Multi-component model is missing required diffusion_model component',
          {
            modelId: modelInfo.id,
            components: Object.keys(modelInfo.components),
            suggestion: 'The model metadata appears corrupted. Try re-downloading the model.',
          }
        );
      }
      for (const role of DIFFUSION_COMPONENT_ORDER) {
        const component = modelInfo.components[role];
        if (component) {
          args.push(DIFFUSION_COMPONENT_FLAGS[role], component.path);
        }
      }
    } else {
      args.push('-m', modelInfo.path);
    }

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

    // Seed (always present after normalization in executeImageGeneration)
    if (config.seed !== undefined) {
      args.push('-s', String(config.seed));
    }

    // Sampler
    if (config.sampler) {
      args.push('--sampling-method', config.sampler);
    }

    // Note: gpuLayers is accepted in DiffusionServerConfig but stable-diffusion.cpp
    // does not have a --n-gpu-layers flag (that's llama.cpp). GPU offload in sd.cpp
    // is automatic when built with CUDA/Metal support. The field is kept in the config
    // for future use and for consistency with the ServerConfig pattern.

    // Threads
    const serverConfig = this._config as DiffusionServerConfig;
    if (serverConfig.threads) {
      args.push('-t', String(serverConfig.threads));
    }

    // VRAM optimization flags
    if (optimizations) {
      if (optimizations.clipOnCpu) {
        args.push('--clip-on-cpu');
      }
      if (optimizations.vaeOnCpu) {
        args.push('--vae-on-cpu');
      }
      if (optimizations.offloadToCpu) {
        args.push('--offload-to-cpu');
      }
      if (optimizations.diffusionFlashAttention) {
        args.push('--diffusion-fa');
      }
      if (optimizations.batchSize !== undefined) {
        args.push('-b', String(optimizations.batchSize));
      }
    }

    return args;
  }

  /**
   * Generate a random non-negative seed for image generation
   * @returns Random non-negative integer seed (0 to 2147483646)
   * @private
   */
  private generateRandomSeed(): number {
    // Generate random non-negative 32-bit integer
    return Math.floor(Math.random() * 2147483647);
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
   * Recalculate totalEstimatedTime using actual durations for completed stages
   * and estimated durations for remaining stages. Called at stage transitions
   * to keep the denominator aligned with the numerator in calculateOverallPercentage().
   * @private
   */
  private recalculateTotalEstimatedTime(config: ImageGenerationConfig): void {
    const width = config.width || 512;
    const height = config.height || 512;
    const steps = config.steps || 20;
    const megapixels = (width * height) / 1_000_000;

    const loadTime =
      this.loadStartTime && this.loadEndTime
        ? this.loadEndTime - this.loadStartTime
        : this.modelLoadTime;

    const diffusionTime =
      this.diffusionStartTime && this.diffusionEndTime
        ? this.diffusionEndTime - this.diffusionStartTime
        : steps * megapixels * this.diffusionTimePerStepPerMegapixel;

    const vaeTime =
      this.vaeStartTime && this.vaeEndTime
        ? this.vaeEndTime - this.vaeStartTime
        : megapixels * this.vaeTimePerMegapixel;

    this.totalEstimatedTime = loadTime + diffusionTime + vaeTime;
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
      this.reportProgress(config);
    } else if (data.includes('generating image:') || data.includes('sampling using')) {
      if (this.currentStage === 'loading') {
        this.loadEndTime = Date.now();
      }
      this.currentStage = 'diffusion';
      this.diffusionStartTime = Date.now();
      this.recalculateTotalEstimatedTime(config);
      this.reportProgress(config);
    } else if (data.includes('decoding 1 latents')) {
      if (this.currentStage === 'diffusion') {
        this.diffusionEndTime = Date.now();
      }
      this.currentStage = 'vae';
      this.vaeStartTime = Date.now();
      this.recalculateTotalEstimatedTime(config);
      this.reportProgress(config);
      // Start synthetic progress for VAE stage
      this.startSyntheticVaeProgress(config);
    } else if (data.includes('decode_first_stage completed')) {
      this.vaeEndTime = Date.now();
      this.recalculateTotalEstimatedTime(config);
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
      } else if (this.currentStage === undefined) {
        // If stage not set yet but we're seeing progress bars, assume it's loading
        // This handles the case where progress bars arrive before stage detection
        this.currentStage = 'loading';
        this.loadStartTime = Date.now();
        this.loadProgress = { current, total };
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
    if (this.currentStage === 'loading') {
      config.onProgress(this.loadProgress.current, this.loadProgress.total, 'loading', percentage);
    } else if (this.currentStage === 'diffusion') {
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

    // Prevent synthetic interval from keeping the event loop alive
    if (
      this.syntheticProgressInterval &&
      typeof this.syntheticProgressInterval.unref === 'function'
    ) {
      this.syntheticProgressInterval.unref();
    }
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
    if (megapixels === 0 || steps === 0) return;

    // Compute actual times for stages with both start+end markers
    const hasLoad = !!(this.loadStartTime && this.loadEndTime);
    const hasDiffusion = !!(this.diffusionStartTime && this.diffusionEndTime);
    const hasVae = !!(this.vaeStartTime && this.vaeEndTime);

    const actualLoadTime = hasLoad ? this.loadEndTime! - this.loadStartTime! : undefined;
    const actualDiffusionTime = hasDiffusion
      ? this.diffusionEndTime! - this.diffusionStartTime!
      : undefined;
    const actualVaeTime = hasVae ? this.vaeEndTime! - this.vaeStartTime! : undefined;

    // Direct calibration for stages with known times
    if (actualLoadTime !== undefined) {
      this.modelLoadTime = actualLoadTime;
    }
    if (actualDiffusionTime !== undefined) {
      this.diffusionTimePerStepPerMegapixel = actualDiffusionTime / (steps * megapixels);
    }
    if (actualVaeTime !== undefined) {
      this.vaeTimePerMegapixel = actualVaeTime / megapixels;
    }

    // Inference: if exactly one stage is missing, infer from total wall-clock time
    const knownCount = (hasLoad ? 1 : 0) + (hasDiffusion ? 1 : 0) + (hasVae ? 1 : 0);
    if (knownCount !== 2 || !this.generationStartTime) return;

    const totalActualTime = Date.now() - this.generationStartTime;
    const knownSum = (actualLoadTime || 0) + (actualDiffusionTime || 0) + (actualVaeTime || 0);

    // Subtract inter-stage gaps (overhead not belonging to any stage)
    let gaps = 0;
    if (this.loadStartTime && this.generationStartTime) {
      gaps += this.loadStartTime - this.generationStartTime;
    }
    if (this.loadEndTime && this.diffusionStartTime) {
      gaps += this.diffusionStartTime - this.loadEndTime;
    }
    if (this.diffusionEndTime && this.vaeStartTime) {
      gaps += this.vaeStartTime - this.diffusionEndTime;
    }

    const inferredTime = Math.max(0, totalActualTime - knownSum - gaps);

    if (!hasLoad) {
      this.modelLoadTime = inferredTime;
    } else if (!hasDiffusion) {
      this.diffusionTimePerStepPerMegapixel = inferredTime / (steps * megapixels);
    } else if (!hasVae) {
      this.vaeTimePerMegapixel = inferredTime / megapixels;
    }
  }
}
