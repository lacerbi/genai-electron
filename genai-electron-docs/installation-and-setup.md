# Installation and Setup

---

## Installation

Install via npm:

```bash
npm install genai-electron
```

**Peer Dependencies**:
```bash
npm install electron@>=25.0.0
```

**Important**: The library depends on Electron's `app.getPath('userData')` for model storage, so it must be initialized after Electron's 'ready' event. See [Integration Guide](integration-guide.md) for proper initialization patterns.

---

## Platform Requirements

### macOS
- Version 11+ (Big Sur and later)
- Architectures: Intel (x64), Apple Silicon (arm64)
- GPU: Metal support automatic on 2016+ Macs

### Windows
- Version 10+ (64-bit)
- Architecture: x64
- GPU: NVIDIA CUDA support (optional)

### Linux
- Distributions: Ubuntu 20.04+, Debian 11+, Fedora 35+
- Architecture: x64
- GPU: NVIDIA CUDA, AMD ROCm (experimental), Intel

**Technology Stack**: Node.js >=22.0.0, TypeScript ^5.7.2, zero runtime dependencies (Node.js built-ins only).

---

## GPU Drivers (Optional)

GPU acceleration is optional but recommended for performance.

**macOS**: Metal support is automatic on modern Macs (2016+). No driver installation needed.

**Windows/Linux NVIDIA**: Install latest NVIDIA drivers. CUDA toolkit is **not required** - bundled binaries include CUDA runtime.

**Linux AMD**: Install ROCm drivers (experimental support, may not work with all models).

**Linux Intel**: Automatic support with standard Linux graphics drivers.

---

## First Run Behavior

On first call to `llamaServer.start()` or `diffusionServer.start()`, the library automatically:

1. **Downloads appropriate binary** (~50-100MB) for your platform
2. **Tests GPU variants** in priority order: CUDA → Vulkan → CPU
3. **Runs real functionality tests**:
   - LLM: Generates 1 token with GPU layers enabled (`-ngl 1`)
   - Diffusion: Generates 64x64 image with 1 diffusion step
   - Verifies GPU actually works (not just that binary loads)
4. **Falls back automatically** if test fails (e.g., broken CUDA → Vulkan → CPU)
5. **Caches working variant** for fast subsequent starts

**Timing**:
- First start: 2-10 seconds (download + testing)
- Subsequent starts: ~0.5 seconds (checksum verification only)

**Validation Caching**:
After first successful validation, subsequent starts skip expensive tests and only verify binary integrity via checksum. Use `forceValidation: true` to re-run full tests after driver updates.

---

## Environment Variables

### Image Generation (HTTP API)

```bash
# TTL for image generation results (default: 5 minutes)
export IMAGE_RESULT_TTL_MS=300000

# Cleanup interval for old results (default: 1 minute)
export IMAGE_CLEANUP_INTERVAL_MS=60000
```

**When to use**: Adjust TTL if polling slowly - results expire after TTL and return "not found" errors.

**Note**: Binary download location is fixed to `userData/binaries/` (configurable storage planned for Phase 4).

---

## Verifying Installation

Quick verification test:

```typescript
import { app } from 'electron';
import { systemInfo, modelManager } from 'genai-electron';

app.whenReady().then(async () => {
  const capabilities = await systemInfo.detect();
  const models = await modelManager.listModels();
  console.log('✅ Installation verified');
  console.log(`CPU: ${capabilities.cpu.cores} cores, RAM: ${(capabilities.memory.total / 1024 ** 3).toFixed(1)}GB`);
  console.log(`Models: ${models.length}`);
  app.quit();
});
```

---

## What's Next?

After installation, proceed to:

1. **[System Detection](system-detection.md)** - Understand your hardware capabilities
2. **[Model Management](model-management.md)** - Download and manage models
3. **[LLM Server](llm-server.md)** or **[Image Generation](image-generation.md)** - Start using the library

For integration patterns, see **[Integration Guide](integration-guide.md)**.

For issues, check **[Troubleshooting](troubleshooting.md)**.
