# genai-electron

> **Version**: 0.1.0 (Phase 1 MVP - In Development)
> **Status**: Early Development - Not Yet Ready for Production

An Electron-specific library for managing local AI model servers and resources. Complements [genai-lite](https://github.com/yourusername/genai-lite) by handling platform-specific operations required to run AI models locally on desktop systems.

## Overview

`genai-electron` manages the runtime infrastructure for running local AI models (llama.cpp, stable-diffusion.cpp) in Electron applications, while `genai-lite` provides the high-level API abstraction layer for communicating with these models.

**The Ecosystem**:
- **genai-lite**: Lightweight, portable API abstraction layer for AI providers (cloud and local)
- **genai-electron**: Electron-specific runtime management (this library)

## Features (Phase 1 MVP)

- ✅ System capability detection (RAM, CPU, GPU, VRAM)
- ✅ Model storage in Electron userData directory
- ✅ Download GGUF models from direct URLs
- ✅ Start/stop llama-server processes
- ✅ Health checking and status monitoring
- ✅ TypeScript-first with full type safety
- ✅ Zero runtime dependencies (uses Node.js built-ins)

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
  console.log('System can run models up to:', capabilities.recommendations.maxModelSize);

  // 2. Download a model (if not already installed)
  const models = await modelManager.listModels('llm');
  if (models.length === 0) {
    console.log('Downloading Llama-2-7B...');
    await modelManager.downloadModel({
      source: 'url',
      url: 'https://example.com/llama-2-7b.Q4_K_M.gguf',
      name: 'Llama 2 7B',
      type: 'llm',
      onProgress: (downloaded, total) => {
        console.log(`Progress: ${((downloaded / total) * 100).toFixed(1)}%`);
      },
    });
  }

  // 3. Start llama-server with auto-detected settings
  const firstModel = models[0] || (await modelManager.listModels('llm'))[0];
  await llamaServer.start({
    modelId: firstModel.id,
    port: 8080,
    // threads, gpuLayers, contextSize all auto-detected
  });

  console.log('llama-server is running on port 8080');

  // 4. Use with genai-lite
  const llmService = new LLMService(async () => 'not-needed');
  const response = await llmService.sendMessage({
    providerId: 'llamacpp',
    modelId: 'llama-2-7b',
    messages: [{ role: 'user', content: 'Hello!' }],
  });

  console.log(response.choices[0].message.content);
}

// Cleanup on app quit
app.on('before-quit', async () => {
  await llamaServer.stop();
});

// Run setup
setupLocalAI().catch(console.error);
```

## API Overview

### SystemInfo

Detect system capabilities and provide intelligent recommendations:

```typescript
import { systemInfo } from 'genai-electron';

// Detect hardware
const capabilities = await systemInfo.detect();
console.log(capabilities.cpu, capabilities.memory, capabilities.gpu);

// Check if model can run
const canRun = await systemInfo.canRunModel(modelInfo);

// Get optimal configuration
const config = await systemInfo.getOptimalConfig(modelInfo);
```

### ModelManager

Download and manage GGUF models:

```typescript
import { modelManager } from 'genai-electron';

// List installed models
const models = await modelManager.listModels('llm');

// Download a model
await modelManager.downloadModel({
  source: 'url',
  url: 'https://example.com/model.gguf',
  name: 'My Model',
  type: 'llm',
  onProgress: (downloaded, total) => {
    console.log(`${((downloaded / total) * 100).toFixed(1)}%`);
  },
});

// Delete a model
await modelManager.deleteModel(modelId);

// Verify model integrity
await modelManager.verifyModel(modelId);
```

### LlamaServerManager

Manage llama-server lifecycle:

```typescript
import { llamaServer } from 'genai-electron';

// Start server (auto-downloads binary on first run)
await llamaServer.start({
  modelId: 'my-model',
  port: 8080,
  threads: 8,
  gpuLayers: 35,
  contextSize: 4096,
});

// Check status
const status = llamaServer.getStatus();
const healthy = await llamaServer.isHealthy();

// Get logs
const logs = await llamaServer.getLogs();

// Stop server
await llamaServer.stop();

// Listen to events
llamaServer.on('started', () => console.log('Server started'));
llamaServer.on('stopped', () => console.log('Server stopped'));
llamaServer.on('crashed', (error) => console.error('Server crashed:', error));
```

## Architecture

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
│  └────────┬───────┘      └────────┬─────────┘  │
│           │                       │            │
└───────────┼───────────────────────┼────────────┘
            │                       │
            │ HTTP requests         │ spawns/manages
            │                       ▼
            │              ┌─────────────────────┐
            └─────────────►│  llama-server       │
                           │  (port 8080)        │
                           └─────────────────────┘
```

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

### Phase 1: MVP - LLM Support (Current)
- ✅ System capability detection
- ✅ Model download and storage
- ✅ llama-server management
- ✅ Basic documentation

### Phase 2: Image Generation
- 🔄 diffusion.cpp integration
- 🔄 Resource management between LLM and diffusion
- 🔄 Progress tracking for image generation

### Phase 3: Production Core
- 🔄 Resume interrupted downloads
- 🔄 SHA256 checksum verification
- 🔄 HuggingFace Hub integration
- 🔄 Comprehensive testing

### Phase 4: Production Polish
- 🔄 Auto-restart on crash
- 🔄 Log rotation
- 🔄 Port conflict detection
- 🔄 Shared storage configuration

## Documentation

- [DESIGN.md](DESIGN.md) - Complete architecture and design document
- [PLAN.md](PLAN.md) - Phase 1 implementation plan
- [PROGRESS.md](PROGRESS.md) - Current implementation progress
- [API.md](docs/API.md) - Complete API reference (coming soon)
- [SETUP.md](docs/SETUP.md) - Development setup guide (coming soon)

## Contributing

Contributions are welcome! This project is in early development. Please see [PLAN.md](PLAN.md) for the current implementation roadmap.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

Originally developed as part of the Athanor project, genai-electron has been extracted and made standalone to benefit the wider developer community.

---

**Note**: This library is under active development. APIs may change before the 1.0.0 release.
