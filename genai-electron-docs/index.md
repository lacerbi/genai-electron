# genai-electron Documentation

> **Version**: 0.5.0 (Multi-Component Diffusion Models & Shared Variant Downloads)
> **Status**: Production Ready - LLM & Image Generation

Complete documentation for genai-electron - An Electron-specific library for managing local AI model servers and resources.

---

## Navigation

### Getting Started
- **[Installation and Setup](installation-and-setup.md)** - Installation, requirements, platform support, GPU drivers
- Quick starts are on this page below

### Core APIs
- **[System Detection](system-detection.md)** - SystemInfo API for hardware capability detection
- **[Model Management](model-management.md)** - ModelManager API for downloading and managing GGUF models
- **[LLM Server](llm-server.md)** - LlamaServerManager API for running local LLMs
- **[Image Generation](image-generation.md)** - DiffusionServerManager API for local image generation
- **[Resource Orchestration](resource-orchestration.md)** - ResourceOrchestrator for managing both LLM and image servers

### Integration & Reference
- **[Integration Guide](integration-guide.md)** - Electron patterns, lifecycle management, error handling
- **[TypeScript Reference](typescript-reference.md)** - Complete type definitions and interfaces
- **[Troubleshooting](troubleshooting.md)** - Common issues, error codes, FAQ

### Migration
- **[Migrating from v0.4.x to v0.5.0](migration-0-4-to-0-5.md)** - Multi-component models, presets, Flux 2 Klein

### Examples
- **[Example: Control Panel](example-control-panel.md)** - Reference implementation patterns

---

## Overview

genai-electron manages the runtime infrastructure for running local AI models (llama.cpp, stable-diffusion.cpp) in Electron applications, while genai-lite provides the high-level API abstraction layer for communicating with these models.

**The Ecosystem**:
- **genai-lite**: Lightweight, portable API abstraction layer for AI providers (cloud and local)
- **genai-electron**: Electron-specific runtime management (this library)

**Core Features**:
- ✅ **System capability detection** - Automatic detection of RAM, CPU, GPU, and VRAM
- ✅ **Model storage** - Organized model management in Electron userData directory
- ✅ **Model downloads** - Download GGUF models from direct URLs with progress tracking
- ✅ **GGUF metadata extraction** - Accurate model information (layer count, context length, architecture) extracted before download
- ✅ **LLM server lifecycle** - Start/stop llama-server processes with auto-configuration
- ✅ **Reasoning model support** - Automatic detection and configuration for reasoning-capable models (Qwen3, DeepSeek-R1, GPT-OSS)
- ✅ **Image generation** - Local image generation via stable-diffusion.cpp
- ✅ **Async image generation API** - HTTP endpoints with polling pattern for non-blocking generation
- ✅ **Batch generation** - Generate multiple image variations in one request (1-5 images)
- ✅ **Resource orchestration** - Automatic LLM offload/reload when generating images
- ✅ **Health monitoring** - Real-time server health checks and status tracking
- ✅ **Structured logs** - Parse server logs into typed objects for easy filtering and display
- ✅ **Binary management** - Automatic binary download and verification on first run
- ✅ **Progress tracking** - Real-time progress updates for image generation
- ✅ **TypeScript-first** - Full type safety with comprehensive type definitions
- ✅ **Minimal runtime dependencies** - Three small packages (adm-zip, @huggingface/gguf, tar); everything else uses Node.js built-ins

---

## Quick Start: LLM

```typescript
import { app } from 'electron';
import { LLMService } from 'genai-lite';
import { systemInfo, modelManager, llamaServer, attachAppLifecycle } from 'genai-electron';

async function setupLocalAI() {
  // 1. Detect system capabilities
  const capabilities = await systemInfo.detect();
  console.log('System capabilities:', {
    cpu: capabilities.cpu.cores,
    ram: `${(capabilities.memory.total / 1024 / 1024 / 1024).toFixed(1)}GB`,
    gpu: capabilities.gpu.available ? capabilities.gpu.type ?? 'unknown' : 'none',
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
      // GGUF metadata is automatically extracted before download
      // Provides: layer count, context length, architecture, etc.
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

// Run setup when app is ready
app.whenReady().then(setupLocalAI).catch(console.error);

// Automatic cleanup on app quit
attachAppLifecycle(app, { llamaServer });
```

---

## Quick Start: Image Generation

```typescript
import { app } from 'electron';
import { ImageService } from 'genai-lite';
import { modelManager, diffusionServer, attachAppLifecycle } from 'genai-electron';
import { promises as fs } from 'fs';

async function setupImageGeneration() {
  // 1. Download a diffusion model (if needed)
  const models = await modelManager.listModels('diffusion');

  if (models.length === 0) {
    console.log('Downloading SDXL Turbo...');
    await modelManager.downloadModel({
      source: 'huggingface',
      repo: 'stabilityai/sdxl-turbo',
      file: 'sdxl-turbo.gguf',
      name: 'SDXL Turbo',
      type: 'diffusion',
      onProgress: (downloaded, total) => {
        const percent = ((downloaded / total) * 100).toFixed(1);
        console.log(`Download progress: ${percent}%`);
      }
    });
  }

  // 2. Start diffusion server
  const firstModel = models[0] || (await modelManager.listModels('diffusion'))[0];

  await diffusionServer.start({
    modelId: firstModel.id,
    port: 8081
    // Auto-configured: threads, gpuLayers
  });

  console.log('Diffusion server is running on port 8081');

  // 3. Generate an image using genai-lite
  const imageService = new ImageService(async () => 'not-needed');

  const result = await imageService.generateImage({
    providerId: 'genai-electron-images',
    modelId: firstModel.id,
    prompt: 'A serene mountain landscape at sunset, 4k, detailed',
    settings: {
      width: 1024,
      height: 1024,
      diffusion: {
        negativePrompt: 'blurry, low quality',
        steps: 30,
        cfgScale: 7.5,
        sampler: 'dpm++2m',
        onProgress: (progress) => {
          console.log(`${progress.stage}: ${Math.round(progress.percentage || 0)}%`);
        }
      }
    }
  });

  if (result.object === 'image.result') {
    await fs.writeFile('output.png', result.data[0].data);
    console.log('Image saved to output.png');
  }
}

// Run setup when app is ready
app.whenReady().then(setupImageGeneration).catch(console.error);

// Automatic cleanup
attachAppLifecycle(app, { diffusionServer });
```

---

## Quick Start: LLM + Image Generation (with Resource Orchestration)

```typescript
import { app } from 'electron';
import { systemInfo, modelManager, llamaServer, diffusionServer, attachAppLifecycle } from 'genai-electron';

async function setupBothServices() {
  // 1. Detect system capabilities
  const capabilities = await systemInfo.detect();
  console.log('System:', {
    cpu: `${capabilities.cpu.cores} cores`,
    ram: `${(capabilities.memory.total / 1024 ** 3).toFixed(1)}GB`,
    gpu: capabilities.gpu.available ? `${capabilities.gpu.type ?? 'unknown'} (${((capabilities.gpu.vram ?? 0) / 1024 ** 3).toFixed(1)}GB)` : 'none',
  });

  // 2. Start LLM server
  const llmModels = await modelManager.listModels('llm');
  await llamaServer.start({
    modelId: llmModels[0].id,
    port: 8080,
  });
  console.log('LLM server running');

  // 3. Start diffusion server
  const diffusionModels = await modelManager.listModels('diffusion');
  await diffusionServer.start({
    modelId: diffusionModels[0].id,
    port: 8081,
  });
  console.log('Diffusion server running');

  // 4. Generate image (automatic resource management - LLM offloaded if needed)
  console.log('Generating image...');
  const imageResult = await diffusionServer.generateImage({
    prompt: 'A peaceful zen garden with cherry blossoms',
    width: 1024,
    height: 1024,
    steps: 30,
    onProgress: (step, total, stage, percentage) => {
      console.log(`Progress (${stage}): ${Math.round(percentage || 0)}%`);
    },
  });

  console.log('Image generated in', imageResult.timeTaken, 'ms');
  // LLM server is still running (or automatically restarted if it was offloaded)

  // 5. Chat with LLM (automatically reloaded if it was offloaded)
  // Use genai-lite here for LLM interactions...
}

// Run setup and attach automatic cleanup
app.whenReady().then(setupBothServices).catch(console.error);
attachAppLifecycle(app, { llamaServer, diffusionServer });
```

**Key Feature**: When system resources are constrained (limited RAM or VRAM), the library automatically:
- Detects if both LLM and diffusion servers can run simultaneously
- Temporarily offloads the LLM server if needed before image generation
- Generates the image
- Restores the LLM server to its previous state

No additional code needed - it just works! See [Resource Orchestration](resource-orchestration.md) for details.

---

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
  - Tests variants in platform-specific priority order (e.g., CUDA → Vulkan → CPU on Linux/Windows)
  - Runs real GPU inference test (1 token for LLM, 64x64 image for diffusion)
  - Detects CUDA errors and automatically falls back to Vulkan
  - Caches working variant for fast subsequent starts
  - Zero configuration required - works automatically

---

## What's Next?

**Get Started**:
1. [Installation and Setup](installation-and-setup.md) - Install the library and set up your environment
2. [System Detection](system-detection.md) - Understand your hardware capabilities
3. [Model Management](model-management.md) - Download and manage models

**Core Features**:
4. [LLM Server](llm-server.md) - Run local LLMs with llama.cpp
5. [Image Generation](image-generation.md) - Generate images with stable-diffusion.cpp
6. [Resource Orchestration](resource-orchestration.md) - Manage both services on limited resources

**Integration**:
7. [Integration Guide](integration-guide.md) - Electron patterns and best practices
8. [Example: Control Panel](example-control-panel.md) - Study the reference implementation

**Reference**:
9. [TypeScript Reference](typescript-reference.md) - Complete type definitions
10. [Troubleshooting](troubleshooting.md) - Common issues and solutions

---

## Additional Resources

**Repository**: [genai-electron on GitHub](https://github.com/lacerbi/genai-electron)

**Related Projects**:
- **genai-lite** (v0.5.1): Lightweight API abstraction layer for AI providers (cloud and local)
  - Repository: https://github.com/lacerbi/genai-lite

**Examples**:
- `examples/electron-control-panel/` - Full-featured Electron app showcasing all library features

**License**: MIT
