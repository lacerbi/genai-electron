# genai-electron

> **Version**: 0.3.0 | **Status**: Production Ready - LLM & Image Generation

Electron-specific library for managing local AI model servers (llama.cpp, stable-diffusion.cpp). Handles platform-specific operations to run AI models locally. Complements [genai-lite](https://github.com/lacerbi/genai-lite) for API abstraction.

## Features

- ✅ **System detection** - Auto-detect RAM, CPU, GPU, VRAM capabilities
- ✅ **Model management** - Download GGUF models with progress tracking and metadata extraction
- ✅ **LLM server** - Manage llama-server lifecycle with auto-configuration
- ✅ **Image generation** - Local image generation via stable-diffusion.cpp
- ✅ **Resource orchestration** - Automatic LLM offload/reload when memory constrained
- ✅ **Binary management** - Automatic binary download with GPU variant testing (CUDA→Vulkan→CPU)
- ✅ **TypeScript-first** - Full type safety, zero runtime dependencies

## Installation

```bash
npm install genai-electron
npm install electron@>=25.0.0  # Peer dependency
```

## Quick Start

```typescript
import { app } from 'electron';
import { systemInfo, modelManager, llamaServer } from 'genai-electron';

app.whenReady().then(async () => {
  // Detect capabilities
  const caps = await systemInfo.detect();
  console.log('RAM:', (caps.memory.total / 1024 ** 3).toFixed(1), 'GB');

  // Download model (if needed)
  await modelManager.downloadModel({
    source: 'url',
    url: 'https://huggingface.co/TheBloke/Llama-2-7B-GGUF/resolve/main/llama-2-7b.Q4_K_M.gguf',
    name: 'Llama 2 7B',
    type: 'llm'
  });

  // Start server with auto-config
  await llamaServer.start({
    modelId: 'llama-2-7b',
    port: 8080
  });

  console.log('Server ready on port 8080');
});
```

Use with [genai-lite](https://github.com/lacerbi/genai-lite) for AI interactions (chat, image generation).

## Documentation

📚 **[Complete Documentation](genai-electron-docs/index.md)** - Full API reference, guides, and examples

**Quick Links**:
- [Installation & Setup](genai-electron-docs/installation-and-setup.md)
- [System Detection](genai-electron-docs/system-detection.md)
- [Model Management](genai-electron-docs/model-management.md)
- [LLM Server](genai-electron-docs/llm-server.md)
- [Image Generation](genai-electron-docs/image-generation.md)
- [TypeScript Reference](genai-electron-docs/typescript-reference.md)
- [Troubleshooting](genai-electron-docs/troubleshooting.md)

## Example App

See **[electron-control-panel](examples/electron-control-panel/)** for a full-featured reference implementation.

## Platform Support

- **macOS**: 11+ (Intel, Apple Silicon with Metal)
- **Windows**: 10+ (64-bit, CPU and CUDA)
- **Linux**: Ubuntu 20.04+, Debian 11+, Fedora 35+ (CPU, CUDA, ROCm)

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Related Projects

- **[genai-lite](https://github.com/lacerbi/genai-lite)** - Lightweight API abstraction for AI providers (cloud and local)
