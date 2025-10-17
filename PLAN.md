# Implementation Plan: Phase 2 - Image Generation

> **Status**: Ready for Implementation
> **Created**: 2025-10-17
> **Phase**: 2 - Image Generation Support
> **Prerequisites**: Phase 1 MVP Complete ✅

---

## Table of Contents

1. [Overview](#overview)
2. [Phase 2 Goals](#phase-2-goals)
3. [Architecture Overview](#architecture-overview)
4. [Implementation Steps](#implementation-steps)
5. [Testing Strategy](#testing-strategy)
6. [Documentation Updates](#documentation-updates)
7. [Timeline & Success Criteria](#timeline--success-criteria)
8. [Appendix](#appendix)

---

## Overview

### What is Phase 2?

Phase 2 adds **image generation capabilities** to genai-electron by integrating stable-diffusion.cpp. This enables Electron applications to generate images locally using GGUF diffusion models, complementing the existing LLM support from Phase 1.

### Key Differences from Phase 1

**Phase 1 (LLM)**: llama-server is a native HTTP server from llama.cpp. We spawn it and connect to its HTTP API.

**Phase 2 (Image Generation)**: stable-diffusion.cpp is a **one-shot executable** (not a server). It generates an image and exits. We need to create an **HTTP wrapper server** that:
1. Starts an HTTP server on a port (like llama-server)
2. Receives image generation requests via HTTP
3. Spawns stable-diffusion.cpp executable on-demand with appropriate arguments
4. Monitors progress and returns results
5. Provides the same HTTP interface pattern for symmetry with llama-server

### Why an HTTP Wrapper?

From genai-lite's perspective, both llama-server and diffusion should be HTTP endpoints on localhost. This clean separation means:
- genai-lite doesn't know which servers are native vs. wrappers
- Consistent API patterns for both LLM and image generation
- Easy to swap backends without affecting the API layer
- Future-proof if stable-diffusion.cpp adds native server support

### Resource Orchestration

When system resources (RAM or VRAM) are constrained, we need **automatic resource management**:

**Scenario**: User has 8GB VRAM, LLM uses 6GB, diffusion needs 5GB → Not enough for both

**Solution**:
1. **Offload LLM**: Save state, stop llama-server gracefully, free 6GB VRAM
2. **Generate Image**: Start diffusion, generate image, stop diffusion
3. **Reload LLM**: Restart llama-server with saved config, restore to previous state
4. **Queue Management**: LLM requests during image generation are queued (with timeout)

This happens **automatically** and **transparently** to the user.

---

## Phase 2 Goals

### Functional Requirements

- ✅ **DiffusionServerManager**: HTTP wrapper for stable-diffusion.cpp
- ✅ **Image Generation API**: Request/response types, parameter validation
- ✅ **Binary Management**: Download stable-diffusion.cpp binaries on first use
- ✅ **Progress Tracking**: Real-time progress callbacks during generation
- ✅ **Resource Orchestration**: Automatic LLM offload/reload when needed
- ✅ **CPU and GPU Support**: Generate images on both CPU and GPU
- ✅ **Error Handling**: Comprehensive error types and recovery suggestions

### Non-Goals (Future Phases)

- ❌ **Advanced Resource Monitoring**: Real-time VRAM/RAM usage graphs (Phase 3+)
- ❌ **Multi-Model Support**: Running multiple models simultaneously (Phase 5)
- ❌ **Advanced Queue Management**: Priority queues, request cancellation (Phase 3)
- ❌ **Model Conversion**: Converting models to GGUF format (out of scope)

---

## Architecture Overview

### Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│                   genai-electron                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌────────────────┐  ┌─────────────────┐  ┌──────────┐  │
│  │ ModelManager   │  │  ServerManager  │  │SystemInfo│  │
│  │                │  │                 │  │          │  │
│  │ • listModels   │  │ • LlamaServer   │  │ • getRAM │  │
│  │ • download     │  │ • DiffusionSrv  │  │ • getGPU │  │
│  │ • delete       │  │ • start/stop    │  │ • getVRAM│  │
│  └────────────────┘  └─────────────────┘  └──────────┘  │
│           │                   │                  │      │
│           └───────────────────┴──────────────────┘      │
│                               │                         │
│                    ┌──────────▼──────────┐              │
│                    │  ResourceOrchestrator│             │
│                    │                     │              │
│                    │ • orchestrate()     │              │
│                    │ • offloadLLM()      │              │
│                    │ • reloadLLM()       │              │
│                    └─────────────────────┘              │
│                                                         │
└─────────────────────────────────────────────────────────┘
         │                                   │
         │ spawns                            │ spawns & monitors
         ▼                                   ▼
┌─────────────────────┐         ┌─────────────────────────┐
│  llama-server       │         │  HTTP Wrapper (Node)    │
│  (port 8080)        │         │  (port 8081)            │
│  [native server]    │         │    ↓ spawns on request  │
│                     │         │  stable-diffusion.cpp   │
└─────────────────────┘         └─────────────────────────┘
```

### HTTP Wrapper Architecture

```
┌────────────────────────────────────────────────────────────┐
│              DiffusionServerManager                        │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  start() → Creates HTTP server (Node's built-in http)     │
│            └─ Listens on port 8081                        │
│            └─ Provides endpoints:                         │
│                • GET  /health                             │
│                • POST /v1/images/generations             │
│                                                            │
│  generateImage() → On HTTP POST request:                  │
│    1. Validate parameters                                 │
│    2. Spawn stable-diffusion.cpp with CLI args            │
│    3. Monitor stdout for progress                         │
│    4. Wait for completion                                 │
│    5. Read generated image from disk                      │
│    6. Return image data in HTTP response                  │
│    7. Executable exits                                    │
│                                                            │
│  stop() → Shuts down HTTP server                          │
│           └─ Kills any running stable-diffusion.cpp       │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### Resource Orchestration Flow

```
State 1: LLM Running
┌────────────────────────┐
│ llama-server           │
│ 6GB VRAM, 1GB RAM      │
└────────────────────────┘
    ↓ User requests image generation
    ↓ ResourceOrchestrator.orchestrate()
    ↓ Check: Enough resources? NO (need 5GB VRAM, only 2GB available)

State 2: Offload LLM
┌────────────────────────┐
│ Save LLM state:        │
│ - modelId              │
│ - config (GPU layers)  │
│ - port                 │
└────────────────────────┘
    ↓ llamaServer.stop()
    ↓ Free 6GB VRAM

State 3: Generate Image
┌────────────────────────┐
│ diffusionServer.start()│
│ generateImage()        │
│ 5GB VRAM, 2GB RAM      │
└────────────────────────┘
    ↓ Image complete
    ↓ diffusionServer.stop()
    ↓ Free 5GB VRAM

State 4: Reload LLM
┌────────────────────────┐
│ llamaServer.start()    │
│ (with saved config)    │
│ 6GB VRAM, 1GB RAM      │
└────────────────────────┘
    ↓ Process queued requests
    ↓ Back to normal state
```

---

## Implementation Steps

### Step 0: Update Binary Configuration (2-3 hours)

**Goal**: Update `BINARY_VERSIONS` with actual stable-diffusion.cpp release URLs and checksums.

**Files to modify**:
- `src/config/defaults.ts`

**Current State**: Placeholder values exist:
```typescript
diffusionCpp: {
  version: 'v1.0.0', // Example version
  urls: {
    'darwin-arm64': 'https://github.com/leejet/stable-diffusion.cpp/releases/...',
    // ... placeholder URLs
  },
  checksums: {
    'darwin-arm64': 'sha256:placeholder_checksum_darwin_arm64',
    // ... placeholder checksums
  },
}
```

**Action Required**:
1. Visit https://github.com/leejet/stable-diffusion.cpp/releases
2. Find latest stable release (e.g., master-db6f479 or later)
3. **Click "Show more assets"** to expand full list (GitHub truncates long lists!)
4. Identify binaries for all platforms and variants
5. Extract SHA256 checksums (see instructions below)
6. Update `BINARY_VERSIONS.diffusionCpp` with real URLs and checksums

**How to Extract SHA256 Checksums**:

```bash
# Method: Parse GitHub release page
1. Navigate to release page (e.g., .../releases/tag/master-db6f479)
2. Click "Show more assets" to expand full list
3. For each binary file, find the "sha256:" text that appears after the filename
4. Copy the 64-character hexadecimal hash

# Example pattern in HTML:
<span>sd-master-db6f479-bin-win-cuda12-x64.zip</span>
...
<span>sha256:abc123...def456</span>  ← This is the checksum
```

**See `docs/dev/UPDATING-BINARIES.md` for detailed extraction methods** (WebFetch, HTML parsing script, etc.)

**Important**: Like llama.cpp, stable-diffusion.cpp **has multiple variants per platform**. Windows has the most variants (CUDA12, Vulkan, AVX512, AVX2, AVX, No-AVX). macOS and Linux typically have single Metal/CPU binaries.

**Variant Structure** (from latest releases):

**Windows (win32-x64)** - Multiple variants with fallback priority:
- CUDA 12: `sd-master-db6f479-bin-win-cuda12-x64.zip` (NVIDIA GPUs with CUDA runtime)
- Vulkan: `sd-master-db6f479-bin-win-vulkan-x64.zip` (Any GPU with Vulkan drivers)
- AVX512: `sd-master-db6f479-bin-win-avx512-x64.zip` (Modern CPUs)
- AVX2: `sd-master-db6f479-bin-win-avx2-x64.zip` (Most CPUs)
- AVX: `sd-master-db6f479-bin-win-avx-x64.zip` (Older CPUs)
- No-AVX: `sd-master-db6f479-bin-win-noavx-x64.zip` (Very old CPUs, final fallback)

**macOS (darwin-arm64)** - Single binary:
- Metal: `sd-master--bin-Darwin-macOS-15.6.1-arm64.zip` (Apple Silicon with Metal)

**Linux (linux-x64)** - Single binary:
- CPU/CUDA: `sd-master--bin-Linux-Ubuntu-24.04-x86_64.zip` (Ubuntu/Debian)

**Update Format** (use variants array pattern like llama.cpp):
```typescript
diffusionCpp: {
  version: 'master-db6f479', // Actual version from release
  variants: {
    'darwin-arm64': [
      {
        type: 'metal' as BinaryVariant,
        url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-db6f479/sd-master--bin-Darwin-macOS-15.6.1-arm64.zip',
        checksum: 'actual_sha256_checksum_here', // Extract from GitHub
      },
    ],
    'win32-x64': [
      // Priority order: CUDA → Vulkan → AVX variants (fastest to slowest)
      {
        type: 'cuda' as BinaryVariant,
        url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-db6f479/sd-master-db6f479-bin-win-cuda12-x64.zip',
        checksum: 'actual_checksum',
      },
      {
        type: 'vulkan' as BinaryVariant,
        url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-db6f479/sd-master-db6f479-bin-win-vulkan-x64.zip',
        checksum: 'actual_checksum',
      },
      {
        type: 'cpu' as BinaryVariant, // AVX2 variant (most compatible CPU version)
        url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-db6f479/sd-master-db6f479-bin-win-avx2-x64.zip',
        checksum: 'actual_checksum',
      },
      // Optional: Add more CPU variants if needed (avx512, avx, noavx)
    ],
    'linux-x64': [
      {
        type: 'cpu' as BinaryVariant, // Works with both CPU and CUDA
        url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-db6f479/sd-master--bin-Linux-Ubuntu-24.04-x86_64.zip',
        checksum: 'actual_checksum',
      },
    ],
  },
}
```

**Fallback Priority Strategy**:
- **Windows**: CUDA (fastest) → Vulkan (cross-GPU) → AVX2 (CPU fallback)
- **macOS**: Metal only (all modern Macs support it)
- **Linux**: Single binary (detects CUDA at runtime if available)

**Testing Strategy**: BinaryManager will test each variant with `--version` and use the first one that works (has required drivers/CPU features).

**Important Note - Binary Name Verification**:
When implementing, verify the actual executable name from downloaded binaries. It may be:
- `stable-diffusion` or `sd` or `stable-diffusion.cpp`
- Platform-specific variations (e.g., `sd.exe` on Windows)

Check the actual release and update `binaryName` parameter accordingly.

---

### Step 1: Image Generation Types (2-3 hours)

**Goal**: Define TypeScript types for image generation API.

**Files to create**:
- `src/types/images.ts`

**Files to modify**:
- `src/types/index.ts` (export new types)

#### 1.1 Create `src/types/images.ts`

```typescript
/**
 * Image generation types
 * @module types/images
 */

/**
 * Image generation request configuration
 */
export interface ImageGenerationConfig {
  /** Text prompt describing the image */
  prompt: string;

  /** Negative prompt (what to avoid) */
  negativePrompt?: string;

  /** Image width in pixels (default: 512) */
  width?: number;

  /** Image height in pixels (default: 512) */
  height?: number;

  /** Number of inference steps (default: 20, more = better quality but slower) */
  steps?: number;

  /** Guidance scale (default: 7.5, higher = closer to prompt) */
  cfgScale?: number;

  /** Random seed for reproducibility (-1 = random) */
  seed?: number;

  /** Sampler algorithm (default: 'euler_a') */
  sampler?: ImageSampler;

  /** Progress callback (step, totalSteps) */
  onProgress?: (currentStep: number, totalSteps: number) => void;
}

/**
 * Available sampler algorithms
 */
export type ImageSampler =
  | 'euler_a'
  | 'euler'
  | 'heun'
  | 'dpm2'
  | 'dpm++2s_a'
  | 'dpm++2m'
  | 'dpm++2mv2'
  | 'lcm';

/**
 * Image generation result
 */
export interface ImageGenerationResult {
  /** Generated image data (Buffer) */
  image: Buffer;

  /** Image format (always 'png' for stable-diffusion.cpp) */
  format: 'png';

  /** Time taken in milliseconds */
  timeTaken: number;

  /** Seed used (for reproducibility) */
  seed: number;

  /** Image dimensions */
  width: number;
  height: number;
}

/**
 * Diffusion server configuration
 */
export interface DiffusionServerConfig {
  /** Model ID to load */
  modelId: string;

  /** Port to listen on (default: 8081) */
  port?: number;

  /** Number of CPU threads (auto-detected if not specified) */
  threads?: number;

  /** Number of GPU layers to offload (auto-detected if not specified, 0 = CPU-only) */
  gpuLayers?: number;

  /** VRAM budget in MB (optional, stable-diffusion.cpp will try to fit within this) */
  vramBudget?: number;
}

/**
 * Diffusion server status
 */
export interface DiffusionServerInfo {
  /** Current server status */
  status: ServerStatus;

  /** Health check status */
  health: HealthStatus;

  /** Process ID (if running) */
  pid?: number;

  /** Port server is listening on */
  port: number;

  /** Model ID being served */
  modelId: string;

  /** When server was started (ISO timestamp, if running) */
  startedAt?: string;

  /** Last error message (if crashed) */
  error?: string;

  /** Whether currently generating an image */
  busy?: boolean;
}
```

**Import from servers.ts**:
```typescript
import type { ServerStatus, HealthStatus } from './servers.js';
```

#### 1.2 Update `src/types/index.ts`

Add exports:
```typescript
// Image generation types
export type {
  ImageGenerationConfig,
  ImageGenerationResult,
  ImageSampler,
  DiffusionServerConfig,
  DiffusionServerInfo,
} from './images.js';
```

---

### Step 2: HTTP Wrapper Implementation (6-8 hours)

**Goal**: Create DiffusionServerManager that wraps stable-diffusion.cpp with an HTTP server.

**Files to create**:
- `src/managers/DiffusionServerManager.ts`

**Dependencies**: Use Node.js built-in `http` module (zero new dependencies).

#### 2.1 Create `src/managers/DiffusionServerManager.ts`

**Key Implementation Points**:
1. Extends `ServerManager` base class (like LlamaServerManager)
2. Creates HTTP server using Node's built-in `http` module
3. Implements endpoints: `GET /health`, `POST /v1/images/generations`
4. Spawns `stable-diffusion.cpp` on image generation requests
5. Monitors stdout for progress updates
6. Returns generated image in HTTP response

**Structure**:
```typescript
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
import { LogManager } from '../process/log-manager.js';
import { BinaryManager } from './BinaryManager.js';
import http from 'http';
import path from 'path';
import { promises as fs } from 'fs';
import { PATHS } from '../config/paths.js';
import { BINARY_VERSIONS, DEFAULT_PORTS, DEFAULT_TIMEOUTS } from '../config/defaults.js';
import { getPlatformKey } from '../utils/platform-utils.js';
import { fileExists, deleteFile } from '../utils/file-utils.js';
import {
  ServerError,
  ModelNotFoundError,
  PortInUseError,
  InsufficientResourcesError,
  BinaryError,
} from '../errors/index.js';
import type {
  DiffusionServerConfig,
  DiffusionServerInfo,
  ImageGenerationConfig,
  ImageGenerationResult,
  ModelInfo,
} from '../types/index.js';

/**
 * DiffusionServerManager class
 *
 * Manages the lifecycle of diffusion HTTP wrapper server.
 */
export class DiffusionServerManager extends ServerManager {
  private processManager: ProcessManager;
  private modelManager: ModelManager;
  private systemInfo: SystemInfo;
  private logManager?: LogManager;
  private binaryPath?: string;
  private httpServer?: http.Server;
  private currentGeneration?: {
    promise: Promise<ImageGenerationResult>;
    cancel: () => void;
  };

  constructor(
    modelManager: ModelManager = ModelManager.getInstance(),
    systemInfo: SystemInfo = SystemInfo.getInstance()
  ) {
    super();
    this.processManager = new ProcessManager();
    this.modelManager = modelManager;
    this.systemInfo = systemInfo;
  }

  /**
   * Start diffusion HTTP wrapper server
   *
   * Creates an HTTP server that will spawn stable-diffusion.cpp on-demand
   * when image generation requests are received.
   */
  async start(config: DiffusionServerConfig): Promise<DiffusionServerInfo> {
    if (this._status === 'running') {
      throw new ServerError('Server is already running', {
        suggestion: 'Stop the server first with stop()',
      });
    }

    this.setStatus('starting');
    this._config = config;

    try {
      // 1. Validate model exists
      const modelInfo = await this.modelManager.getModelInfo(config.modelId);
      if (modelInfo.type !== 'diffusion') {
        throw new ModelNotFoundError(
          `Model ${config.modelId} is not a diffusion model`,
          { expectedType: 'diffusion', actualType: modelInfo.type }
        );
      }

      // 2. Check if system can run this model
      const canRun = await this.systemInfo.canRunModel(modelInfo);
      if (!canRun.possible) {
        throw new InsufficientResourcesError(
          `System cannot run model: ${canRun.reason || 'Insufficient resources'}`,
          {
            required: `Model size: ${Math.round(modelInfo.size / 1024 / 1024 / 1024)}GB`,
            available: `Available RAM: ${Math.round(
              (await this.systemInfo.getMemoryInfo()).available / 1024 / 1024 / 1024
            )}GB`,
            suggestion: canRun.suggestion || canRun.reason || 'Try a smaller model',
          }
        );
      }

      // 3. Ensure binary is downloaded
      this.binaryPath = await this.ensureBinary();

      // 4. Check if port is in use
      const port = config.port || DEFAULT_PORTS.diffusion;
      const { isServerResponding } = await import('../process/health-check.js');
      if (await isServerResponding(port, 2000)) {
        throw new PortInUseError(port);
      }

      // 5. Initialize log manager
      const logPath = path.join(PATHS.logs, 'diffusion-server.log');
      this.logManager = new LogManager(logPath);
      await this.logManager.initialize();
      await this.logManager.write(`Starting diffusion server on port ${port}`, 'info');

      // 6. Create HTTP server
      await this.createHTTPServer(config, modelInfo);

      this._port = port;
      this._startedAt = new Date();
      this.setStatus('running');

      await this.logManager.write('Diffusion server is running', 'info');
      this.emitEvent('started', this.getInfo());

      return this.getInfo() as DiffusionServerInfo;
    } catch (error) {
      this.setStatus('stopped');
      if (this.httpServer) {
        this.httpServer.close();
        this.httpServer = undefined;
      }

      if (this.logManager) {
        await this.logManager.write(
          `Failed to start: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        );
      }

      // Re-throw typed errors
      if (
        error instanceof ModelNotFoundError ||
        error instanceof PortInUseError ||
        error instanceof BinaryError ||
        error instanceof InsufficientResourcesError ||
        error instanceof ServerError
      ) {
        throw error;
      }

      throw new ServerError(
        `Failed to start diffusion server: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Stop diffusion server
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

    // Implementation in private method
    return this.executeImageGeneration(config);
  }

  /**
   * Check if server is healthy
   */
  async isHealthy(): Promise<boolean> {
    return this._status === 'running' && this.httpServer !== undefined;
  }

  /**
   * Get recent server logs
   */
  async getLogs(lines: number = 100): Promise<string[]> {
    if (!this.logManager) {
      return [];
    }
    try {
      return await this.logManager.getRecent(lines);
    } catch {
      return [];
    }
  }

  /**
   * Clear all server logs
   */
  async clearLogs(): Promise<void> {
    if (!this.logManager) {
      return;
    }
    try {
      await this.logManager.clear();
    } catch {
      // Ignore errors
    }
  }

  /**
   * Ensure stable-diffusion.cpp binary is downloaded
   * @private
   */
  private async ensureBinary(): Promise<string> {
    const platformKey = getPlatformKey();
    const binaryConfig = BINARY_VERSIONS.diffusionCpp;
    const variants = binaryConfig.variants[platformKey];

    const binaryManager = new BinaryManager({
      type: 'diffusion',
      binaryName: 'stable-diffusion',
      platformKey,
      variants: variants || [],
      log: this.logManager
        ? (message, level = 'info') => {
            this.logManager?.write(message, level).catch(() => {});
          }
        : undefined,
    });

    return await binaryManager.ensureBinary();
  }

  /**
   * Create HTTP server
   * @private
   */
  private async createHTTPServer(
    config: DiffusionServerConfig,
    modelInfo: ModelInfo
  ): Promise<void> {
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
          res.end(JSON.stringify({
            image: result.image.toString('base64'),
            format: result.format,
            timeTaken: result.timeTaken,
            seed: result.seed,
            width: result.width,
            height: result.height,
          }));
          return;
        }

        // Not found
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: error instanceof Error ? error.message : 'Internal server error',
        }));
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
   * @private
   */
  private async executeImageGeneration(
    config: ImageGenerationConfig
  ): Promise<ImageGenerationResult> {
    const startTime = Date.now();
    const modelInfo = await this.modelManager.getModelInfo(this._config!.modelId);

    // Build command-line arguments
    const args = this.buildDiffusionArgs(config, modelInfo);

    // Output file path
    const outputPath = path.join(PATHS.temp || '/tmp', `sd-output-${Date.now()}.png`);
    args.push('-o', outputPath);

    await this.logManager?.write(
      `Generating image: ${this.binaryPath} ${args.join(' ')}`,
      'info'
    );

    // Spawn stable-diffusion.cpp
    let cancelled = false;
    const generationPromise = new Promise<ImageGenerationResult>((resolve, reject) => {
      const { pid } = this.processManager.spawn(this.binaryPath!, args, {
        onStdout: (data) => {
          // Parse progress from stdout
          // stable-diffusion.cpp outputs: "step 5/20"
          const match = data.match(/step (\d+)\/(\d+)/i);
          if (match && config.onProgress) {
            const current = parseInt(match[1], 10);
            const total = parseInt(match[2], 10);
            config.onProgress(current, total);
          }
          this.logManager?.write(data, 'info').catch(() => {});
        },
        onStderr: (data) => {
          this.logManager?.write(data, 'warn').catch(() => {});
        },
        onExit: async (code) => {
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
            await deleteFile(outputPath).catch(() => {});

            resolve({
              image: imageBuffer,
              format: 'png',
              timeTaken: Date.now() - startTime,
              seed: config.seed || -1,
              width: config.width || 512,
              height: config.height || 512,
            });
          } catch (error) {
            reject(new ServerError('Failed to read generated image', {
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        },
        onError: (error) => {
          reject(new ServerError('Failed to spawn stable-diffusion.cpp', {
            error: error.message,
          }));
        },
      });

      // Store cancellation function
      this.currentGeneration = {
        promise: generationPromise,
        cancel: () => {
          cancelled = true;
          this.processManager.kill(pid, 5000).catch(() => {});
        },
      };
    });

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
   * @private
   */
  private buildDiffusionArgs(config: ImageGenerationConfig, modelInfo: ModelInfo): string[] {
    const args: string[] = [];

    // Model path
    args.push('-m', modelInfo.path);

    // Prompt
    args.push('-p', config.prompt);

    // Negative prompt
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
}
```

---

### Step 3: Resource Orchestrator (4-5 hours)

**Goal**: Implement automatic resource management that offloads LLM when needed for image generation.

**Files to create**:
- `src/managers/ResourceOrchestrator.ts`

#### 3.1 Create `src/managers/ResourceOrchestrator.ts`

```typescript
/**
 * ResourceOrchestrator - Manages resource allocation between servers
 *
 * Automatically offloads and reloads servers when resources are constrained.
 * For example, if VRAM is limited, it will stop the LLM server before
 * starting image generation, then restart the LLM after completion.
 *
 * @module managers/ResourceOrchestrator
 */

import { SystemInfo } from '../system/SystemInfo.js';
import { LlamaServerManager } from './LlamaServerManager.js';
import { DiffusionServerManager } from './DiffusionServerManager.js';
import type {
  ServerConfig,
  ImageGenerationConfig,
  ImageGenerationResult,
} from '../types/index.js';
import { ServerError } from '../errors/index.js';

/**
 * Saved LLM state for restoration
 */
interface SavedLLMState {
  config: ServerConfig;
  wasRunning: boolean;
  savedAt: Date;
}

/**
 * Resource requirements for a server
 */
interface ResourceRequirements {
  ram: number;
  vram?: number;
}

/**
 * ResourceOrchestrator class
 *
 * Manages resource allocation and automatic offload/reload logic.
 */
export class ResourceOrchestrator {
  private systemInfo: SystemInfo;
  private llamaServer: LlamaServerManager;
  private diffusionServer: DiffusionServerManager;
  private savedLLMState?: SavedLLMState;

  constructor(
    systemInfo: SystemInfo = SystemInfo.getInstance(),
    llamaServer: LlamaServerManager,
    diffusionServer: DiffusionServerManager
  ) {
    this.systemInfo = systemInfo;
    this.llamaServer = llamaServer;
    this.diffusionServer = diffusionServer;
  }

  /**
   * Orchestrate image generation with automatic resource management
   *
   * Checks if there are enough resources. If not, offloads LLM first,
   * generates image, then reloads LLM.
   *
   * @param config - Image generation configuration
   * @returns Generated image result
   */
  async orchestrateImageGeneration(
    config: ImageGenerationConfig
  ): Promise<ImageGenerationResult> {
    // Check if we need to offload LLM
    const needsOffload = await this.needsOffloadForImage();

    if (needsOffload && this.llamaServer.isRunning()) {
      // Save LLM state and offload
      await this.offloadLLM();

      try {
        // Generate image
        const result = await this.diffusionServer.generateImage(config);
        return result;
      } finally {
        // Always reload LLM if it was running before
        await this.reloadLLM();
      }
    } else {
      // Enough resources, generate directly
      return await this.diffusionServer.generateImage(config);
    }
  }

  /**
   * Check if we need to offload LLM for image generation
   *
   * Determines the bottleneck resource (RAM or VRAM) and checks if
   * there's enough space for both servers to run simultaneously.
   *
   * @returns True if offload is needed
   * @private
   */
  private async needsOffloadForImage(): Promise<boolean> {
    const memory = this.systemInfo.getMemoryInfo();
    const capabilities = await this.systemInfo.detect();

    // Estimate resource usage
    const llamaUsage = await this.estimateLLMUsage();
    const diffusionUsage = await this.estimateDiffusionUsage();

    // Determine bottleneck resource
    const isGPUSystem = capabilities.gpu.available && capabilities.gpu.vram;

    if (isGPUSystem) {
      // VRAM is the bottleneck
      const totalVRAM = capabilities.gpu.vram || 0;
      const vramNeeded = (llamaUsage.vram || 0) + (diffusionUsage.vram || 0);

      // Need offload if combined VRAM usage > 75% of total
      return vramNeeded > totalVRAM * 0.75;
    } else {
      // RAM is the bottleneck
      const ramNeeded = llamaUsage.ram + diffusionUsage.ram;

      // Need offload if combined RAM usage > 75% of available
      return ramNeeded > memory.available * 0.75;
    }
  }

  /**
   * Estimate LLM resource usage
   * @private
   */
  private async estimateLLMUsage(): Promise<ResourceRequirements> {
    if (!this.llamaServer.isRunning()) {
      return { ram: 0, vram: 0 };
    }

    const config = this.llamaServer.getConfig();
    if (!config) {
      return { ram: 0, vram: 0 };
    }

    // Rough estimates (would be better with actual monitoring)
    const modelInfo = await import('./ModelManager.js').then((m) =>
      m.ModelManager.getInstance().getModelInfo(config.modelId)
    );

    const gpuLayers = config.gpuLayers || 0;
    const totalLayers = 32; // Rough estimate

    if (gpuLayers > 0) {
      // Mixed GPU/CPU
      const gpuRatio = gpuLayers / totalLayers;
      return {
        ram: modelInfo.size * (1 - gpuRatio) * 1.2,
        vram: modelInfo.size * gpuRatio * 1.2,
      };
    } else {
      // CPU only
      return {
        ram: modelInfo.size * 1.2,
        vram: 0,
      };
    }
  }

  /**
   * Estimate diffusion resource usage
   * @private
   */
  private async estimateDiffusionUsage(): Promise<ResourceRequirements> {
    const config = this.diffusionServer.getConfig();
    if (!config) {
      // Default estimate for typical SDXL model
      return { ram: 5 * 1024 ** 3, vram: 5 * 1024 ** 3 };
    }

    const modelInfo = await import('./ModelManager.js').then((m) =>
      m.ModelManager.getInstance().getModelInfo(config.modelId)
    );

    // Diffusion models typically need similar VRAM/RAM as their size
    return {
      ram: modelInfo.size * 1.2,
      vram: modelInfo.size * 1.2,
    };
  }

  /**
   * Offload LLM (save state and stop)
   * @private
   */
  private async offloadLLM(): Promise<void> {
    if (!this.llamaServer.isRunning()) {
      return;
    }

    // Save current state
    const config = this.llamaServer.getConfig();
    if (!config) {
      throw new ServerError('Cannot offload LLM: no configuration found');
    }

    this.savedLLMState = {
      config,
      wasRunning: true,
      savedAt: new Date(),
    };

    // Stop LLM server gracefully
    await this.llamaServer.stop();
  }

  /**
   * Reload LLM (restore from saved state)
   * @private
   */
  private async reloadLLM(): Promise<void> {
    if (!this.savedLLMState || !this.savedLLMState.wasRunning) {
      return;
    }

    try {
      // Restart with saved configuration
      await this.llamaServer.start(this.savedLLMState.config);
      this.savedLLMState = undefined;
    } catch (error) {
      // Log error but don't throw - image generation succeeded
      console.error('Failed to reload LLM:', error);
    }
  }

  /**
   * Clear saved LLM state
   */
  clearSavedState(): void {
    this.savedLLMState = undefined;
  }
}
```

**Phase 2 Scope Notes**:

This implementation provides the **core resource orchestration** mechanism (offload/reload). The following advanced features are **deferred to Phase 3**:

1. **LLM Request Queuing**: Phase 2 simply blocks new LLM requests during image generation. Phase 3 will add request queuing with timeouts so LLM requests made during image generation are queued and processed after LLM reload (see DESIGN.md lines 378-380).

2. **Advanced Queue Management**: Phase 2 has basic "wait for LLM to reload" behavior. Phase 3 will add:
   - Request queue with configurable timeout (default 5 minutes)
   - Queue cancellation API
   - Per-request timeout tracking
   - Queue status monitoring

3. **Concurrent Resource Scenarios**: Phase 2 focuses on the simple case (not enough resources → offload → reload). Phase 3 will handle:
   - Partial resource conflicts (LLM on CPU, diffusion on GPU)
   - Multi-model resource allocation
   - Dynamic resource reallocation

**For Phase 2, focus on proving the offload/reload mechanism works correctly.**

---

### Step 4: Update Exports (30 minutes)

**Goal**: Export new classes and types from main index.

**Files to modify**:
- `src/index.ts`

#### 4.1 Update `src/index.ts`

Add singleton export:
```typescript
import { DiffusionServerManager } from './managers/DiffusionServerManager.js';

/**
 * Diffusion server manager singleton
 */
export const diffusionServer = new DiffusionServerManager();
```

Add class exports:
```typescript
export { DiffusionServerManager } from './managers/DiffusionServerManager.js';
export { ResourceOrchestrator } from './managers/ResourceOrchestrator.js';
```

Add type exports:
```typescript
// Image generation types already exported from types/index.ts
// (added in Step 1)
```

---

### Step 5: Add Temp Directory Support (1 hour)

**Goal**: Add temporary directory for intermediate files.

**Files to modify**:
- `src/config/paths.ts`

#### 5.1 Update `src/config/paths.ts`

Add temp directory:
```typescript
export const PATHS = {
  // ... existing paths
  logs: path.join(BASE_DIR, 'logs'),
  config: path.join(BASE_DIR, 'config'),

  // Add temp directory for intermediate files
  temp: path.join(BASE_DIR, 'temp'),
} as const;
```

Update `getBinaryPath` if needed for diffusion binaries.

---

### Step 6: Error Types (30 minutes)

**Goal**: Add any new error types needed for image generation.

**Files to modify**:
- `src/errors/index.ts` (if new error types needed)

**Review**: Check if existing error types cover all Phase 2 scenarios:
- `ModelNotFoundError` ✅
- `ServerError` ✅
- `InsufficientResourcesError` ✅
- `PortInUseError` ✅
- `BinaryError` ✅

**Conclusion**: Likely no new error types needed. Existing types should cover image generation scenarios.

---

### Step 7: Integration Testing (3-4 hours)

**Goal**: Create tests for DiffusionServerManager and ResourceOrchestrator.

**Files to create**:
- `tests/unit/DiffusionServerManager.test.ts`
- `tests/unit/ResourceOrchestrator.test.ts`

#### 7.1 Test Strategy

Follow Phase 1 pattern:
- Mock file system operations
- Mock process spawning
- Mock HTTP server creation
- Test error scenarios comprehensively

Example test structure:
```typescript
describe('DiffusionServerManager', () => {
  describe('start()', () => {
    it('should create HTTP server on specified port', async () => {
      // Test implementation
    });

    it('should throw ModelNotFoundError if model does not exist', async () => {
      // Test implementation
    });

    it('should throw PortInUseError if port is already in use', async () => {
      // Test implementation
    });
  });

  describe('generateImage()', () => {
    it('should spawn stable-diffusion.cpp with correct arguments', async () => {
      // Test implementation
    });

    it('should track progress during generation', async () => {
      // Test implementation
    });

    it('should throw ServerError if not running', async () => {
      // Test implementation
    });
  });

  describe('stop()', () => {
    it('should close HTTP server and cleanup', async () => {
      // Test implementation
    });
  });
});

describe('ResourceOrchestrator', () => {
  describe('orchestrateImageGeneration()', () => {
    it('should generate image directly if resources available', async () => {
      // Test implementation
    });

    it('should offload LLM if resources constrained', async () => {
      // Test implementation
    });

    it('should reload LLM after image generation', async () => {
      // Test implementation
    });
  });
});
```

---

## Testing Strategy

### Unit Tests

**Coverage Target**: 80%+ for new code

**Key Test Files**:
1. `tests/unit/DiffusionServerManager.test.ts`
   - Test HTTP server creation
   - Test image generation flow
   - Test error scenarios
   - Mock stable-diffusion.cpp execution

2. `tests/unit/ResourceOrchestrator.test.ts`
   - Test resource estimation
   - Test offload/reload logic
   - Test different resource scenarios (RAM-bound, VRAM-bound)

3. `tests/unit/images.test.ts` (optional)
   - Test type validation
   - Test parameter defaults

### Integration Tests (Manual)

**Test Scenarios**:
1. **Basic Image Generation**
   - Start diffusion server
   - Generate simple image (512x512, 20 steps)
   - Verify image file created
   - Stop server

2. **Resource Orchestration**
   - Start LLM server (occupy VRAM)
   - Request image generation
   - Verify LLM stops automatically
   - Verify image generates successfully
   - Verify LLM restarts automatically

3. **Error Handling**
   - Invalid model ID
   - Port already in use
   - Insufficient resources
   - Binary not found

4. **Platform Testing**
   - Test on macOS (Metal)
   - Test on Windows (CUDA/Vulkan/CPU)
   - Test on Linux (CUDA/Vulkan)

---

## Documentation Updates

### Files to Update

1. **README.md**
   - Add Phase 2 status (complete)
   - Add image generation to feature list
   - Add basic usage example for diffusion

2. **docs/API.md**
   - Document `DiffusionServerManager` API
   - Document `ResourceOrchestrator` API
   - Add image generation examples
   - Document new types (ImageGenerationConfig, etc.)

3. **PROGRESS.md**
   - Update Phase 2 status to complete
   - Summarize what was implemented

### Example Documentation Snippet (README.md)

```markdown
## Image Generation (Phase 2)

Generate images locally using stable-diffusion.cpp:

```typescript
import { modelManager, diffusionServer } from 'genai-electron';

// Download a diffusion model
await modelManager.downloadModel({
  source: 'url',
  url: 'https://huggingface.co/..../sdxl-turbo-q4.gguf',
  name: 'SDXL Turbo',
  type: 'diffusion'
});

// Start diffusion server
await diffusionServer.start({
  modelId: 'sdxl-turbo',
  port: 8081
});

// Generate an image
const result = await diffusionServer.generateImage({
  prompt: 'A serene mountain landscape at sunset',
  negativePrompt: 'blurry, low quality',
  width: 1024,
  height: 1024,
  steps: 30,
  onProgress: (step, total) => {
    console.log(`Progress: ${step}/${total}`);
  }
});

// Save image
await fs.writeFile('output.png', result.image);
```

### Resource Management

The library automatically manages resources between LLM and image generation:

```typescript
// LLM is running and using 6GB VRAM
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });

// Request image generation
// Library detects insufficient VRAM (only 2GB available, need 5GB)
// Automatically stops LLM, generates image, then restarts LLM
const result = await diffusionServer.generateImage({
  prompt: 'Beautiful sunset over mountains'
});

// LLM is running again with original configuration
```
```

---

## Timeline & Success Criteria

### Timeline Estimate

**Total: 20-27 hours (2.5-3.5 weeks at 1-2 hours/day)**

| Step | Task | Estimate |
|------|------|----------|
| 0 | Update Binary Config (variants + checksums) | 2-3h |
| 1 | Image Generation Types | 2-3h |
| 2 | DiffusionServerManager | 6-8h |
| 3 | ResourceOrchestrator | 4-5h |
| 4 | Update Exports | 0.5h |
| 5 | Temp Directory Support | 1h |
| 6 | Error Types Review | 0.5h |
| 7 | Testing | 3-4h |
| 8 | Documentation | 2-3h |

### Success Criteria

#### Functional Requirements ✅

- [ ] DiffusionServerManager creates HTTP server successfully
- [ ] Can download stable-diffusion.cpp binaries for all platforms
- [ ] Can generate images with various parameters (size, steps, cfg)
- [ ] Progress tracking works during generation
- [ ] ResourceOrchestrator detects when offload is needed
- [ ] LLM offload/reload works automatically
- [ ] HTTP wrapper provides same interface as llama-server
- [ ] All error scenarios handled with clear messages

#### Technical Requirements ✅

- [ ] Zero new dependencies (uses Node built-in http module)
- [ ] TypeScript compiles with zero errors
- [ ] Follows established patterns from Phase 1
- [ ] 80%+ test coverage for new code
- [ ] ESM module system (`.js` extensions in imports)
- [ ] Singleton pattern for diffusionServer export

#### Platform Requirements ✅

- [ ] Works on macOS (Metal)
- [ ] Works on Windows (CUDA/Vulkan/CPU fallback)
- [ ] Works on Linux (CUDA/Vulkan)
- [ ] Binary variant testing works correctly

#### Documentation Requirements ✅

- [ ] README.md updated with Phase 2 features
- [ ] API.md documents all new classes and methods
- [ ] PROGRESS.md reflects Phase 2 completion
- [ ] Code examples demonstrate image generation

---

## Appendix

### A. stable-diffusion.cpp Command-Line Reference

**Basic Usage**:
```bash
stable-diffusion -m model.gguf -p "prompt text" -o output.png
```

**Key Arguments**:
- `-m, --model`: Path to model file
- `-p, --prompt`: Text prompt
- `-n, --negative-prompt`: Negative prompt
- `-W, --width`: Image width (default: 512)
- `-H, --height`: Image height (default: 512)
- `--steps`: Number of sampling steps (default: 20)
- `--cfg-scale`: Classifier-free guidance scale (default: 7.5)
- `-s, --seed`: Random seed (-1 for random)
- `--sampling-method`: Sampler (euler_a, euler, heun, etc.)
- `-o, --output`: Output file path
- `-t, --threads`: Number of threads
- `--n-gpu-layers`: Number of layers to offload to GPU

**Progress Output**:
```
step 1/20
step 2/20
...
```

### B. Comparison with LlamaServerManager

| Aspect | LlamaServerManager | DiffusionServerManager |
|--------|-------------------|------------------------|
| Binary Type | Native HTTP server | One-shot executable |
| HTTP Server | Spawned directly | Created by us (Node http) |
| Process Lifecycle | Long-running | Short-lived (per generation) |
| Health Check | Via /health endpoint | HTTP server availability |
| Progress Tracking | Via streaming response | Parse stdout |
| Resource Usage | Continuous | Per-request |

### C. Binary Variants and SHA Extraction

**stable-diffusion.cpp Binary Structure** (Similar to llama.cpp):

Like llama.cpp, stable-diffusion.cpp provides **multiple variants per platform** with different acceleration backends:

| Platform | Variants Available | Notes |
|----------|-------------------|-------|
| Windows x64 | CUDA12, Vulkan, AVX512, AVX2, AVX, No-AVX | 6 variants for different GPUs/CPUs |
| macOS ARM64 | Metal (single binary) | All Apple Silicon Macs support Metal |
| Linux x64 | CPU/CUDA hybrid (single binary) | Detects CUDA at runtime if available |

**Example Release Files** (master-db6f479):
```
sd-master-db6f479-bin-win-cuda12-x64.zip     (Windows CUDA)
sd-master-db6f479-bin-win-vulkan-x64.zip     (Windows Vulkan)
sd-master-db6f479-bin-win-avx2-x64.zip       (Windows CPU AVX2)
sd-master--bin-Darwin-macOS-15.6.1-arm64.zip (macOS Metal)
sd-master--bin-Linux-Ubuntu-24.04-x86_64.zip (Linux CPU/CUDA)
```

**How to Extract SHA256 Checksums from GitHub**:

stable-diffusion.cpp releases display checksums on the release page:

1. **Navigate** to release page (e.g., `.../releases/tag/master-db6f479`)
2. **Click "Show more assets"** to expand full list (GitHub truncates long lists!)
3. **Locate each binary file** in the expanded list
4. **Find the `sha256:` text** that appears below each filename
5. **Copy the 64-character hex hash** that follows `sha256:`

**Example pattern in GitHub UI**:
```html
sd-master-db6f479-bin-win-cuda12-x64.zip
sha256:abc123...def456 (64 characters)
```

**Detailed Extraction Methods**:
- **WebFetch**: Use Claude's WebFetch tool to fetch the release page
- **Manual HTML**: Download page HTML after clicking "Show more assets"
- **Parse Script**: Use Node.js script to extract from saved HTML

See `docs/dev/UPDATING-BINARIES.md` for:
- WebFetch prompt templates
- HTML parsing scripts
- Troubleshooting truncated asset lists
- Common checksum extraction issues

**Fallback Priority (BinaryManager Pattern)**:

BinaryManager tests each variant with `--version` and uses the first one that works:

```typescript
// Windows: Try GPU variants first, fall back to CPU
'win32-x64': [
  { type: 'cuda', url: '...cuda12-x64.zip', checksum: '...' },    // Test first
  { type: 'vulkan', url: '...vulkan-x64.zip', checksum: '...' },  // Test second
  { type: 'cpu', url: '...avx2-x64.zip', checksum: '...' },       // Test last
]

// macOS: Single variant (Metal)
'darwin-arm64': [
  { type: 'metal', url: '...arm64.zip', checksum: '...' },
]

// Linux: Single variant (CPU/CUDA hybrid)
'linux-x64': [
  { type: 'cpu', url: '...x86_64.zip', checksum: '...' },
]
```

**Why Variants Matter**:
- **CUDA**: Best performance on NVIDIA GPUs (requires CUDA runtime)
- **Vulkan**: Works on any GPU vendor (NVIDIA/AMD/Intel) with Vulkan drivers
- **AVX2/AVX512**: CPU-only fallback with SIMD optimizations
- **No-AVX**: Final fallback for very old CPUs (rare)

### D. Resource Estimation Formulas

**LLM (llama-server)**:
```
RAM usage = model_size * (1 - gpu_ratio) * 1.2  (20% overhead)
VRAM usage = model_size * gpu_ratio * 1.2
where gpu_ratio = gpu_layers / total_layers
```

**Diffusion (stable-diffusion.cpp)**:
```
RAM/VRAM usage = model_size * 1.2  (20% overhead)
```

**Offload Decision**:
```
if (is_gpu_system) {
  offload_needed = (llm_vram + diffusion_vram) > (total_vram * 0.75)
} else {
  offload_needed = (llm_ram + diffusion_ram) > (available_ram * 0.75)
}
```

### E. Testing Checklist

**Before Merging**:
- [ ] All TypeScript compiles (`npm run build`)
- [ ] All tests pass (`npm test`)
- [ ] Test coverage meets target (80%+)
- [ ] Manual testing on at least 2 platforms
- [ ] Documentation is complete
- [ ] No console warnings or errors
- [ ] Example app works (if testing with control-panel)

**Platform Testing**:
- [ ] macOS: Binary downloads, image generation works
- [ ] Windows: Variant testing (CUDA → Vulkan → CPU)
- [ ] Linux: CUDA variant works (if NVIDIA GPU available)

**Functional Testing**:
- [ ] Simple image generation (512x512, 20 steps)
- [ ] Large image generation (1024x1024, 50 steps)
- [ ] CPU-only generation works
- [ ] GPU-accelerated generation works
- [ ] Progress callbacks fire correctly
- [ ] Resource orchestration triggers when needed
- [ ] LLM restarts after image generation

---

**Document Version**: 1.0
**Last Updated**: 2025-10-17
**Status**: Ready for Implementation ✅
