# genai-electron

> **Version**: 0.2.0 (Phase 2 - Image Generation Complete)
> **Status**: Production Ready - LLM & Image Generation

An Electron-specific library for managing local AI model servers and resources. Complements [genai-lite](https://github.com/lacerbi/genai-lite) by handling platform-specific operations required to run AI models locally on desktop systems.

## Overview

`genai-electron` manages the runtime infrastructure for running local AI models (llama.cpp, stable-diffusion.cpp) in Electron applications, while `genai-lite` provides the high-level API abstraction layer for communicating with these models.

**The Ecosystem**:
- **genai-lite**: Lightweight, portable API abstraction layer for AI providers (cloud and local)
- **genai-electron**: Electron-specific runtime management (this library)

## Features

### Core Features (Phase 1 & 2 - Complete)

- ✅ **System capability detection** - Automatic detection of RAM, CPU, GPU, and VRAM
- ✅ **Model storage** - Organized model management in Electron userData directory
- ✅ **Model downloads** - Download GGUF models from direct URLs with progress tracking
- ✅ **LLM server lifecycle** - Start/stop llama-server processes with auto-configuration
- ✅ **Reasoning model support** - Automatic detection and configuration for reasoning-capable models (Qwen3, DeepSeek-R1, GPT-OSS)
- ✅ **Image generation** - Local image generation via stable-diffusion.cpp
- ✅ **Resource orchestration** - Automatic LLM offload/reload when generating images
- ✅ **Health monitoring** - Real-time server health checks and status tracking
- ✅ **Binary management** - Automatic binary download and verification on first run
- ✅ **Progress tracking** - Real-time progress updates for image generation
- ✅ **TypeScript-first** - Full type safety with comprehensive type definitions
- ✅ **Zero runtime dependencies** - Uses only Node.js built-ins

## Installation

```bash
npm install genai-electron
```

**Peer Dependencies**:
```bash
npm install electron@>=25.0.0
```

## Quick Start

```typescript
import { app } from 'electron';
import { LLMService } from 'genai-lite';
import { systemInfo, modelManager, llamaServer } from 'genai-electron';

async function setupLocalAI() {
  // 1. Detect system capabilities
  const capabilities = await systemInfo.detect();
  console.log('System capabilities:', {
    cpu: capabilities.cpu.cores,
    ram: `${(capabilities.memory.total / 1024 / 1024 / 1024).toFixed(1)}GB`,
    gpu: capabilities.gpu.available ? capabilities.gpu.type : 'none',
    maxModelSize: capabilities.recommendations.maxModelSize
  });

  // 2. Download a model (if not already installed)
  const models = await modelManager.listModels('llm');

  if (models.length === 0) {
    console.log('Downloading Llama-2-7B...');
    await modelManager.downloadModel({
      source: 'url',
      url: 'https://huggingface.co/TheBloke/Llama-2-7B-GGUF/resolve/main/llama-2-7b.Q4_K_M.gguf',
      name: 'Llama 2 7B',
      type: 'llm',
      onProgress: (downloaded, total) => {
        const percent = ((downloaded / total) * 100).toFixed(1);
        console.log(`Download progress: ${percent}%`);
      },
    });
  }

  // 3. Start llama-server with auto-detected settings
  const firstModel = models[0] || (await modelManager.listModels('llm'))[0];

  await llamaServer.start({
    modelId: firstModel.id,
    port: 8080,
    // Auto-configured based on system capabilities:
    // - threads: Optimal thread count for your CPU
    // - gpuLayers: Maximum layers for your GPU (if available)
    // - contextSize: Appropriate context window
  });

  console.log('llama-server is running on port 8080');
  console.log('Server status:', llamaServer.getStatus());

  // 4. Use with genai-lite for AI interactions
  const llmService = new LLMService(async () => 'not-needed');
  const response = await llmService.sendMessage({
    providerId: 'llamacpp',
    modelId: firstModel.id,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Explain quantum computing in simple terms.' }
    ],
  });

  if (response.object === 'chat.completion') {
    console.log('AI Response:', response.choices[0].message.content);
  }
}

// Cleanup on app quit
app.on('before-quit', async () => {
  console.log('Shutting down llama-server...');
  await llamaServer.stop();
});

// Run setup when app is ready
app.whenReady().then(setupLocalAI).catch(console.error);
```

> **Note**: For image generation examples using `diffusionServer` and `ResourceOrchestrator`, see the [Complete Example](#complete-example-llm--image-generation) section below.

## API Overview

### SystemInfo

Detect system capabilities and provide intelligent recommendations:

```typescript
import { systemInfo } from 'genai-electron';

// Detect all hardware capabilities
const capabilities = await systemInfo.detect();
console.log('CPU:', capabilities.cpu.cores, 'cores');
console.log('RAM:', capabilities.memory.total, 'bytes');
console.log('GPU:', capabilities.gpu.available ? capabilities.gpu.name : 'none');
console.log('Recommended max model size:', capabilities.recommendations.maxModelSize);

// Check if a specific model can run
const modelInfo = await modelManager.getModelInfo('llama-2-7b');
const canRun = await systemInfo.canRunModel(modelInfo);
if (canRun.canRun) {
  console.log('Model can run on this system');
} else {
  console.log('Cannot run model:', canRun.reason);
}

// Get optimal configuration for a model
const optimalConfig = await systemInfo.getOptimalConfig(modelInfo);
console.log('Recommended config:', {
  threads: optimalConfig.threads,
  gpuLayers: optimalConfig.gpuLayers,
  contextSize: optimalConfig.contextSize
});

// Real-time memory check
const memory = systemInfo.getMemoryInfo();
console.log('Available RAM:', memory.available, 'bytes');
```

### ModelManager

Download and manage GGUF models:

```typescript
import { modelManager } from 'genai-electron';

// List installed models
const models = await modelManager.listModels('llm');
console.log('Installed models:', models.length);

// Download a model from direct URL
await modelManager.downloadModel({
  source: 'url',
  url: 'https://example.com/model.gguf',
  name: 'My Model',
  type: 'llm',
  checksum: 'sha256:abc123...', // Optional but recommended
  onProgress: (downloaded, total) => {
    const percent = ((downloaded / total) * 100).toFixed(1);
    console.log(`Progress: ${percent}%`);
  },
});

// Download from HuggingFace (convenience method)
await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'TheBloke/Llama-2-7B-GGUF',
  file: 'llama-2-7b.Q4_K_M.gguf',
  name: 'Llama 2 7B',
  type: 'llm',
  onProgress: (downloaded, total) => {
    console.log(`Downloaded: ${downloaded}/${total} bytes`);
  },
});

// Get model information
const modelInfo = await modelManager.getModelInfo('my-model');
console.log('Model size:', modelInfo.size, 'bytes');
console.log('Downloaded:', modelInfo.downloadedAt);

// Check if model supports reasoning
if (modelInfo.supportsReasoning) {
  console.log('✅ Model supports reasoning (automatic flag injection enabled)');
  console.log('llama-server will use: --jinja --reasoning-format deepseek');
}

// Verify model integrity
const isValid = await modelManager.verifyModel('my-model');
console.log('Model is valid:', isValid);

// Delete a model
await modelManager.deleteModel('my-model');
```

### LlamaServerManager

Manage llama-server lifecycle:

```typescript
import { llamaServer } from 'genai-electron';

// Start server with auto-configuration
await llamaServer.start({
  modelId: 'my-model',
  port: 8080,
  // Auto-detected optimal settings applied
});

// Start with custom configuration
await llamaServer.start({
  modelId: 'my-model',
  port: 8080,
  threads: 8,          // Override auto-detection
  gpuLayers: 35,       // Offload 35 layers to GPU
  contextSize: 4096,   // 4K context window
  parallelRequests: 4, // Handle 4 concurrent requests
  flashAttention: true // Enable flash attention
});

// Check server status
const status = llamaServer.getStatus();
console.log('Server status:', status.status); // 'running', 'stopped', etc.
console.log('Server PID:', status.pid);
console.log('Server port:', status.port);

// Check server health
const isHealthy = await llamaServer.isHealthy();
console.log('Server is healthy:', isHealthy);

// Get recent logs
const logs = await llamaServer.getLogs();
console.log('Recent logs:', logs);

// Restart server
await llamaServer.restart();

// Stop server
await llamaServer.stop();

// Listen to events
llamaServer.on('started', () => {
  console.log('Server started successfully');
});

llamaServer.on('stopped', () => {
  console.log('Server stopped');
});

llamaServer.on('crashed', (error) => {
  console.error('Server crashed:', error);
});
```

### Reasoning Models

genai-electron automatically detects and configures reasoning-capable models that use `<think>...</think>` tags for chain-of-thought reasoning:

```typescript
import { detectReasoningSupport, REASONING_MODEL_PATTERNS } from 'genai-electron';

// Check if a model supports reasoning based on filename
const supportsReasoning = detectReasoningSupport('Qwen3-8B-Instruct-Q4_K_M.gguf');
console.log('Supports reasoning:', supportsReasoning); // true

// View known patterns
console.log('Known patterns:', REASONING_MODEL_PATTERNS);
// ['qwen3', 'deepseek-r1', 'gpt-oss']
```

**Supported model families**:
- **Qwen3**: All sizes (0.6B, 1.7B, 4B, 8B, 14B, 30B)
- **DeepSeek-R1**: All variants including distilled models
- **GPT-OSS**: OpenAI's open-source reasoning model

**How it works**:
1. ModelManager detects reasoning support from GGUF filename during download
2. Stores `supportsReasoning: true` in model metadata
3. LlamaServerManager automatically adds `--jinja --reasoning-format deepseek` flags when starting the server
4. Use with genai-lite to access reasoning traces via the `reasoning` field in responses

For complete API details, see [docs/API.md](docs/API.md#reasoning-model-detection).

### DiffusionServerManager (Phase 2)

Generate images locally using stable-diffusion.cpp:

```typescript
import { diffusionServer } from 'genai-electron';

// Start diffusion server
await diffusionServer.start({
  modelId: 'sdxl-turbo',  // Your downloaded diffusion model
  port: 8081,
  gpuLayers: 35,          // Offload layers to GPU (optional)
  threads: 8,             // CPU threads (optional)
});

// Generate an image
const result = await diffusionServer.generateImage({
  prompt: 'A serene mountain landscape at sunset',
  negativePrompt: 'blurry, low quality',
  width: 1024,
  height: 1024,
  steps: 30,
  cfgScale: 7.5,
  seed: 12345,
  sampler: 'euler_a',
  onProgress: (currentStep, totalSteps) => {
    console.log(`Progress: ${currentStep}/${totalSteps}`);
  },
});

// Result contains the generated image
console.log('Image generated in', result.timeTaken, 'ms');
fs.writeFileSync('output.png', result.image);  // Save image buffer

// Stop server
await diffusionServer.stop();
```

### ResourceOrchestrator (Phase 2)

Automatically manage resources between LLM and image generation:

```typescript
import { ResourceOrchestrator } from 'genai-electron';
import { systemInfo, llamaServer, diffusionServer, modelManager } from 'genai-electron';

// Create orchestrator
const orchestrator = new ResourceOrchestrator(
  systemInfo,
  llamaServer,
  diffusionServer,
  modelManager
);

// Start LLM server
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  gpuLayers: 35,
});

// Start diffusion server
await diffusionServer.start({
  modelId: 'sdxl-turbo',
  port: 8081,
});

// Generate image with automatic resource management
// If resources are constrained, the LLM will be automatically:
// 1. Stopped before generation
// 2. Reloaded after generation completes
const result = await orchestrator.orchestrateImageGeneration({
  prompt: 'A beautiful sunset over mountains',
  width: 1024,
  height: 1024,
  steps: 30,
  onProgress: (step, total) => {
    console.log(`Generation: ${step}/${total}`);
  },
});

// Check if offload would be needed
const wouldOffload = await orchestrator.wouldNeedOffload();
console.log('Would need to offload LLM:', wouldOffload);

// Get saved LLM state (if offloaded)
const savedState = orchestrator.getSavedState();
if (savedState) {
  console.log('LLM was offloaded at:', savedState.savedAt);
  console.log('Original config:', savedState.config);
}
```

### Complete Example: LLM + Image Generation

```typescript
import { app } from 'electron';
import { systemInfo, modelManager, llamaServer, diffusionServer, ResourceOrchestrator } from 'genai-electron';

async function setupAI() {
  // 1. Detect system capabilities
  const capabilities = await systemInfo.detect();
  console.log('System:', {
    cpu: `${capabilities.cpu.cores} cores`,
    ram: `${(capabilities.memory.total / 1024 ** 3).toFixed(1)}GB`,
    gpu: capabilities.gpu.available ? `${capabilities.gpu.type} (${(capabilities.gpu.vram / 1024 ** 3).toFixed(1)}GB)` : 'none',
  });

  // 2. Start LLM server
  await llamaServer.start({
    modelId: 'llama-2-7b',
    port: 8080,
  });
  console.log('LLM server running');

  // 3. Start diffusion server
  await diffusionServer.start({
    modelId: 'sdxl-turbo',
    port: 8081,
  });
  console.log('Diffusion server running');

  // 4. Create orchestrator for automatic resource management
  const orchestrator = new ResourceOrchestrator(
    systemInfo,
    llamaServer,
    diffusionServer,
    modelManager
  );

  // 5. Generate image (LLM will auto-offload if needed)
  console.log('Generating image...');
  const imageResult = await orchestrator.orchestrateImageGeneration({
    prompt: 'A peaceful zen garden with cherry blossoms',
    width: 1024,
    height: 1024,
    steps: 30,
    onProgress: (step, total) => {
      console.log(`Progress: ${((step / total) * 100).toFixed(1)}%`);
    },
  });

  console.log('Image generated in', imageResult.timeTaken, 'ms');

  // 6. Chat with LLM (automatically reloaded if it was offloaded)
  // Use genai-lite here for LLM interactions...
}

// Cleanup
app.on('before-quit', async () => {
  await llamaServer.stop();
  await diffusionServer.stop();
});

app.whenReady().then(setupAI).catch(console.error);
```

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    Electron Application                        │
│                                                                │
│  ┌────────────────┐      ┌──────────────────────────────────┐  │
│  │  genai-lite    │      │      genai-electron              │  │
│  │  (API layer)   │◄─────│      (Runtime manager)           │  │
│  │                │      │                                  │  │
│  │ • sendMessage  │      │ • SystemInfo                     │  │
│  │ • generateImg  │      │ • ModelManager                   │  │
│  │ • providers    │      │ • LlamaServerManager             │  │
│  │ • templates    │      │ • DiffusionServerManager         │  │
│  │                │      │ • ResourceOrchestrator           │  │
│  └────────┬───────┘      └────────┬─────────────────────────┘  │
│           │                       │                            │
└───────────┼───────────────────────┼────────────────────────────┘
            │                       │
            │ HTTP requests         │ spawns/manages
            │                       ▼
            │              ┌─────────────────────┐
            ├─────────────►│  llama-server       │
            │              │  (port 8080)        │
            │              │  [LLM inference]    │
            │              └─────────────────────┘
            │              ┌─────────────────────┐
            └─────────────►│  HTTP wrapper       │
                           │  (port 8081)        │
                           │  [Image generation] │
                           │    ↓ spawns         │
                           │  stable-diffusion   │
                           │  .cpp executable    │
                           └─────────────────────┘
```

**Key features**:
- **LLM inference**: Native llama-server (HTTP server from llama.cpp)
- **Image generation**: HTTP wrapper created by genai-electron that spawns stable-diffusion.cpp
- **Resource management**: ResourceOrchestrator automatically offloads LLM when resources are constrained
- **Automatic reasoning**: Reasoning-capable models get `--jinja --reasoning-format deepseek` flags automatically
- **Binary management**: Automatic variant selection with real GPU functionality testing
  - Downloads appropriate binary on first `start()` call (~50-100MB)
  - Tests variants in priority order: CUDA → Vulkan → CPU
  - Runs real GPU inference test (1 token for LLM, 64x64 image for diffusion)
  - Detects CUDA errors and automatically falls back to Vulkan
  - Caches working variant for fast subsequent starts
  - Zero configuration required - works automatically

## Platform Support

- **macOS**: 11+ (Intel and Apple Silicon with Metal)
- **Windows**: 10+ (64-bit, CPU and CUDA support)
- **Linux**: Ubuntu 20.04+, Debian 11+, Fedora 35+ (CPU, CUDA, ROCm)

## Technology Stack

- **Node.js**: 22.x LTS (native fetch, modern features)
- **Electron**: 34.x (peer dependency, minimum >=25.0.0)
- **TypeScript**: ^5.9.3
- **Zero runtime dependencies** - uses Node.js built-ins only

## Development Roadmap

### Phase 1: MVP - LLM Support ✅ COMPLETE
- ✅ System capability detection
- ✅ Model download and storage
- ✅ llama-server management
- ✅ Basic documentation
- ✅ Test infrastructure
- ✅ Binary management

### Phase 2: Image Generation ✅ COMPLETE
- ✅ stable-diffusion.cpp integration
- ✅ DiffusionServerManager HTTP wrapper
- ✅ Resource orchestration between LLM and diffusion
- ✅ Automatic LLM offload/reload on resource constraints
- ✅ Progress tracking for image generation
- ✅ Binary management with variant testing
- ✅ Real CUDA functionality testing (detects broken GPU before caching)
- ✅ Comprehensive testing (231 tests passing, 100% pass rate)

### Phase 3: Production Core (Next)
- 🔄 Resume interrupted downloads
- 🔄 SHA256 checksum verification (enhanced)
- 🔄 HuggingFace Hub integration (enhanced)
- 🔄 Advanced cancellation API
- 🔄 Multi-model queue management

### Phase 4: Production Polish
- 🔄 Auto-restart on crash
- 🔄 Log rotation
- 🔄 Port conflict detection
- 🔄 Shared storage configuration

## Documentation

- **[API.md](docs/API.md)** - Complete API reference with examples
- **[SETUP.md](docs/SETUP.md)** - Development setup guide
- **[DESIGN.md](DESIGN.md)** - Complete architecture and design document
- **[PROGRESS.md](PROGRESS.md)** - Current implementation progress
- **[docs/dev/phase1/](docs/dev/phase1/)** - Phase 1 detailed planning and progress logs

## Error Handling

All operations provide clear, actionable error messages:

```typescript
try {
  await modelManager.downloadModel(config);
} catch (error) {
  if (error instanceof InsufficientResourcesError) {
    console.error('Not enough disk space:', error.message);
    console.log('Suggestion:', error.details.suggestion);
  } else if (error instanceof DownloadError) {
    console.error('Download failed:', error.message);
    // Retry or handle network issues
  } else if (error instanceof ModelNotFoundError) {
    console.error('Model not found:', error.message);
  }
}
```

## Examples

Complete example applications demonstrating genai-electron usage:

- **[electron-control-panel](examples/electron-control-panel/)** - Full-featured Electron app showcasing all library features (coming in Phase 2+)

## License

MIT License - see [LICENSE](LICENSE) file for details.