# genai-electron Design Document

> **Version**: 0.1.0-draft
> **Last Updated**: 2025-10-15
> **Status**: Design Phase

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Library Naming](#library-naming)
3. [Goals & Non-Goals](#goals--non-goals)
4. [Architecture](#architecture)
5. [Storage Strategy](#storage-strategy)
6. [API Design](#api-design)
7. [Example Application](#example-application)
8. [Technical Decisions](#technical-decisions)
9. [Implementation Phases](#implementation-phases)
10. [Project Structure](#project-structure)
11. [Dependencies](#dependencies)
12. [Testing Strategy](#testing-strategy)
13. [Documentation Plan](#documentation-plan)
14. [Platform Support](#platform-support)
15. [Next Steps](#next-steps)
16. [Appendix](#appendix)

---

## Project Overview

### Purpose

`genai-electron` is an Electron-specific library for managing local AI model servers and resources. It complements `genai-lite` by handling the platform-specific heavy lifting required to run AI models locally on desktop systems.

### The Ecosystem Split

**genai-lite** (existing):
- Lightweight, portable API abstraction layer
- Works in any Node.js environment
- Handles API communication with AI providers (cloud and local)
- For local models, communicates with HTTP servers managed by genai-electron
- **Note**: Image generation API is not yet implemented but will be developed concurrently with genai-electron, following the same provider abstraction pattern as the LLM API

**genai-electron** (this project):
- Electron-specific runtime management
- Downloads and manages GGUF model files
- Launches and monitors server processes (llama-server) or creates HTTP wrappers (stable-diffusion.cpp)
- System resource detection and optimization
- Requires filesystem access and process management
- Provides symmetric HTTP interfaces for both LLM and image generation to genai-lite

### Relationship Diagram

```
┌────────────────────────────────────────────────┐
│           Electron Application                 │
│                                                │
│  ┌────────────────┐      ┌──────────────────┐  │
│  │  genai-lite    │      │ genai-electron   │  │
│  │  (API layer)   │◄─────│ (Server manager) │  │
│  │                │      │                  │  │
│  │ • sendMessage  │      │ • downloadModel  │  │
│  │ • providers    │      │ • startServer    │  │
│  │ • templates    │      │ • stopServer     │  │
│  │ • generateImage│      │ • getStatus      │  │
│  │   (future)     │      │                  │  │
│  └────────┬───────┘      └────────┬─────────┘  │
│           │                       │            │
└───────────┼───────────────────────┼────────────┘
            │                       │
            │                       │ spawns/manages
            │ HTTP requests         ▼
            │              ┌─────────────────────┐
            └─────────────►│  llama-server       │
                           │  (port 8080)        │
                           │  [native server]    │
                           └─────────────────────┘
                           ┌─────────────────────┐
                           │  HTTP wrapper       │
                           │  (port 8081)        │
                           │  [created by        │
                           │   genai-electron]   │
                           │    ↓ spawns         │
                           │  stable-diffusion   │
                           │  .cpp executable    │
                           └─────────────────────┘
```

**Key Architecture Points:**
- **Symmetry**: From genai-lite's perspective, both are HTTP endpoints on localhost
- **llama-server**: Native HTTP server from llama.cpp (managed by genai-electron)
- **diffusion wrapper**: HTTP server created by genai-electron that spawns stable-diffusion.cpp executable on demand
- **Clean separation**: genai-lite has no knowledge of which servers are native vs. wrappers

### Key Value Propositions

1. **One-click local AI**: Users don't need to manually manage servers or download models
2. **Smart defaults**: Auto-detect system capabilities and optimize settings
3. **Unified management**: Single API for both LLM and image generation servers
4. **Production-ready**: Robust error handling, logging, and resource management
5. **Privacy-focused**: Everything runs locally, no data leaves the user's machine

---

## Library Naming

### Recommended Name: `genai-electron`

**Rationale**:
- ✅ Simple, clean, memorable
- ✅ Pairs perfectly with `genai-lite` (lite = portable, electron = desktop runtime)
- ✅ Follows the genai-[variant] pattern
- ✅ Allows future scope expansion beyond just servers
- ✅ Short and easy to type

**Alternative Options Considered**:

| Name | Pros | Cons | Verdict |
|------|------|------|---------|
| `genai-electron` | Simple, clean, flexible scope | Less explicit about purpose | ⭐ **Recommended** |
| `genai-electron-server` | Clear purpose, natural word order | Longer, constrains scope | ✅ Also good |
| `genai-server-electron` | Clear, descriptive | Awkward word order | ✅ Acceptable |
| `genai-runtime` | Short, clear purpose | Doesn't indicate Electron | ❌ Missing key info |
| `genai-local-electron` | Emphasizes local AI | "local" is redundant | ❌ Unnecessary word |

**Decision**: Use `genai-electron` unless there's strong preference for `genai-electron-server`.

---

## Goals & Non-Goals

### Goals (What This Library WILL Do)

**Core Functionality**:
- ✅ Download GGUF model files from remote sources (HuggingFace, direct URLs)
- ✅ Manage model storage in Electron's userData directory
- ✅ Start/stop llama-server processes with configurable settings
- ✅ Start/stop diffusion.cpp processes for image generation
- ✅ Monitor server health and status
- ✅ Auto-detect system capabilities (RAM, CPU, GPU)
- ✅ Provide progress callbacks for long-running operations
- ✅ Handle server crashes and automatic restarts
- ✅ Clean shutdown and resource cleanup
- ✅ Comprehensive error handling and logging

**Developer Experience**:
- ✅ TypeScript-first with full type safety
- ✅ Well-documented API with examples
- ✅ Integration examples with genai-lite
- ✅ Sensible defaults for non-technical users
- ✅ Advanced configuration for power users

**Platform Support**:
- ✅ macOS (Intel and Apple Silicon with Metal)
- ✅ Windows (CPU and CUDA support)
- ✅ Linux (CPU, CUDA, and ROCm support)

### Non-Goals (What This Library WON'T Do)

**Out of Scope**:
- ❌ Not a general-purpose AI API client (that's genai-lite's job)
- ❌ Not a UI framework (apps build their own UI)
- ❌ Not a model training tool
- ❌ Not a model conversion tool (GGUF conversion is separate)
- ❌ Not a cloud API manager (use genai-lite directly)
- ❌ Not a web framework (Electron-only)
- ❌ Not a model marketplace or curation service
- ❌ Not responsible for API key management (genai-lite handles that)

**Explicit Boundaries**:
- This library **starts and stops servers**; genai-lite **talks to those servers**
- This library **downloads models**; users or other tools **convert models to GGUF**
- This library **detects GPU**; it doesn't **install CUDA/Metal drivers**
- This library **provides APIs**; apps **build their own UI**

---

## Architecture

### High-Level Components

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
│  │ • delete       │  │ • start/stop    │  │ • getCPU │  │
│  │ • getInfo      │  │ • getStatus     │  │          │  │
│  └────────────────┘  └─────────────────┘  └──────────┘  │
│           │                   │                  │      │
│           └───────────────────┴──────────────────┘      │
│                               │                         │
│                    ┌──────────▼──────────┐              │
│                    │  StorageManager     │              │
│                    │                     │              │
│                    │ • userData paths    │              │
│                    │ • disk space        │              │
│                    │ • file verification │              │
│                    └─────────────────────┘              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Core Modules

#### 1. ModelManager

**Responsibilities**:
- List installed models
- Download models from remote sources
- Verify model integrity (checksums)
- Delete models
- Get model metadata (size, type, capabilities)

**Key Features**:
- Resume interrupted downloads
- Parallel download chunks (optional)
- Progress tracking
- Automatic retry on failure
- SHA256 verification

#### 2. ServerManager

**Responsibilities**:
- Abstract base class for server management
- Process lifecycle (spawn, monitor, kill)
- Port management
- Health checking
- Log capture

**Two Different Implementations**:

1. **LlamaServerManager** - Manages llama-server processes
   - llama-server is a native HTTP server from llama.cpp
   - genai-electron spawns and monitors the llama-server process
   - Clients (genai-lite) connect directly to llama-server's HTTP API

2. **DiffusionServerManager** - Creates HTTP wrapper for stable-diffusion.cpp
   - stable-diffusion.cpp is a one-shot executable (not a server)
   - genai-electron creates its own HTTP server (Express/Fastify)
   - On image generation requests, spawns stable-diffusion.cpp executable
   - Returns results via HTTP response
   - Provides same HTTP interface pattern as llama-server for symmetry

**Key Features**:
- Auto-restart on crash
- Graceful shutdown with timeout
- Port conflict detection
- Resource monitoring
- Structured logging
- Automatic reasoning flag injection for compatible models

#### 3. SystemInfo

**Responsibilities**:
- Detect system capabilities
- Provide hardware recommendations
- Check resource availability

**Detects**:
- Total RAM and available RAM
- CPU cores and architecture
- GPU type (NVIDIA CUDA, AMD ROCm, Apple Metal, Intel)
- GPU VRAM (total and available)
- Disk space

#### 4. StorageManager

**Responsibilities**:
- Manage file paths in userData directory
- Check disk space
- File verification
- Cleanup operations

**Directory Structure (Per-App)**:

This structure exists **within each Electron app's userData directory**. For example, an app called "MyAIChatApp" would have:

**Example on macOS**:
```
~/Library/Application Support/MyAIChatApp/     ← App-specific userData
├── models/
│   ├── llm/
│   │   ├── llama-2-7b-q4.gguf
│   │   └── mistral-7b-q5.gguf
│   └── diffusion/
│       └── sdxl-turbo-q4.gguf
├── binaries/
│   ├── llama/                    (llama.cpp binaries + DLLs)
│   │   ├── llama-server
│   │   ├── ggml-metal.metal      (macOS Metal shader)
│   │   └── .variant.json         (variant cache)
│   └── diffusion/                (stable-diffusion.cpp binaries + DLLs, Phase 2)
│       ├── stable-diffusion
│       └── .variant.json
├── logs/
│   ├── llama-server.log
│   └── diffusion-cpp.log
└── config/
    └── settings.json
```

**Important**: Different apps using genai-electron will each have their own separate directory structure. This means models may be duplicated across apps (see [Storage Strategy](#storage-strategy) section for details and future plans).

### Data Flow

#### Typical Usage Flow

```
1. App Startup
   └─► SystemInfo.detect() → Get capabilities
   └─► ModelManager.listModels() → Check available models
   └─► If no models → Guide user to download

2. Model Download
   └─► ModelManager.downloadModel(config)
       └─► Check disk space (StorageManager)
       └─► Download with progress
       └─► Verify checksum
       └─► Save to userData/models/

3. Server Start
   └─► LlamaServerManager.start(config)
       └─► Check model exists (ModelManager)
       └─► Check RAM/VRAM availability (SystemInfo)
       └─► Auto-configure GPU layers (SystemInfo)
       └─► Spawn llama-server process
       └─► Wait for health check
       └─► Return server info (port, pid)

4. Use with genai-lite
   └─► LLMService.sendMessage({ providerId: 'llamacpp', ... })
       └─► Talks to localhost:8080 (managed by genai-electron)

5. App Shutdown
   └─► ServerManager.stopAll()
       └─► Graceful shutdown (SIGTERM)
       └─► Force kill after timeout
       └─► Cleanup resources
```

#### Image Generation with Resource Management

This flow demonstrates intelligent resource orchestration when system resources are constrained. The library automatically detects which resource (RAM or VRAM) is the bottleneck and manages it accordingly.

**Example Scenario**: GPU system with 8GB VRAM, where both models compete for VRAM:
- **GPU available**: NVIDIA RTX 3070 with 8GB VRAM
- **System RAM**: 16GB (sufficient for process overhead)
- **Bottleneck**: VRAM (both models want GPU acceleration)

```
1. Starting State
   └─► llama-server is RUNNING with Llama-2-7B
       └─► Using 6GB VRAM (35 layers offloaded to GPU)
       └─► Using 1GB RAM (process overhead)
   └─► User requests image generation
   └─► App calls diffusionServer.generateImage(...)

2. Resource Check & Decision
   └─► SystemInfo.getMemoryInfo() → Check both RAM and VRAM
       └─► RAM: 15GB available (plenty)
       └─► VRAM: 2GB available (only 25% free)
   └─► diffusionServer needs ~5GB VRAM for SDXL model
   └─► Decision: NOT enough VRAM for both → Must offload LLM first
   └─► Note: If VRAM was sufficient, both could run simultaneously

3. Offload LLM (Automatic)
   └─► Save current LLM state (modelId, config, port, GPU layers)
   └─► llamaServer.stop() → Graceful shutdown
       └─► Wait for pending LLM requests to complete (timeout: 30s)
       └─► Free 6GB VRAM
   └─► Create request queue for incoming LLM requests
       └─► Queue has timeout (default: 5 minutes)
       └─► User can cancel queue via API

4. Start Diffusion & Generate
   └─► Check VRAM again → Now 8GB VRAM available ✓
   └─► diffusionServer.start({ modelId: 'sdxl-turbo' })
       └─► genai-electron creates HTTP wrapper server on port 8081
       └─► Wrapper loads model metadata and prepares for requests
       └─► Wait for health check
   └─► diffusionServer.generateImage({ prompt, ... })
       └─► HTTP wrapper receives request
       └─► Spawns stable-diffusion.cpp executable with prompt and settings
       └─► Progress callbacks: step 1/30, 2/30, ...
       └─► User can cancel via cancelImageGeneration()
       └─► Generate image (30-120 seconds)
       └─► Executable completes, writes image to disk
       └─► Wrapper returns image data via HTTP response
   └─► Image generation completes
   └─► diffusionServer.stop() → Shutdown HTTP wrapper → Free 5GB VRAM

5. Reload LLM (Automatic)
   └─► Check if LLM was previously running → YES
   └─► llamaServer.start(savedConfig)
       └─► Reload Llama-2-7B with original settings (35 GPU layers)
       └─► Model loaded back into 6GB VRAM
       └─► Wait for health check
   └─► Process queued LLM requests (if any)
       └─► Resolve pending promises
       └─► Reject timed-out requests with clear error

6. Back to Normal State
   └─► llama-server RUNNING again (6GB VRAM + 1GB RAM)
   └─► All queued requests processed or timed out
   └─► System ready for next request
```

**Note on genai-lite Integration**: In the future, genai-lite will provide a unified image generation API (similar to `sendMessage()` for LLMs). From genai-lite's perspective, it will make HTTP requests to localhost:8081 without knowing about the internal wrapper implementation. This maintains clean separation between the API layer (genai-lite) and runtime management (genai-electron).

**Different Hardware Configurations**:
- **CPU-only system**: Both models compete for RAM (e.g., 8GB RAM, LLM uses 6GB, diffusion needs 5GB)
- **GPU with ample VRAM**: No conflict (e.g., 24GB VRAM, both can run simultaneously)
- **Mixed workload**: LLM on CPU (RAM), diffusion on GPU (VRAM) - no conflict
- **Low RAM + GPU**: Both use VRAM, but process overhead may constrain RAM

**Key Features Demonstrated**:
- **Automatic resource management**: Library handles offload/reload transparently
- **Request queueing**: LLM requests during image gen are queued, not dropped
- **Cancellation support**: Both image generation and queued requests can be canceled
- **Timeout protection**: Queued requests don't wait forever
- **State preservation**: LLM config saved and restored automatically

---

## Storage Strategy

### Per-App Storage (MVP Approach)

**Decision**: Each Electron app using genai-electron has its own isolated storage for models.

When we reference `userData`, we mean **each app's userData directory**:
- **macOS**: `~/Library/Application Support/YourAppName/`
- **Windows**: `%APPDATA%/YourAppName/`
- **Linux**: `~/.config/YourAppName/`

Example: "AI Chat Assistant" stores models in `~/Library/Application Support/AI Chat Assistant/models/` while "AI Code Helper" stores them in `~/Library/Application Support/AI Code Helper/models/`. They do NOT share storage.

### The Trade-Off

**Duplication**: If multiple apps use the same model, it's duplicated on disk (3 apps × 7GB model = 21GB used).

**Why we accept this for MVP**: Simplicity (no coordination logic), isolation (no conflicts), clean uninstall (delete app = delete data), and most users only run 1-2 apps anyway.

### Future: Configurable Storage (Phase 2+)

Future versions will support shared storage:

```typescript
// Future API (not in MVP)
await init({
  storage: {
    mode: 'shared',  // 'isolated' | 'shared' | 'custom'
    sharedPath: '~/.genai-models'
  }
});
```

This enables download-once-use-everywhere for developers building multiple apps or power users with disk constraints. Migration from per-app to shared storage will be supported.

**Summary**: MVP uses isolated per-app storage (safest, simplest). Future extensions may add configurable shared storage.

---

## API Design

> **⚠️ Note on API Design**: The interfaces and examples below are **preliminary proposals** to guide initial development and communicate the intended developer experience. They will evolve significantly during Phase 1 implementation based on real-world usage patterns and technical discoveries. Focus on the **capabilities** and **user experience** rather than exact method signatures.

### Core Modules

The library exposes four main modules through a simple import:

```typescript
import {
  modelManager,
  llamaServer,
  diffusionServer,
  systemInfo
} from 'genai-electron';
```

#### ModelManager

Handles model downloading, storage, and metadata management.

**Key Capabilities**:
- List all installed models (filter by type: llm/diffusion)
- Download models from HuggingFace or direct URLs
- Track download progress with callbacks
- Verify model integrity with SHA256 checksums
- Cancel ongoing downloads
- Delete models and reclaim disk space
- Query storage usage statistics

**Core Operations**: `listModels()`, `downloadModel()`, `deleteModel()`, `verifyModel()`, `getStorageInfo()`

#### LlamaServer

Manages the llama-server process lifecycle for LLM inference.

**Key Capabilities**:
- Start/stop/restart llama-server processes
- Auto-configure settings based on system capabilities (threads, GPU layers, context size)
- Manual override for advanced users
- Monitor server health and resource usage
- Capture and access server logs
- Event notifications (started, stopped, crashed, restarted)
- Automatic crash recovery with configurable restart policy

**Core Operations**: `start()`, `stop()`, `restart()`, `getStatus()`, `isHealthy()`, `getLogs()`, `clearLogs()`

#### DiffusionServer

Manages HTTP wrapper for stable-diffusion.cpp executable.

**Implementation Note**: This is genai-electron's internal API. The `start()` method creates an HTTP server wrapper (not spawning stable-diffusion.cpp directly). The wrapper spawns the stable-diffusion.cpp executable on-demand when `generateImage()` is called. This provides a symmetric HTTP interface to genai-lite, matching the pattern used by llama-server.

**Key Capabilities**:
- Start/stop HTTP wrapper server
- Generate images from text prompts (spawns executable on-demand)
- Progress tracking during generation
- Configure generation parameters (size, steps, guidance, sampler)
- Event notifications for lifecycle events
- Automatic resource management (coordinate with LlamaServer for VRAM)

**Core Operations**: `start()`, `stop()`, `generateImage()`, `getStatus()`

**Future genai-lite Integration**: genai-lite will provide its own unified image generation API that abstracts away these details, similar to how `sendMessage()` abstracts LLM providers.

#### SystemInfo

Detects system capabilities and provides intelligent recommendations.

**Key Capabilities**:
- Detect hardware: CPU cores/architecture, RAM, GPU type, VRAM
- Identify acceleration support (CUDA, Metal, ROCm, Vulkan)
- Recommend optimal model sizes and quantization levels
- Calculate optimal server configurations (threads, GPU layers)
- Check if system can run specific models
- Real-time memory monitoring

**Core Operations**: `detect()`, `getMemoryInfo()`, `canRunModel()`, `getOptimalConfig()`

#### Error Handling

All operations use a consistent error hierarchy extending `GenaiElectronError`:
- `ModelNotFoundError` - Model doesn't exist
- `DownloadError` - Download failed or interrupted
- `InsufficientResourcesError` - Not enough RAM/VRAM/disk space
- `ServerError` - Server failed to start or crashed
- `PortInUseError` - Port already in use

Errors include actionable error codes and user-friendly messages with suggestions.

### genai-lite Integration (Future)

While genai-electron manages the runtime (downloading models, starting servers, managing resources), genai-lite provides the high-level API abstraction. This section describes how genai-lite will integrate image generation capabilities, maintaining the same clean separation as the LLM API.

#### Planned Image Generation API

**Design Principles**:
- Mirror the LLM API pattern: provider abstraction, unified request/response format
- Support multiple providers: local (via genai-electron), OpenAI DALL-E, Stability AI, etc.
- Maintain complete decoupling: genai-lite only knows about HTTP endpoints
- Consistent error handling across all providers

**API Surface** (conceptual):

```typescript
import { ImageService } from 'genai-lite';

// Initialize service (same pattern as LLMService)
const imageService = new ImageService(apiKeyProvider);

// Generate image - unified API across all providers
const response = await imageService.generateImage({
  providerId: 'local',  // or 'openai', 'stability', etc.
  modelId: 'sdxl-turbo',
  prompt: 'A serene mountain landscape at sunset',
  settings: {
    width: 1024,
    height: 1024,
    steps: 30,
    negativePrompt: 'blurry, low quality',
    // Provider-specific settings normalized
  }
});

// Response format (unified across providers)
if (response.object === 'image.generation') {
  console.log('Generated image:', response.data.url);
  console.log('Format:', response.data.format); // 'png', 'jpeg', etc.
} else {
  console.error('Error:', response.error.message);
}
```

**Provider Configuration**:

```typescript
// Local provider (via genai-electron)
{
  providerId: 'local',
  modelId: 'sdxl-turbo',
  baseURL: 'http://localhost:8081',  // genai-electron's HTTP wrapper
  // No API key needed for local
}

// Cloud providers
{
  providerId: 'openai',
  modelId: 'dall-e-3',
  // Uses OpenAI API key from apiKeyProvider
}
```

**Symmetry with LLM API**:
- `LLMService.sendMessage()` ↔ `ImageService.generateImage()`
- Both use provider/model selection
- Both have settings objects
- Both return unified response format (success/error)
- Both support multiple providers transparently

**API Format Inspiration**:
The API design is inspired by OpenAI's `/v1/images/generations` endpoint but adapted for multi-provider use:
- Similar parameter names (prompt, size, etc.) where applicable
- Normalized settings across providers (e.g., `steps` instead of provider-specific names)
- Consistent response format regardless of provider
- Provider-specific features available via settings object

**Implementation Timeline**:
The image generation API in genai-lite will be developed concurrently with genai-electron. The HTTP wrapper architecture ensures that when genai-lite is ready, integration will be seamless - genai-lite will simply make HTTP requests to localhost:8081, treating it like any other image generation provider.

### Usage Examples

The following examples illustrate the intended developer experience. Exact method names, parameters, and patterns will be refined during implementation based on what feels most natural and maintainable.

#### Example 1: Basic Setup

```typescript
import { app } from 'electron';
import { LLMService } from 'genai-lite';
import { modelManager, llamaServer, systemInfo } from 'genai-electron';

async function setupLocalAI() {
  // Detect system capabilities
  const capabilities = await systemInfo.detect();
  console.log('System can run models up to:', capabilities.recommendations.maxModelSize);

  // Check for installed models
  const models = await modelManager.listModels('llm');

  if (models.length === 0) {
    // No models installed - download a recommended one
    console.log('Downloading Llama-2-7B...');

    await modelManager.downloadModel({
      source: 'huggingface',
      repo: 'TheBloke/Llama-2-7B-GGUF',
      file: 'llama-2-7b.Q4_K_M.gguf',
      name: 'Llama 2 7B',
      type: 'llm',
      onProgress: (downloaded, total) => {
        const percent = (downloaded / total * 100).toFixed(1);
        console.log(`Download progress: ${percent}%`);
      }
    });
  }

  // Start llama server with auto-detected settings
  const firstModel = models[0] || await modelManager.listModels('llm').then(m => m[0]);

  await llamaServer.start({
    modelId: firstModel.id,
    port: 8080,
    // Auto-configure based on system
    // threads, gpuLayers, contextSize all auto-detected
  });

  console.log('llama-server is running on port 8080');

  // Now use with genai-lite
  const llmService = new LLMService(async () => 'not-needed');
  const response = await llmService.sendMessage({
    providerId: 'llamacpp',
    modelId: 'llama-2-7b',
    messages: [{ role: 'user', content: 'Hello!' }]
  });

  console.log(response.choices[0].message.content);
}

// Cleanup on app quit
app.on('before-quit', async () => {
  await llamaServer.stop();
});
```

#### Example 2: Advanced Configuration

```typescript
import { modelManager, llamaServer, systemInfo } from 'genai-electron';

async function advancedSetup() {
  // Download multiple models
  const models = [
    {
      repo: 'TheBloke/Llama-2-7B-GGUF',
      file: 'llama-2-7b.Q4_K_M.gguf',
      name: 'Llama 2 7B (Fast)'
    },
    {
      repo: 'TheBloke/Llama-2-13B-GGUF',
      file: 'llama-2-13b.Q4_K_M.gguf',
      name: 'Llama 2 13B (Powerful)'
    }
  ];

  // Download in parallel
  await Promise.all(
    models.map(m => modelManager.downloadModel({
      source: 'huggingface',
      ...m,
      type: 'llm',
      onProgress: (downloaded, total) => {
        console.log(`${m.name}: ${(downloaded/total*100).toFixed(1)}%`);
      }
    }))
  );

  // Get system recommendations
  const [model7B] = await modelManager.listModels('llm');
  const optimalConfig = await systemInfo.getOptimalConfig(model7B);

  // Start with custom settings
  await llamaServer.start({
    modelId: model7B.id,
    port: 8080,
    ...optimalConfig,
    // Override specific settings
    contextSize: 8192,
    parallelRequests: 8,
    flashAttention: true
  });

  // Monitor server health
  llamaServer.on('crashed', async (error) => {
    console.error('Server crashed:', error);
    // Auto-restart is enabled by default
  });

  llamaServer.on('restarted', () => {
    console.log('Server restarted successfully');
  });
}
```

#### Example 3: Image Generation

```typescript
import { modelManager, diffusionServer } from 'genai-electron';
import fs from 'fs/promises';

async function generateImage() {
  // Download diffusion model
  await modelManager.downloadModel({
    source: 'huggingface',
    repo: 'stabilityai/stable-diffusion-xl-base-1.0-GGUF',
    file: 'sdxl-turbo-q4.gguf',
    name: 'SDXL Turbo',
    type: 'diffusion',
    onProgress: (downloaded, total) => {
      console.log(`Progress: ${(downloaded/total*100).toFixed(1)}%`);
    }
  });

  // Start diffusion server
  // Note: This creates an HTTP wrapper server, not spawning stable-diffusion.cpp yet
  const [model] = await modelManager.listModels('diffusion');
  await diffusionServer.start({
    modelId: model.id,
    port: 8081
  });

  // Generate an image
  // Note: The HTTP wrapper spawns stable-diffusion.cpp executable here
  const result = await diffusionServer.generateImage({
    prompt: 'A serene mountain landscape at sunset, 4k, detailed',
    negativePrompt: 'blurry, low quality, distorted',
    width: 1024,
    height: 1024,
    steps: 30,
    cfgScale: 7.5,
    onProgress: (step, total) => {
      console.log(`Generating: ${step}/${total}`);
    }
  });

  // Save image
  await fs.writeFile('output.png', result.image);
  console.log(`Image generated in ${result.timeTaken}ms`);
}
```

**Note**: This example shows genai-electron's direct API. In the future, genai-lite will provide a higher-level unified image generation API that works across multiple providers (local via genai-electron, cloud via OpenAI/Stability AI, etc.), maintaining the same clean separation as the LLM API.

---

## Example Application

The **electron-control-panel** is a full-featured Electron application that demonstrates genai-electron's runtime management capabilities. Unlike genai-lite's example app chat-demo (which focuses on API abstraction, templates, and reasoning modes), this app focuses on infrastructure management.

**Purpose:**
- Test and demonstrate genai-electron features during development
- Serve as reference implementation for developers building with genai-electron
- Provide a visual tool for managing local AI infrastructure (models, servers, resources)

**Key Differences from chat-demo:**

| Aspect | genai-lite chat-demo | genai-electron control-panel |
|--------|---------------------|------------------------------|
| Focus | API features (templates, providers, reasoning) | Infrastructure (downloads, servers, resources) |
| Use case | Chat interface showcase | Developer/admin control panel |
| genai-lite usage | Heavy (main focus) | Light (testing only) |
| genai-electron usage | None | Heavy (main focus) |

**Scope by Phase:**
- **Phase 1 (MVP)**: System Info, Model Management, LLM Server tabs
- **Phase 2**: Adds Diffusion Server and Resource Monitor tabs
- **Phase 3+**: Enhanced monitoring, event logs, storage configuration

**Tech Stack:**
Electron + React + TypeScript, with tab-based UI and IPC communication patterns.

For complete design specifications, implementation details, UI mockups, and usage instructions, see **[DESIGN-EXAMPLE-APP.md](DESIGN-EXAMPLE-APP.md)**.

---

## Technical Decisions

### 1. Binary Distribution Strategy

**Decision**: Download pre-compiled binaries from GitHub on first run

**Options Considered**:
1. ✅ **Download binaries on first run** (CHOSEN)
2. ❌ Bundle binaries in the npm package
3. ❌ Require users to install separately

**Rationale**:
- **Pro**: Much smaller package (~5-10MB code-only vs 200-400MB with all platform binaries)
- **Pro**: Platform-specific - users only download binaries for their platform (~50-100MB)
- **Pro**: Update flexibility - pin known-good releases, update independently of code
- **Pro**: Natural fit - extends existing download infrastructure built for models
- **Pro**: Storage efficiency - no wasted space for unused platform variants
- **Con**: Requires network connection on first run
- **Con**: First-run experience is slower (one-time binary download)
- **Con**: Need download logic with retry handling and verification

**Implementation**:
- Pin specific llama.cpp and diffusion.cpp releases in code (e.g., specific commit/tag)
- Download on first `start()` call with progress callbacks
- Cache binaries in `userData/binaries/` with version tracking
- Verify SHA256 checksums from GitHub releases
- Store version info in `userData/binaries/.versions.json`
- Support manual binary updates via `updateBinaries()` API

**Binary Sources**:
- llama.cpp: https://github.com/ggml-org/llama.cpp/releases
- diffusion.cpp: https://github.com/leejet/stable-diffusion.cpp/releases

**Platform-Specific Downloads** (users only download their platform):
```
macOS (arm64):  llama-server-darwin-arm64, diffusion-darwin-arm64  (~50-60MB)
macOS (x64):    llama-server-darwin-x64, diffusion-darwin-x64      (~50-60MB)
Windows (x64):  llama-server-win32-x64.exe, diffusion-cpp.exe      (~50-60MB)
Linux (x64):    llama-server-linux-x64, diffusion-cpp              (~50-60MB)
```

**Version Management**:
```typescript
// Example version pinning in code
const BINARY_VERSIONS = {
  llamaServer: {
    version: 'b1234',  // llama.cpp commit or release tag
    urls: {
      'darwin-arm64': 'https://github.com/ggml-org/llama.cpp/releases/download/...',
      'darwin-x64': 'https://github.com/ggml-org/llama.cpp/releases/download/...',
      'win32-x64': 'https://github.com/ggml-org/llama.cpp/releases/download/...',
      'linux-x64': 'https://github.com/ggml-org/llama.cpp/releases/download/...'
    },
    checksums: {
      'darwin-arm64': 'sha256:abc123...',
      // ... other platforms
    }
  },
  diffusionCpp: { /* similar structure */ }
};
```

**Automatic Download Flow**:
```
1. User calls llamaServer.start(config)
2. Library checks: Does userData/binaries/llama-server exist?
   - No → Download from pinned GitHub release
   - Yes → Check version matches pinned version
3. If downloading:
   - Show progress via callback: onProgress(downloaded, total)
   - Verify SHA256 checksum after download
   - Mark as installed in userData/binaries/.versions.json
4. Proceed with server start
```

**Phase Allocation**:
- **Phase 1**: Basic binary download with pinned releases, no auto-update
- **Phase 4**: Automatic update checks, support for multiple versions

### 2. Model Download Strategy

**Decision**: Direct HTTP downloads with resume support

**Options Considered**:
1. ✅ **Direct HTTP downloads** (CHOSEN)
2. ❌ Use HuggingFace Hub API
3. ❌ Use git-lfs
4. ❌ Use torrent protocol

**Rationale**:
- **Pro**: Simple, no external dependencies
- **Pro**: Works with any URL source
- **Pro**: Easy to implement resume capability
- **Con**: No automatic mirror selection
- **Con**: No automatic version updates

**Implementation**:
- Use native `fetch()` (Node.js 18+) or `undici` for HTTP requests
- Stream response to disk using `fs.createWriteStream()`
- Save to temp file during download
- Move to final location on completion
- Store partial downloads with `.partial` extension
- Support `Range` header for resume capability
- Verify SHA256 checksum after download using `crypto.createHash('sha256')`

**HuggingFace Integration**:
```typescript
// Convert HF repo to direct URL
function getHuggingFaceURL(repo: string, file: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}
```

### 3. Process Management

**Decision**: Use Node.js `child_process.spawn()` with event-based monitoring

**Implementation Details**:
- Spawn servers as child processes
- Capture stdout/stderr for logging
- Monitor process exit codes
- Implement graceful shutdown (SIGTERM → wait → SIGKILL)
- Auto-restart on unexpected crashes
- Track PIDs for cleanup

**Health Checking**:
- Poll `/health` endpoint every 5 seconds
- Exponential backoff on failures
- Emit events for status changes

**Log Management**:
- Capture server output to rotating log files
- **Intelligent parsing**: llama.cpp logs everything as [ERROR]; library automatically categorizes as debug/info/error based on content
- **Clean formatting**: Strips llama.cpp's duplicate timestamps and levels before storage
- **Carriage return handling**: `LogManager.parseEntry()` trims `\r\n` before parsing (llama.cpp outputs `\r` at line end)
- Max log size: 10MB per file
- Keep last 5 log files
- Provide API to retrieve and clear logs (`getLogs()`, `clearLogs()`)

### 4. System Capability Detection

**Decision**: Use Node.js built-ins + platform-specific detection

**RAM Detection**:
```typescript
import os from 'os';

function getRAM() {
  return {
    total: os.totalmem(),
    free: os.freemem()
  };
}
```

**GPU Detection**:
```typescript
// macOS: Check for Metal support via system_profiler
// Windows: Use wmic or nvidia-smi for NVIDIA GPUs
// Linux: Check /proc, nvidia-smi, rocm-smi

async function detectGPU(): Promise<GPUInfo> {
  if (process.platform === 'darwin') {
    // Check for Metal support (all modern Macs)
    return { available: true, type: 'apple', metal: true };
  }

  if (process.platform === 'win32') {
    // Try nvidia-smi
    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader');
      const [name, vram] = stdout.trim().split(',');
      return {
        available: true,
        type: 'nvidia',
        name: name.trim(),
        vram: parseInt(vram) * 1024 * 1024, // MB to bytes
        cuda: true
      };
    } catch {
      return { available: false };
    }
  }

  // Similar for Linux with CUDA/ROCm detection
}
```

### 5. Storage Structure

**Decision**: Use Electron's `userData` directory with organized subdirectories

**Paths**:
```typescript
import { app } from 'electron';
import path from 'path';

const BASE_DIR = app.getPath('userData');

export const PATHS = {
  models: {
    llm: path.join(BASE_DIR, 'models', 'llm'),
    diffusion: path.join(BASE_DIR, 'models', 'diffusion')
  },
  binaries: {
    llama: path.join(BASE_DIR, 'binaries', 'llama'),
    diffusion: path.join(BASE_DIR, 'binaries', 'diffusion')
  },
  logs: path.join(BASE_DIR, 'logs'),
  config: path.join(BASE_DIR, 'config')
};
```

**Model Metadata**:
Store alongside each model as `{model-name}.json`:
```json
{
  "id": "llama-2-7b-q4",
  "name": "Llama 2 7B",
  "type": "llm",
  "size": 4368769024,
  "downloadedAt": "2025-01-15T10:30:00Z",
  "source": {
    "type": "huggingface",
    "repo": "TheBloke/Llama-2-7B-GGUF",
    "file": "llama-2-7b.Q4_K_M.gguf"
  },
  "checksum": "sha256:abc123..."
}
```

### 6. Error Handling Strategy

**Principles**:
1. All errors extend `GenaiElectronError`
2. Include actionable error codes
3. Provide user-friendly messages
4. Include technical details for debugging
5. Never expose sensitive paths in user-facing errors

**Example**:
```typescript
throw new InsufficientResourcesError(
  'Not enough RAM to run this model',
  {
    required: '8GB',
    available: '4GB',
    suggestion: 'Try a smaller quantization like Q4_K_M or close other applications'
  }
);
```

### 7. HTTP Wrapper Strategy for stable-diffusion.cpp

**Problem**: Unlike llama.cpp which provides llama-server (a native HTTP server), stable-diffusion.cpp is a one-shot executable that generates images and exits. This asymmetry could complicate the API if not handled properly.

**Solution**: genai-electron creates an HTTP wrapper server for stable-diffusion.cpp, providing the same HTTP interface pattern as llama-server.

**Architecture**:

1. **DiffusionServerManager.start()**:
   - Creates an HTTP server (Express/Fastify) on specified port
   - Loads model metadata
   - Provides standard endpoints: `/health`, `/v1/images/generations`
   - Does NOT spawn stable-diffusion.cpp yet

2. **On Image Generation Request**:
   - HTTP wrapper receives POST request to `/v1/images/generations`
   - Spawns stable-diffusion.cpp executable with arguments:
     - Model path
     - Prompt, negative prompt
     - Width, height, steps, CFG scale, etc.
   - Monitors process output for progress updates
   - Waits for completion (image written to disk)
   - Returns image data in HTTP response
   - Executable exits

3. **DiffusionServerManager.stop()**:
   - Shuts down HTTP wrapper server
   - Kills any running stable-diffusion.cpp processes
   - Cleans up resources

**Alternatives Considered**:

We evaluated existing solutions before deciding on a custom HTTP wrapper:

1. **LLaMA Box** - An existing inference server that wraps both llama.cpp and stable-diffusion.cpp with OpenAI-compatible APIs
   - **Pros**: Ready-made solution, unified server for both LLM and image generation
   - **Cons**:
     - Small project, no releases since August 2025
     - Risk of project abandonment
     - Adds another dependency layer
     - Less control over functionality and updates
   - **Decision**: Too risky for production use

2. **Custom HTTP Wrapper** (chosen approach)
   - **Pros**:
     - Full control over implementation
     - Minimal code to maintain
     - No dependency on potentially unstable third-party projects
     - Easy to modify and extend
     - Can swap backends without affecting API
   - **Cons**:
     - Requires implementing HTTP server logic
     - Need to handle request queuing, progress tracking, etc.
   - **Decision**: Better long-term stability and maintainability

**Benefits**:
- **Symmetry**: Both llama-server and diffusion appear as HTTP endpoints to genai-lite
- **Clean separation**: genai-lite has no knowledge of wrapper vs. native server
- **Standard patterns**: Same start/stop/health check APIs for both
- **Resource management**: Can stop/start the wrapper like any other server
- **Abstraction layer design**: Clean interface separation allows backend to be swapped without changing the API layer
  - If stable-diffusion.cpp adds native server support in the future, we can switch seamlessly
  - The HTTP wrapper implements a well-defined interface that any backend can fulfill
  - genai-lite's API remains unchanged regardless of backend implementation
- **Future-proof**: Easy to add more executable-based models using the same wrapper pattern

**Implementation Notes**:
- HTTP wrapper uses lightweight server (Express or Fastify)
- Queue concurrent requests or reject with 503 if busy
- Stream progress updates via Server-Sent Events or polling endpoint
- Validate requests before spawning expensive executable
- Implement timeouts to prevent hanging processes

**Future Considerations**:
- Monitor stable-diffusion.cpp repository for potential native server implementation
- If a native server is added (similar to llama-server), the abstraction layer design makes it straightforward to switch backends
- The well-defined HTTP interface ensures minimal disruption when transitioning from wrapper to native server

### 8. BinaryManager Pattern (Reusable Binary Management)

**Design Goal**: Extract binary download/variant testing logic into a reusable module that works for both llama.cpp and stable-diffusion.cpp (and future binaries).

**Architecture**:

The `BinaryManager` class provides generic functionality for:
1. Downloading pre-compiled binaries from GitHub releases
2. Testing multiple binary variants (CUDA, Vulkan, Metal, CPU)
3. Selecting the first variant that works on the current system
4. Copying all files (executable + DLLs) to the correct location
5. Caching which variant worked for faster startup next time

**Separate Storage by Binary Type**:

Binaries are stored in type-specific subdirectories to prevent conflicts:

```
binaries/
├── llama/                    # llama.cpp binaries and dependencies
│   ├── llama-server.exe      # Windows executable
│   ├── vulkan-1.dll          # Vulkan DLL for Windows
│   ├── ggml-vulkan.dll       # GGML Vulkan backend
│   └── .variant.json         # Cached variant selection
└── diffusion/                # stable-diffusion.cpp binaries (Phase 2)
    ├── stable-diffusion.exe
    ├── vulkan-1.dll          # Separate copy, no conflicts
    └── .variant.json
```

**Benefits**:
- **No DLL conflicts**: Each binary type has its own isolated directory
- **Clean separation**: llama.cpp and stable-diffusion.cpp don't interfere
- **Reusable code**: Single BinaryManager used by both LlamaServerManager and DiffusionServerManager
- **Easy to extend**: Adding new binary types requires minimal code

**Usage Pattern**:

```typescript
// In LlamaServerManager.ensureBinary():
const binaryManager = new BinaryManager({
  type: 'llama',
  binaryName: 'llama-server',
  platformKey: 'win32-x64',
  variants: [...], // CUDA, Vulkan, CPU variants
  log: (message, level) => this.logManager.write(message, level)
});

const binaryPath = await binaryManager.ensureBinary();
// Returns: C:\...\binaries\llama\llama-server.exe
```

**Variant Testing**:

The BinaryManager tests each variant by running `--version` to ensure:
1. The executable runs without errors
2. Required DLLs are present (no missing dependency errors)
3. GPU drivers are available (for CUDA/Vulkan/Metal variants)

If a variant fails (e.g., Vulkan DLL missing), it tries the next variant automatically (e.g., CPU-only).

**Implementation Location**: `src/managers/BinaryManager.ts`

---

## Implementation Phases

### Phase 1: MVP - LLM Support

**Goal**: Basic llama-server management that works end-to-end

**Scope**:
- ✅ System capability detection (RAM, CPU, GPU, VRAM)
- ✅ Model storage in userData directory
- ✅ Download models from direct URLs
- ✅ Start/stop llama-server with basic config
- ✅ Health checking and status monitoring
- ✅ Basic error handling
- ✅ TypeScript types and interfaces
- ✅ Basic documentation
- ✅ Automatic reasoning model detection (Qwen3, DeepSeek-R1, etc.)

**Timeline**: 2-3 weeks

**Deliverables**:
- Working library that can download and run llama-server
- electron-control-panel example app with System Info, Models, and LLM Server tabs
- README with setup instructions
- Basic API documentation

**Success Criteria**:
- Can download a GGUF model
- Can start llama-server successfully
- Can make requests via genai-lite
- Handles basic errors gracefully

### Phase 2: Image Generation

**Goal**: Add diffusion.cpp support for local image generation

**Scope**:
- ✅ diffusion.cpp integration (HTTP wrapper for stable-diffusion.cpp executable)
- ✅ Image generation API (basic generateImage with progress callbacks)
- ✅ Core resource orchestration (offload/reload mechanism when resources constrained)
- ✅ Support for both CPU and GPU image generation
- ✅ Progress tracking for image generation
- ✅ Basic documentation for image features
- ⏭️ Advanced features deferred to Phase 3:
  - LLM request queuing during image generation
  - Cancellation API (cancelImageGeneration)
  - Advanced queue management with timeouts

**Timeline**: 2-3 weeks

**Deliverables**:
- Full diffusion.cpp support with HTTP wrapper
- Updated electron-control-panel with Diffusion Server and Resource Monitor tabs
- Documentation on resource management and automatic offload/reload
- Core ResourceOrchestrator implementation

**Success Criteria**:
- Can download diffusion models
- Can generate images locally
- Automatic resource management works (core offload/reload when needed)
- Handles both scenarios: sufficient resources and constrained resources
- Phase 2 focuses on proving the offload/reload mechanism; advanced queuing in Phase 3

### Phase 3: Production Core

**Goal**: Essential production features for reliability and usability

**Scope**:
- ✅ HuggingFace integration (convert repo/file to URLs)
- ✅ Resume interrupted downloads
- ✅ Download progress tracking
- ✅ SHA256 checksum verification
- ✅ Event emitters for all components
- ✅ Graceful shutdown with cleanup
- ✅ Comprehensive error types
- ✅ Unit tests for all modules
- ✅ Integration tests
- ✅ Advanced resource orchestration features (from Phase 2):
  - LLM request queuing during image generation (with timeout: 5 min default)
  - Queue status monitoring and management
  - Cancellation API for image generation (cancelImageGeneration)
  - Per-request timeout tracking in queue
  - Queue cancellation via API

**Timeline**: 2-3 weeks

**Deliverables**:
- Robust download system with resume capability
- Production-ready error handling
- Test coverage for core functionality
- Complete API documentation
- Advanced resource orchestration with request queuing

**Success Criteria**:
- Can resume interrupted downloads
- 60%+ test coverage
- Clean error messages for all common failures
- No critical bugs in core functionality
- Request queuing works correctly (LLM requests during image gen are queued and processed)

### Phase 4: Production Polish

**Goal**: Important features for robustness and advanced use cases

**Scope**:
- ✅ Auto-restart on crash
- ✅ Log management (rotating logs)
- ✅ Port conflict detection and handling
- ✅ Configurable storage modes (isolated/shared/custom) - see [Storage Strategy](#storage-strategy)
- ✅ Optimal config recommendations
- ✅ Resource usage monitoring
- ✅ Automatic binary updates

**Timeline**: 3-4 weeks

**Deliverables**:
- Robust server lifecycle management
- Shared storage option for multi-app scenarios
- Smart configuration recommendations
- Complete monitoring and logging

**Success Criteria**:
- 80%+ test coverage
- Handles edge cases (crashes, network failures, port conflicts)
- Configurable storage works across multiple apps
- Provides helpful config recommendations

### Phase 5: Optional/Future Extensions

**Goal**: Nice-to-have features for specific use cases (may not implement all)

**Scope**:
- 🔄 Model marketplace/registry (curated list of popular models)
- 🔄 Performance benchmarking tools
- 🔄 Multi-server support (run multiple models simultaneously)
- 🔄 Model conversion utilities
- 🔄 Advanced GPU configuration options
- 🔄 Remote model management (cloud storage integration)

**Timeline**: TBD or ongoing

**Deliverables**:
- Selected features based on user demand
- Advanced examples for power users

**Success Criteria**:
- Features are implemented based on actual user needs
- Each feature has clear documentation and examples

---

## Project Structure

```
genai-electron/
├── src/
│   ├── index.ts                    # Main entry point, exports public API
│   │
│   ├── managers/                   # Core management modules
│   │   ├── ModelManager.ts         # Model download, storage, metadata
│   │   ├── ServerManager.ts        # Base class for server management
│   │   ├── LlamaServerManager.ts   # llama-server specific
│   │   ├── DiffusionServerManager.ts # diffusion.cpp specific
│   │   └── StorageManager.ts       # File system operations
│   │
│   ├── system/                     # System detection
│   │   ├── SystemInfo.ts           # Main system detection class
│   │   ├── gpu-detect.ts           # GPU detection utilities
│   │   ├── cpu-detect.ts           # CPU detection utilities
│   │   └── memory-detect.ts        # Memory detection utilities
│   │
│   ├── download/                   # Download utilities
│   │   ├── Downloader.ts           # Main download class
│   │   ├── huggingface.ts          # HuggingFace URL helpers
│   │   └── checksum.ts             # SHA256 verification
│   │
│   ├── process/                    # Process management
│   │   ├── ProcessManager.ts       # Spawn and monitor processes
│   │   ├── health-check.ts         # Health checking utilities
│   │   ├── log-manager.ts          # Log capture and rotation
│   │   └── llama-log-parser.ts     # Intelligent llama.cpp log parsing
│   │
│   ├── config/                     # Configuration
│   │   ├── paths.ts                # Path constants
│   │   ├── defaults.ts             # Default configurations
│   │   └── recommendations.ts      # Auto-config logic
│   │
│   ├── types/                      # TypeScript types
│   │   ├── index.ts                # Main type exports
│   │   ├── models.ts               # Model-related types
│   │   ├── servers.ts              # Server-related types
│   │   └── system.ts               # System-related types
│   │
│   ├── errors/                     # Error classes
│   │   └── index.ts                # All error types
│   │
│   └── utils/                      # Utilities
│       ├── file-utils.ts           # File operations
│       ├── network-utils.ts        # Network helpers
│       └── platform-utils.ts       # Platform detection
│
├── examples/                       # Example applications
│   ├── electron-control-panel/     # Full Electron app demonstrating genai-electron
|   ...                             # See DESIGN-EXAMPLE-APP.md
│
├── tests/                          # Test files
│   ├── unit/                       # Unit tests
│   │   ├── ModelManager.test.ts
│   │   ├── ServerManager.test.ts
│   │   └── SystemInfo.test.ts
│   ├── integration/                # Integration tests
│   │   ├── download.test.ts
│   │   └── server-lifecycle.test.ts
│   └── e2e/                        # End-to-end tests
│       └── full-workflow.test.ts
│
├── docs/                           # Documentation
│   └── SETUP.md                    # Development setup guide
│
├── genai-electron-docs/            # User documentation (11 modular files)
│   ├── index.md                    # Documentation entry point
│   ├── installation-and-setup.md   # Setup and requirements
│   ├── system-detection.md         # SystemInfo API
│   ├── model-management.md         # ModelManager API
│   ├── llm-server.md              # LlamaServerManager API
│   ├── image-generation.md        # DiffusionServerManager API
│   ├── resource-orchestration.md  # ResourceOrchestrator
│   ├── integration-guide.md       # Electron patterns
│   ├── typescript-reference.md    # Type definitions
│   ├── troubleshooting.md         # Common issues
│   └── example-control-panel.md   # Reference implementation
│
├── package.json                    # Package configuration
├── tsconfig.json                   # TypeScript configuration
├── jest.config.js                  # Jest test configuration
├── .gitignore                      # Git ignore rules
├── .npmignore                      # NPM ignore rules
├── README.md                       # Main README
├── LICENSE                         # MIT License
└── DESIGN.md                       # This file
```

**Note on Binaries**: Pre-compiled binaries (llama-server, diffusion-cpp) are **NOT bundled in the npm package**. They are downloaded on-demand from GitHub releases when users first call `start()`, then cached in each app's `userData/binaries/` directory. This keeps the npm package small (~5-10MB) instead of large (~200-400MB). See [Binary Distribution Strategy](#1-binary-distribution-strategy) for details.

---

## Dependencies

### Core Dependencies

**Philosophy**: Minimize external dependencies. Use Node.js built-ins when possible.

#### Required Peer Dependencies

```json
{
  "peerDependencies": {
    "electron": ">=25.0.0"
  }
}
```

**Note**: Electron should **NOT** be listed in `dependencies`. Apps provide their own Electron version.

#### Runtime Dependencies

**HTTP Client for Downloads**:

The library needs an HTTP client for downloading models and binaries. Options:

1. **Native `fetch()` (Node.js 18+)** - ✅ **Recommended if targeting Node 18+**
   - No external dependency required
   - Built into Node.js runtime
   - Modern, Promise-based API
   - Sufficient for our download needs

2. **`undici`** - Alternative if more control needed
   - ~3x faster than axios for HTTP operations
   - Maintained by Node.js organization
   - Powers the native `fetch()` implementation
   - Good choice if targeting older Node versions or need advanced features

3. **`axios`** - Fallback option
   - Most popular (68M weekly downloads)
   - Familiar to most developers
   - Has more overhead than undici or native fetch

**Recommendation**: Start with native `fetch()` (no dependency). Only add `undici` if specific needs arise during implementation.

#### Using Node.js Built-ins

Most functionality can use Node's standard library:

- **File operations**: `fs/promises`
- **SHA256 checksums**: `crypto.createHash('sha256')`
- **Process spawning**: `child_process.spawn()`
- **Event emitting**: `EventEmitter` from `events` module
- **Path handling**: `path`
- **OS information**: `os`

**Note on EventEmitter**: Node's built-in EventEmitter is sufficient for our needs. External libraries like `eventemitter3` are faster but remove features (domains, setMaxListeners). Only consider if profiling shows event emitting is a bottleneck.

#### Conditional Dependencies (TBD During Implementation)

These may or may not be needed - decide during development:

- **Zip extraction**: Only if binaries are distributed as .zip files
  - Check binary distribution format first
  - If needed: Consider `node:zlib` (built-in) or `adm-zip`

- **Advanced logging**: Only if simple log rotation isn't sufficient
  - Can implement basic rotation ourselves using `fs`
  - If needed: Consider `winston` or `pino`

#### Development Dependencies

Standard TypeScript/testing toolchain (exact versions TBD):

```json
{
  "devDependencies": {
    "@types/node": ">=20.0.0",
    "typescript": ">=5.3.0",
    "jest": ">=29.0.0",
    "@types/jest": ">=29.0.0",
    "ts-jest": ">=29.0.0",
    "eslint": ">=8.0.0",
    "@typescript-eslint/parser": ">=6.0.0",
    "@typescript-eslint/eslint-plugin": ">=6.0.0",
    "prettier": ">=3.0.0"
  }
}
```

**Version Strategy**: Use `>=` for dev dependencies to allow flexibility. Lock specific versions during development based on compatibility testing.

### Binary Dependencies

**llama.cpp** (downloaded on first run):
- Source: https://github.com/ggml-org/llama.cpp/releases
- Distribution: Pre-compiled binaries downloaded from GitHub releases
- Version: Pinned to specific release tag in code (e.g., `v1.2.3`)
- Size: ~50-60MB per platform (users only download their platform)
- Location: Cached in `userData/binaries/` after download
- Verification: SHA256 checksum validated after download

**stable-diffusion.cpp** (downloaded on first run):
- **What it is**: A lightweight C/C++ implementation of Stable Diffusion, similar in philosophy to llama.cpp
- **Key features**: Efficient, supports multiple backends (CUDA, Metal, Vulkan), requires minimal resources (~2.3GB RAM for 512x512 generation)
- **Important note**: Unlike llama.cpp's llama-server, stable-diffusion.cpp does **not** include a built-in HTTP server—it's a one-shot executable
- Source: https://github.com/leejet/stable-diffusion.cpp/releases
- Distribution: Pre-compiled binaries downloaded from GitHub releases
- Version: Pinned to specific release tag/commit in code
- Size: ~50-60MB per platform (users only download their platform)
- Location: Cached in `userData/binaries/` after download
- Verification: SHA256 checksum validated after download

**Binary Management**:
- Downloads happen automatically on first `start()` call
- Progress callbacks provided during download
- Binaries persist across app restarts (cached in userData)
- Version tracking in `userData/binaries/.versions.json`
- Automatic version checks compare cached vs pinned versions
- Manual binary updates via `updateBinaries()` API (Phase 4)

---

## Testing Strategy

### Unit Tests

**Coverage Target**: 80%+

**Key Areas**:
- ModelManager: list, download, delete, verify
- ServerManager: start, stop, status, health
- SystemInfo: detect, recommend, validate
- Downloader: download, resume, checksum
- StorageManager: paths, disk space, cleanup

**Mocking**:
- Mock filesystem operations
- Mock HTTP requests
- Mock child_process.spawn
- Mock Electron app.getPath()

### Integration Tests

**Scenarios**:
- Download a small test model
- Start server with test model
- Make health check request
- Stop server and verify cleanup
- Handle port conflicts
- Resume interrupted downloads

**Setup**:
- Use temp directories for storage
- Use high ports (8090+) to avoid conflicts
- Use small test models (~100MB)

### E2E Tests

**Full Workflow**:
1. Detect system
2. Download model
3. Start server
4. Use with genai-lite
5. Stop server
6. Clean up

**Platform Testing**:
- CI/CD for Linux (GitHub Actions)
- Manual testing for macOS and Windows
- Test on different hardware (CPU-only, CUDA, Metal)

---

## Documentation Plan

### 1. README.md

**Sections**:
- What is genai-electron?
- Why use it?
- Installation
- Quick start example
- Key features
- Platform support
- Links to other docs

**Target Audience**: Developers evaluating the library

### 2. genai-electron-docs/

**Content**:
- Modular documentation (11 self-contained files)
- index.md: Navigation hub and quick starts
- API references for each manager (SystemInfo, ModelManager, LlamaServerManager, DiffusionServerManager, ResourceOrchestrator)
- TypeScript reference with all type definitions
- Integration guide with Electron patterns
- Troubleshooting guide with error codes
- Example app documentation

**Target Audience**: Developers integrating the library

**Note**: Replaces monolithic API.md with organized, navigable structure (Phase 1-4 documentation restructuring complete)

### 3. SETUP.md

**Content**:
- Detailed setup instructions
- Environment requirements
- Binary compilation guide
- Troubleshooting common issues
- Platform-specific notes

**Target Audience**: Developers setting up for the first time

### 4. EXAMPLES.md

**Content**:
- Basic usage example
- Advanced configuration
- Image generation
- Multi-model setup
- Integration with genai-lite
- Error handling patterns

**Target Audience**: Developers learning the library

### 5. TROUBLESHOOTING.md

**Content**:
- Common errors and solutions
- Platform-specific issues
- Performance optimization
- Debugging tips
- FAQ

**Target Audience**: Developers encountering issues

---

## Platform Support

### macOS

**Versions**: macOS 11+ (Big Sur and later)

**Architectures**:
- ✅ arm64 (Apple Silicon M1/M2/M3) - PRIMARY
- ✅ x64 (Intel) - SECONDARY

**GPU Support**:
- ✅ Metal (all modern Macs)
- Automatic GPU layer detection
- Unified memory advantage (RAM = VRAM)

**Runtime Requirements**:
- macOS 11 or later
- No additional dependencies required
- Metal drivers are built into macOS

**Binaries**:
```
binaries/darwin-arm64/llama-server    # Built with Metal
binaries/darwin-arm64/diffusion-cpp   # Built with Metal
binaries/darwin-x64/llama-server      # Built for Intel
binaries/darwin-x64/diffusion-cpp     # Built for Intel
```

**Special Considerations**:
- Use Metal acceleration by default
- High unified memory = can run larger models
- App notarization required for distribution

### Windows

**Versions**: Windows 10+ (64-bit)

**GPU Support**:
- ✅ NVIDIA CUDA (if GPU detected)
- ✅ CPU fallback (always works)
- ⚠️ AMD GPUs (limited support via Vulkan)

**Runtime Requirements**:
- Windows 10 or later (64-bit)
- No additional dependencies for CPU-only mode
- NVIDIA GPU drivers for CUDA acceleration (if using NVIDIA GPU)

**Binaries**:
```
binaries/win32-x64/llama-server.exe        # Built with CUDA
binaries/win32-x64/llama-server-cpu.exe    # CPU-only fallback
binaries/win32-x64/diffusion-cpp.exe       # Built with CUDA
```

**Special Considerations**:
- CUDA detection via nvidia-smi
- Provide CPU-only fallback
- Handle Windows Defender/antivirus issues
- Require administrator for first-run binary setup (optional)

### Linux

**Distributions**: Ubuntu 20.04+, Debian 11+, Fedora 35+

**GPU Support**:
- ✅ NVIDIA CUDA (if GPU detected)
- ✅ AMD ROCm (experimental)
- ✅ CPU fallback (always works)

**Runtime Requirements**:
- Supported distribution (Ubuntu 20.04+, Debian 11+, Fedora 35+)
- No additional dependencies for CPU-only mode
- NVIDIA GPU drivers for CUDA acceleration (if using NVIDIA GPU)
- AMD GPU drivers for ROCm acceleration (if using AMD GPU, experimental)

**Binaries**:
```
binaries/linux-x64/llama-server        # Built with CUDA
binaries/linux-x64/llama-server-cpu    # CPU-only
binaries/linux-x64/diffusion-cpp       # Built with CUDA
```

**Special Considerations**:
- Multiple GPU detection methods (nvidia-smi, rocm-smi, /sys/class/drm)
- Handle different library paths
- AppImage distribution for portability

---

## Next Steps

### Immediate Actions

1. **Create Repository**:
   - Initialize new GitHub repo: `genai-electron`
   - Add LICENSE (MIT)
   - Add this DESIGN.md
   - Set up basic README

2. **Project Setup**:
   - Initialize npm package
   - Set up TypeScript configuration
   - Configure Jest for testing
   - Set up ESLint and Prettier

3. **Phase 1 Development**:
   - Start with SystemInfo module (foundation)
   - Then ModelManager (core feature)
   - Then LlamaServerManager (main value)
   - Create electron-control-panel example app with basic tabs (System Info, Models, LLM Server)
   - Basic examples and tests

### Success Metrics

**Phase 1: MVP - LLM Support**
- Library can download and run llama-server on all platforms
- At least 1 complete example Electron app
- Documentation covers basic usage
- Can make requests via genai-lite integration

**Phase 2: Image Generation**
- Supports local image generation with diffusion.cpp
- Automatic resource management works (offload/reload LLM when needed)
- Handles both sufficient and constrained resource scenarios
- Progress tracking for image generation

**Phase 3: Production Core**
- 60%+ test coverage
- Handles all common error scenarios with clear messages
- Download resume capability works reliably
- HuggingFace integration complete

**Phase 4: Production Polish**
- 80%+ test coverage
- Auto-restart on crash works reliably
- Configurable storage modes (isolated/shared/custom)
- Port conflict detection and handling
- Comprehensive monitoring and logging

**Phase 5: Optional Extensions**
- Features implemented based on user demand
- Used in at least one production app
- Advanced features have clear documentation

---

## Appendix

### References

- llama.cpp: https://github.com/ggml-org/llama.cpp
- diffusion.cpp: https://github.com/leejet/stable-diffusion.cpp
- genai-lite: (current repository)
- Electron: https://www.electronjs.org/
- HuggingFace: https://huggingface.co/

### Version History

- **0.1.0-draft** (2025-10-15): Initial design document
- **0.1.1-draft** (2025-10-15): Added Storage Strategy section clarifying per-app storage approach and future configurable storage plans
- **0.1.2-draft** (2025-10-15): Restructured Implementation Phases from 3 to 5 phases, moving image generation from "advanced" to core (Phase 2), and splitting production features into Core (Phase 3) and Polish (Phase 4)
- **0.1.3-draft** (2025-10-15): Finalized library naming as `genai-electron`; cleaned up Next Steps section by removing obsolete "Binary Preparation" and "Open Questions" sections; rewrote Success Metrics to align with 5-phase structure