# genai-electron Phase 1 Implementation Plan

> **Version**: 1.0
> **Created**: 2025-10-16
> **Status**: In Progress
> **Target**: Phase 1 MVP - LLM Support

---

## Table of Contents

1. [Overview](#overview)
2. [Technology Stack & Version Choices](#technology-stack--version-choices)
3. [Implementation Steps](#implementation-steps)
4. [Success Criteria](#success-criteria)
5. [Timeline](#timeline)
6. [Progress Tracking](#progress-tracking)

---

## Overview

This plan outlines the implementation of **genai-electron Phase 1 (MVP - LLM Support)**, an Electron-specific library for managing local AI model servers and resources. The library complements genai-lite by handling platform-specific operations required to run AI models locally on desktop systems.

### Phase 1 Scope

**What we're building:**
- ✅ System capability detection (RAM, CPU, GPU, VRAM)
- ✅ Model storage in userData directory
- ✅ Download models from direct URLs
- ✅ Start/stop llama-server with basic config
- ✅ Health checking and status monitoring
- ✅ Basic error handling
- ✅ TypeScript types and interfaces
- ✅ Basic documentation

**What's deferred to later phases:**
- ❌ Image generation (Phase 2)
- ❌ Resume interrupted downloads (Phase 3)
- ❌ HuggingFace integration beyond URL conversion (Phase 3)
- ❌ Auto-restart on crash (Phase 4)
- ❌ Shared storage configuration (Phase 4)

---

## Technology Stack & Version Choices

### Core Dependencies

#### Node.js: **22.x LTS** (Active LTS)
**Rationale:**
- Node.js 22.x entered Active LTS and is the current recommended version for production (October 2025)
- Supported until April 2027
- Required by Electron ecosystem (moving to Node 22 in early 2025)
- Native `fetch()` support (no need for external HTTP client)
- Modern features: ES2022+, import attributes, test runner

#### Electron: **34.x** (Peer Dependency)
**Rationale:**
- Latest stable release (v34.1.1 as of October 2025)
- Includes Chromium 132 and Node.js 20.18.1
- No traditional LTS, but latest 3 stable releases are supported (32, 33, 34)
- **Peer dependency only** - apps provide their own Electron version
- Minimum supported: `>=25.0.0` for broad compatibility

#### TypeScript: **^5.9.3**
**Rationale:**
- Latest stable version (October 2025)
- Deferred imports support (Stage 3 ECMAScript proposal)
- Stable node20 module option
- Leaner default tsconfig
- Minimum for Jest 30: 5.4+

### Development Dependencies

#### Jest: **^30.0.0** + ts-jest: **^29.4.5**
**Rationale:**
- Jest 30 released June 2025 with major improvements
- Native .mts and .cts support
- TypeScript config file support
- Noticeably faster, uses less memory
- Requires TypeScript 5.4+

#### ESLint: **^9.0.0** + typescript-eslint
**Rationale:**
- ESLint 9.x with flat config (eslint.config.mjs) is now standard
- typescript-eslint with recommended/strict configurations
- Eliminates legacy "extends" chains
- Better performance and clarity

#### Prettier: **^3.0.0**
**Rationale:**
- Latest stable for code formatting
- Integrates with ESLint via eslint-config-prettier

### Runtime Dependencies

**None for Phase 1 MVP** - Use Node.js built-ins:
- `fs/promises` - File operations
- `crypto` - SHA256 checksums
- `child_process` - Process spawning
- `os` - System information
- `events` - EventEmitter
- `path` - Path handling
- Native `fetch()` - HTTP downloads (Node 18+)

### Version Rationale Summary

| Dependency | Version | Rationale |
|------------|---------|-----------|
| Node.js | 22.x LTS | Active LTS, native fetch(), required by Electron ecosystem |
| Electron | 34.x (peer) | Latest stable, provide minimum >=25.0.0 for compatibility |
| TypeScript | ^5.9.3 | Latest stable, Jest 30 compatible, modern features |
| Jest | ^30.0.0 | Latest with performance improvements, native TS support |
| ESLint | ^9.0.0 | Flat config standard, modern linting |

---

## Implementation Steps

### Step 1: Project Scaffolding & Configuration

**Goal:** Initialize repository with essential configuration files

#### Tasks

- [ ] **1.1 Initialize package.json**
  - Name: `genai-electron`
  - Version: `0.1.0`
  - Description: "Electron-specific library for managing local AI model servers and resources"
  - Main entry: `dist/index.js`
  - Types: `dist/index.d.ts`
  - Peer dependency: `electron: ">=25.0.0"`
  - Dev dependencies:
    - `typescript: ^5.9.3`
    - `jest: ^30.0.0`
    - `ts-jest: ^29.4.5`
    - `@types/jest: ^30.0.0`
    - `@types/node: ^22.0.0`
    - `eslint: ^9.0.0`
    - `typescript-eslint: ^8.0.0`
    - `prettier: ^3.0.0`
    - `eslint-config-prettier: ^9.0.0`
  - Scripts:
    - `build`: `tsc`
    - `test`: `jest`
    - `test:watch`: `jest --watch`
    - `test:coverage`: `jest --coverage`
    - `lint`: `eslint .`
    - `lint:fix`: `eslint . --fix`
    - `format`: `prettier --write .`
    - `format:check`: `prettier --check .`

- [ ] **1.2 Configure TypeScript (tsconfig.json)**
  - Target: `ES2022` (Node 22 support)
  - Module: `node16` (Node.js ESM support)
  - Output directory: `dist/`
  - Source map: `true`
  - Declaration: `true` (generate .d.ts files)
  - Strict mode: `true` (all strict checks)
  - ESM interop: `esModuleInterop: true`
  - Include: `["src/**/*"]`
  - Exclude: `["node_modules", "dist", "tests"]`

- [ ] **1.3 Configure Jest (jest.config.js)**
  - Preset: `ts-jest`
  - Test environment: `node`
  - Test match: `**/__tests__/**/*.test.ts`
  - Coverage directory: `coverage/`
  - Coverage thresholds: `60%` for Phase 1
  - Collect coverage from: `src/**/*.ts`
  - Transform: `.ts` files with ts-jest

- [ ] **1.4 Configure ESLint (eslint.config.mjs)**
  - Flat config format (ESLint 9 standard)
  - Import `@eslint/js` and `typescript-eslint`
  - Use `typescript-eslint.configs.strict` (includes recommended + strict rules)
  - Ignore patterns: `dist/`, `coverage/`, `node_modules/`
  - Parser options: project `tsconfig.json`

- [ ] **1.5 Configure Prettier (.prettierrc)**
  - Semi: `true`
  - Single quote: `true`
  - Tab width: `2`
  - Trailing comma: `es5`
  - Print width: `100`
  - Arrow parens: `always`

- [ ] **1.6 Create .gitignore**
  - `node_modules/`
  - `dist/`
  - `coverage/`
  - `.env`
  - `.DS_Store`
  - `*.log`

- [ ] **1.7 Create .npmignore**
  - `src/`
  - `tests/`
  - `coverage/`
  - `.github/`
  - `*.test.ts`
  - `tsconfig.json`
  - `jest.config.js`
  - `eslint.config.mjs`

- [ ] **1.8 Create directory structure**
  ```
  genai-electron/
  ├── src/
  │   ├── managers/
  │   ├── system/
  │   ├── download/
  │   ├── process/
  │   ├── config/
  │   ├── types/
  │   ├── errors/
  │   └── utils/
  ├── tests/
  │   └── unit/
  ├── docs/
  └── examples/
  ```

- [ ] **1.9 Create README.md**
  - Basic overview
  - Link to DESIGN.md
  - Installation instructions (placeholder)
  - Quick start example (placeholder)
  - Link to full documentation

- [ ] **1.10 Create LICENSE**
  - MIT License

---

### Step 2: Core Type Definitions

**Goal:** Create TypeScript interfaces and types (foundation for everything)

#### Tasks

- [ ] **2.1 Create src/types/system.ts**
  - `GPUInfo` interface:
    - `available: boolean`
    - `type?: 'nvidia' | 'amd' | 'apple' | 'intel'`
    - `name?: string`
    - `vram?: number` (bytes)
    - `cuda?: boolean`
    - `metal?: boolean`
    - `rocm?: boolean`
    - `vulkan?: boolean`
  - `CPUInfo` interface:
    - `cores: number`
    - `model: string`
    - `architecture: string`
  - `MemoryInfo` interface:
    - `total: number` (bytes)
    - `available: number` (bytes)
    - `used: number` (bytes)
  - `SystemCapabilities` interface:
    - `cpu: CPUInfo`
    - `memory: MemoryInfo`
    - `gpu: GPUInfo`
    - `platform: NodeJS.Platform`
    - `recommendations: SystemRecommendations`
  - `SystemRecommendations` interface:
    - `maxModelSize: string` (e.g., "7B", "13B")
    - `recommendedQuantization: string[]`
    - `threads: number`
    - `gpuLayers?: number`

- [ ] **2.2 Create src/types/models.ts**
  - `ModelType` type: `'llm' | 'diffusion'`
  - `ModelInfo` interface:
    - `id: string`
    - `name: string`
    - `type: ModelType`
    - `size: number` (bytes)
    - `path: string`
    - `downloadedAt: string` (ISO date)
    - `source: ModelSource`
    - `checksum?: string`
  - `ModelSource` interface:
    - `type: 'huggingface' | 'url'`
    - `url: string`
    - `repo?: string` (for HuggingFace)
    - `file?: string` (for HuggingFace)
  - `DownloadConfig` interface:
    - `source: 'huggingface' | 'url'`
    - `url?: string`
    - `repo?: string`
    - `file?: string`
    - `name: string`
    - `type: ModelType`
    - `checksum?: string`
    - `onProgress?: (downloaded: number, total: number) => void`
  - `DownloadProgress` interface:
    - `downloaded: number` (bytes)
    - `total: number` (bytes)
    - `percentage: number`
    - `speed: number` (bytes/sec)

- [ ] **2.3 Create src/types/servers.ts**
  - `ServerStatus` type: `'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'`
  - `HealthStatus` type: `'ok' | 'loading' | 'error' | 'unknown'`
  - `ServerConfig` interface:
    - `modelId: string`
    - `port: number`
    - `threads?: number`
    - `contextSize?: number`
    - `gpuLayers?: number`
    - `parallelRequests?: number`
    - `flashAttention?: boolean`
  - `ServerInfo` interface:
    - `status: ServerStatus`
    - `health: HealthStatus`
    - `pid?: number`
    - `port: number`
    - `modelId: string`
    - `startedAt?: string` (ISO date)
  - `LlamaServerConfig` extends `ServerConfig`:
    - Additional llama-specific options

- [ ] **2.4 Create src/types/index.ts**
  - Export all types from system, models, servers
  - Export utility types (e.g., `Optional<T>`, `RequiredKeys<T>`)

---

### Step 3: Error Handling System

**Goal:** Implement custom error classes with actionable messages

#### Tasks

- [ ] **3.1 Create src/errors/index.ts**
  - `GenaiElectronError` base class:
    - Extends `Error`
    - Properties: `code: string`, `details?: unknown`
    - Constructor: `(message: string, code: string, details?: unknown)`
  - `ModelNotFoundError` extends `GenaiElectronError`:
    - Code: `MODEL_NOT_FOUND`
    - Constructor: `(modelId: string)`
  - `DownloadError` extends `GenaiElectronError`:
    - Code: `DOWNLOAD_FAILED`
    - Constructor: `(message: string, details?: unknown)`
  - `InsufficientResourcesError` extends `GenaiElectronError`:
    - Code: `INSUFFICIENT_RESOURCES`
    - Constructor: `(message: string, details: { required: string, available: string, suggestion?: string })`
  - `ServerError` extends `GenaiElectronError`:
    - Code: `SERVER_ERROR`
    - Constructor: `(message: string, details?: unknown)`
  - `PortInUseError` extends `GenaiElectronError`:
    - Code: `PORT_IN_USE`
    - Constructor: `(port: number)`

- [ ] **3.2 Add JSDoc comments to all error classes**
  - Description of when error is thrown
  - Example usage
  - Suggested remediation

---

### Step 4: Configuration & Utilities

**Goal:** Set up configuration constants and utility functions

#### Tasks

- [ ] **4.1 Create src/config/paths.ts**
  - Import `app` from `electron`
  - `BASE_DIR`: `app.getPath('userData')`
  - `PATHS` object:
    - `models.llm`: `path.join(BASE_DIR, 'models', 'llm')`
    - `models.diffusion`: `path.join(BASE_DIR, 'models', 'diffusion')`
    - `binaries`: `path.join(BASE_DIR, 'binaries')`
    - `logs`: `path.join(BASE_DIR, 'logs')`
    - `config`: `path.join(BASE_DIR, 'config')`
  - `ensureDirectories()` function to create all directories

- [ ] **4.2 Create src/config/defaults.ts**
  - `DEFAULT_PORTS`:
    - `llama: 8080`
    - `diffusion: 8081`
  - `DEFAULT_TIMEOUTS`:
    - `download: 300000` (5 minutes)
    - `serverStart: 60000` (1 minute)
    - `serverStop: 10000` (10 seconds)
    - `healthCheck: 5000` (5 seconds)
  - `DEFAULT_SERVER_CONFIG`:
    - `threads`: Auto-detect
    - `contextSize: 4096`
    - `parallelRequests: 4`
  - `BINARY_VERSIONS`: Pinned llama.cpp and diffusion.cpp versions
    - `llamaServer.version`: Specific commit/tag
    - `llamaServer.urls`: Platform-specific URLs
    - `llamaServer.checksums`: SHA256 per platform

- [ ] **4.3 Create src/utils/platform-utils.ts**
  - `getPlatform()`: Returns normalized platform string
  - `getArchitecture()`: Returns architecture (x64, arm64)
  - `getPlatformKey()`: Returns key like `darwin-arm64`
  - `isWindows()`, `isMac()`, `isLinux()` helpers

- [ ] **4.4 Create src/utils/file-utils.ts**
  - `ensureDirectory(path)`: Create directory if not exists
  - `fileExists(path)`: Check if file exists
  - `getFileSize(path)`: Get file size in bytes
  - `deleteFile(path)`: Delete file safely
  - `moveFile(from, to)`: Move file atomically
  - `calculateChecksum(path)`: Calculate SHA256 of file

---

### Step 5: SystemInfo Module

**Goal:** Implement system capability detection

#### Tasks

- [ ] **5.1 Create src/system/memory-detect.ts**
  - `getMemoryInfo()`: Returns `MemoryInfo`
    - Use `os.totalmem()` for total
    - Use `os.freemem()` for available
    - Calculate used: `total - available`
  - `estimateVRAM()`: Estimate VRAM (placeholder for Phase 1)
    - macOS: Assume unified memory (use RAM)
    - Windows/Linux: Attempt nvidia-smi parsing
    - Return `null` if unable to detect

- [ ] **5.2 Create src/system/cpu-detect.ts**
  - `getCPUInfo()`: Returns `CPUInfo`
    - Use `os.cpus()` for core count and model
    - Use `os.arch()` for architecture
  - `getRecommendedThreads()`: Calculate optimal thread count
    - Formula: `Math.max(1, cpuCount - 1)` (leave one for OS)

- [ ] **5.3 Create src/system/gpu-detect.ts**
  - `detectGPU()`: Returns `GPUInfo`
  - macOS implementation:
    - Check for Metal support (assume true for modern Macs)
    - Type: `'apple'`
    - Metal: `true`
  - Windows implementation:
    - Try `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader`
    - Parse output for GPU name and VRAM
    - Type: `'nvidia'`, CUDA: `true`
    - Fallback: `{ available: false }`
  - Linux implementation:
    - Try nvidia-smi (NVIDIA)
    - Try rocm-smi (AMD)
    - Check /sys/class/drm for Intel
    - Fallback: `{ available: false }`

- [ ] **5.4 Create src/system/SystemInfo.ts**
  - Main class with singleton pattern
  - `detect()`: Gather all capabilities
    - Call `getCPUInfo()`, `getMemoryInfo()`, `detectGPU()`
    - Generate recommendations based on hardware
    - Cache results for 60 seconds
  - `getMemoryInfo()`: Real-time memory check
  - `canRunModel(modelInfo)`: Validate if model can run
    - Check if available RAM/VRAM >= model size
    - Return boolean + reason if false
  - `getOptimalConfig(modelInfo)`: Recommend server config
    - Calculate threads, GPU layers, context size
    - Return `ServerConfig` object

- [ ] **5.5 Add unit tests for SystemInfo**
  - Mock `os` module functions
  - Mock `child_process.exec` for GPU detection
  - Test cache behavior
  - Test recommendation logic

---

### Step 6: StorageManager

**Goal:** Implement file system operations

#### Tasks

- [ ] **6.1 Create src/managers/StorageManager.ts**
  - `initialize()`: Create directory structure
    - Call `ensureDirectories()` from paths config
  - `getModelPath(type, filename)`: Build model file path
  - `getModelMetadataPath(type, modelId)`: Build metadata path
  - `saveModelMetadata(modelInfo)`: Save metadata as JSON
  - `loadModelMetadata(type, modelId)`: Load metadata from JSON
  - `deleteModelFiles(type, modelId)`: Delete model + metadata
  - `listModelFiles(type)`: List all models in directory
  - `checkDiskSpace(path)`: Check available disk space
    - Use `fs.statfs()` on Linux/macOS
    - Use `wmic` on Windows (fallback to skip check)
  - `verifyModelIntegrity(path, checksum)`: Verify file checksum
    - Calculate SHA256 of file
    - Compare with expected checksum

- [ ] **6.2 Add unit tests for StorageManager**
  - Mock `fs/promises` functions
  - Test metadata save/load
  - Test directory creation
  - Test disk space calculation

---

### Step 7: ModelManager

**Goal:** Implement model download and management

#### Tasks

- [ ] **7.1 Create src/download/checksum.ts**
  - `calculateSHA256(filePath)`: Calculate file checksum
    - Use `crypto.createHash('sha256')`
    - Stream file to avoid loading entire file in memory
    - Return hex string

- [ ] **7.2 Create src/download/huggingface.ts**
  - `getHuggingFaceURL(repo, file)`: Convert to direct URL
    - Format: `https://huggingface.co/${repo}/resolve/main/${file}`
  - `parseHuggingFaceURL(url)`: Extract repo and file from URL
    - Return `{ repo, file }` or `null`

- [ ] **7.3 Create src/download/Downloader.ts**
  - Main downloader class
  - `download(config)`: Download file with progress
    - Use native `fetch()` for HTTP request
    - Stream response to file using `fs.createWriteStream()`
    - Track progress: `downloaded / total`
    - Call `onProgress` callback periodically
    - Save to `.partial` file during download
    - Move to final location on completion
    - Handle errors and cleanup partial files
  - `cancel()`: Abort ongoing download
  - Note: Resume capability deferred to Phase 3

- [ ] **7.4 Create src/managers/ModelManager.ts**
  - Main model management class
  - `listModels(type?)`: List installed models
    - Use `StorageManager.listModelFiles()`
    - Load metadata for each model
    - Filter by type if specified
  - `downloadModel(config)`: Download model
    - Validate config
    - Check disk space via `StorageManager`
    - Determine URL (direct or HuggingFace)
    - Use `Downloader` to download
    - Verify checksum if provided
    - Save metadata via `StorageManager`
    - Return `ModelInfo`
  - `deleteModel(id)`: Delete model
    - Find model by ID
    - Delete files via `StorageManager`
  - `getModelInfo(id)`: Get model metadata
    - Load from storage
    - Return `ModelInfo` or throw `ModelNotFoundError`
  - `verifyModel(id)`: Verify model integrity
    - Load metadata
    - Calculate checksum
    - Compare with stored checksum

- [ ] **7.5 Add unit tests for ModelManager**
  - Mock `fetch()` for downloads
  - Mock `fs` operations
  - Test download success/failure scenarios
  - Test model listing and deletion
  - Test checksum verification

---

### Step 8: LlamaServerManager

**Goal:** Implement llama-server lifecycle management

#### Tasks

- [ ] **8.1 Create src/process/ProcessManager.ts**
  - Base class for process management
  - `spawn(command, args, options)`: Spawn child process
    - Use `child_process.spawn()`
    - Capture stdout/stderr
    - Monitor exit codes
  - `kill(pid, signal)`: Kill process
    - Try SIGTERM first
    - Wait for graceful shutdown (timeout)
    - Force SIGKILL if necessary
  - `isRunning(pid)`: Check if process is running
    - Try `process.kill(pid, 0)` (no signal, just check)

- [ ] **8.2 Create src/process/health-check.ts**
  - `checkHealth(port)`: Poll /health endpoint
    - Use `fetch()` to check `http://localhost:${port}/health`
    - Parse response: `{ status: 'ok' | 'loading' | 'error' }`
    - Return `HealthStatus`
  - `waitForHealthy(port, timeout)`: Wait until healthy
    - Poll with exponential backoff
    - Resolve when status is 'ok'
    - Reject on timeout

- [ ] **8.3 Create src/process/log-manager.ts**
  - Basic log capture for Phase 1 (no rotation yet)
  - `LogManager` class:
    - `write(message)`: Append to log file
    - `getRecent(lines)`: Get last N lines
    - `clear()`: Clear log file
  - Log format: `[timestamp] [level] message`

- [ ] **8.4 Create src/managers/ServerManager.ts**
  - Abstract base class for server management
  - Extends `EventEmitter`
  - Properties:
    - `status: ServerStatus`
    - `pid?: number`
    - `port: number`
    - `config: ServerConfig`
  - Abstract methods:
    - `start(config): Promise<ServerInfo>`
    - `stop(): Promise<void>`
  - Common methods:
    - `restart()`: Call stop then start
    - `getStatus()`: Return current status
    - `emit` events: 'started', 'stopped', 'crashed'

- [ ] **8.5 Create src/managers/LlamaServerManager.ts**
  - Extends `ServerManager`
  - `start(config)`:
    - Validate model exists via `ModelManager`
    - Check if binary exists, download if needed
      - Determine platform and architecture
      - Get URL from `BINARY_VERSIONS` config
      - Download to `PATHS.binaries`
      - Verify checksum
      - Save version info
    - Check RAM/VRAM availability via `SystemInfo`
    - Auto-configure threads and GPU layers if not specified
    - Build command-line arguments for llama-server
    - Spawn process via `ProcessManager`
    - Wait for health check via `waitForHealthy()`
    - Set status to 'running'
    - Return `ServerInfo`
  - `stop()`:
    - Set status to 'stopping'
    - Send SIGTERM to process
    - Wait for graceful shutdown (10s timeout)
    - Force SIGKILL if timeout
    - Set status to 'stopped'
  - `isHealthy()`: Check server health
    - Call `checkHealth()` utility
  - `getLogs()`: Get recent logs
    - Return last 100 lines from log file

- [ ] **8.6 Add unit tests for LlamaServerManager**
  - Mock `child_process.spawn()`
  - Mock `fetch()` for health checks
  - Test start/stop lifecycle
  - Test auto-configuration logic
  - Test error scenarios (port in use, model not found)

---

### Step 9: Main API Entry Point

**Goal:** Create public API surface

#### Tasks

- [ ] **9.1 Create src/index.ts**
  - Import all managers and utilities
  - Export singleton instances:
    ```typescript
    export const modelManager = new ModelManager();
    export const llamaServer = new LlamaServerManager();
    export const systemInfo = new SystemInfo();
    ```
  - Export classes for advanced usage:
    ```typescript
    export { ModelManager } from './managers/ModelManager';
    export { LlamaServerManager } from './managers/LlamaServerManager';
    export { SystemInfo } from './system/SystemInfo';
    ```
  - Export all types from `./types`
  - Export all errors from `./errors`
  - Add JSDoc with library description and examples

---

### Step 10: Basic Testing

**Goal:** Set up initial test suite

#### Tasks

- [ ] **10.1 Create tests/unit/SystemInfo.test.ts**
  - Mock `os` module functions
  - Mock `child_process.exec` for GPU detection
  - Test `detect()` method
  - Test cache behavior (should not re-detect within 60s)
  - Test `canRunModel()` validation
  - Test `getOptimalConfig()` recommendations

- [ ] **10.2 Create tests/unit/ModelManager.test.ts**
  - Mock `fetch()` for downloads
  - Mock `fs/promises` for file operations
  - Test `listModels()` with empty directory
  - Test `listModels()` with existing models
  - Test `downloadModel()` success
  - Test `downloadModel()` failure (network error)
  - Test `deleteModel()` success
  - Test `verifyModel()` with matching checksum
  - Test `verifyModel()` with mismatched checksum

- [ ] **10.3 Create tests/unit/StorageManager.test.ts**
  - Mock `fs/promises` functions
  - Test `initialize()` directory creation
  - Test `saveModelMetadata()` and `loadModelMetadata()`
  - Test `deleteModelFiles()` removes both model and metadata
  - Test `checkDiskSpace()` returns valid values
  - Test `verifyModelIntegrity()` checksum validation

- [ ] **10.4 Create tests/unit/Downloader.test.ts**
  - Mock `fetch()` with streaming response
  - Mock `fs.createWriteStream()`
  - Test download progress callbacks
  - Test partial file creation during download
  - Test file move on completion
  - Test error handling and cleanup

- [ ] **10.5 Create tests/unit/LlamaServerManager.test.ts**
  - Mock `child_process.spawn()`
  - Mock `fetch()` for health checks
  - Mock `ModelManager.getModelInfo()`
  - Test `start()` with auto-configuration
  - Test `start()` with custom config
  - Test `start()` failure (model not found)
  - Test `start()` failure (port in use)
  - Test `stop()` graceful shutdown
  - Test `stop()` force kill after timeout
  - Test `isHealthy()` returns correct status

- [ ] **10.6 Run tests and achieve 60%+ coverage**
  - `npm run test:coverage`
  - Review coverage report
  - Add tests for uncovered branches
  - Target: 60%+ overall coverage

---

### Step 11: Basic Documentation

**Goal:** Create initial documentation

#### Tasks

- [ ] **11.1 Update README.md**
  - Overview: What is genai-electron?
  - Features list (Phase 1)
  - Installation: `npm install genai-electron`
  - Peer dependency: `npm install electron@>=25.0.0`
  - Quick start example:
    ```typescript
    import { systemInfo, modelManager, llamaServer } from 'genai-electron';

    // Detect system
    const capabilities = await systemInfo.detect();

    // Download model
    await modelManager.downloadModel({
      source: 'url',
      url: 'https://example.com/model.gguf',
      name: 'My Model',
      type: 'llm'
    });

    // Start server
    await llamaServer.start({
      modelId: 'my-model',
      port: 8080
    });
    ```
  - Link to API.md for full reference
  - Link to DESIGN.md for architecture details

- [ ] **11.2 Create docs/API.md**
  - Complete API reference for Phase 1
  - Sections:
    - SystemInfo
      - `detect()`
      - `getMemoryInfo()`
      - `canRunModel()`
      - `getOptimalConfig()`
    - ModelManager
      - `listModels()`
      - `downloadModel()`
      - `deleteModel()`
      - `getModelInfo()`
      - `verifyModel()`
    - LlamaServerManager
      - `start()`
      - `stop()`
      - `restart()`
      - `getStatus()`
      - `isHealthy()`
      - `getLogs()`
    - Types and Interfaces
    - Error Classes
  - Include TypeScript signatures
  - Include example usage for each method

- [ ] **11.3 Create docs/SETUP.md**
  - Development setup instructions:
    - Prerequisites: Node.js 22+, Electron 25+
    - Clone repository
    - Install dependencies: `npm install`
    - Build: `npm run build`
    - Test: `npm test`
    - Lint: `npm run lint`
  - Environment setup
  - Platform-specific notes:
    - macOS: Xcode command line tools
    - Windows: Visual Studio Build Tools
    - Linux: build-essential
  - Troubleshooting common issues

---

### Step 12: Simple Example (Optional)

**Goal:** Create minimal Node.js example

#### Tasks

- [ ] **12.1 Create examples/simple-example/**
  - `package.json`: Electron app with genai-electron dependency
  - `main.js`: Electron main process
  - `index.html`: Simple UI (optional)
  - Example workflow:
    1. Detect system capabilities
    2. Download a small test model (~100MB)
    3. Start llama-server
    4. Make a test request via genai-lite
    5. Stop server
  - README with instructions

---

## Success Criteria

**Phase 1 MVP is complete when:**

- ✅ **Functionality**:
  - Can detect system capabilities (RAM, CPU, GPU) on all platforms
  - Can download GGUF models from direct URLs
  - Can start llama-server with basic configuration
  - Can perform health checks and monitor server status
  - Can stop server cleanly with graceful shutdown

- ✅ **Code Quality**:
  - 60%+ test coverage
  - All tests passing
  - No ESLint errors
  - Formatted with Prettier

- ✅ **Documentation**:
  - README with overview and quick start
  - API.md with complete API reference
  - SETUP.md with development instructions

- ✅ **Integration**:
  - Works with genai-lite in an Electron app
  - Can make requests to started llama-server
  - Error handling provides clear, actionable messages

---

## Timeline

**Total Duration**: 2-3 weeks

**Week 1**: Steps 1-5
- Project scaffolding and configuration (Days 1-2)
- Core type definitions and error handling (Day 3)
- Configuration and utilities (Day 4)
- SystemInfo module implementation (Days 5-7)

**Week 2**: Steps 6-8
- StorageManager (Days 8-9)
- ModelManager with download support (Days 10-12)
- LlamaServerManager with process management (Days 13-14)

**Week 3**: Steps 9-12
- Main API entry point (Day 15)
- Comprehensive testing (Days 16-18)
- Documentation (Days 19-20)
- Simple example and final polish (Days 21+)

---

## Progress Tracking

### Overall Progress

- [ ] **Step 1**: Project Scaffolding & Configuration
- [ ] **Step 2**: Core Type Definitions
- [ ] **Step 3**: Error Handling System
- [ ] **Step 4**: Configuration & Utilities
- [ ] **Step 5**: SystemInfo Module
- [ ] **Step 6**: StorageManager
- [ ] **Step 7**: ModelManager
- [ ] **Step 8**: LlamaServerManager
- [ ] **Step 9**: Main API Entry Point
- [ ] **Step 10**: Basic Testing
- [ ] **Step 11**: Basic Documentation
- [ ] **Step 12**: Simple Example (Optional)

### Current Status

**Last Updated**: 2025-10-16

**Status**: Not Started

**Next Action**: Begin Step 1 - Project Scaffolding & Configuration

---

## Notes

### Key Technical Decisions

1. **No runtime dependencies**: Use Node.js built-ins for Phase 1 (fs, crypto, child_process, os, path, fetch)
2. **Download binaries on first run**: Not bundled in npm package (keeps package size small)
3. **Per-app storage**: Each Electron app has isolated models in its userData directory
4. **TypeScript-first**: Full type safety throughout
5. **Event-driven**: Use EventEmitter for server lifecycle events

### Deferred to Future Phases

- Resume interrupted downloads (Phase 3)
- SHA256 checksum verification (Phase 3, basic verify in Phase 1)
- HuggingFace Hub API integration (Phase 3, basic URL conversion in Phase 1)
- Auto-restart on crash (Phase 4)
- Log rotation (Phase 4)
- Shared storage configuration (Phase 4)
- Image generation support (Phase 2)
- Multi-server support (Phase 5)

### References

- DESIGN.md: Complete architecture and design document
- genai-lite README: Integration patterns and API usage
- llama.cpp: https://github.com/ggml-org/llama.cpp
- Electron docs: https://www.electronjs.org/docs
