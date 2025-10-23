# Installation and Setup

Complete guide to installing genai-electron and setting up your development environment.

---

## Table of Contents

- [Installation](#installation)
- [Peer Dependencies](#peer-dependencies)
- [Platform Requirements](#platform-requirements)
- [GPU Drivers (Optional)](#gpu-drivers-optional)
- [First Run Behavior](#first-run-behavior)
- [Environment Variables](#environment-variables)
- [Verifying Installation](#verifying-installation)

---

## Installation

Install via npm:

```bash
npm install genai-electron
```

Or with yarn:

```bash
yarn add genai-electron
```

---

## Peer Dependencies

genai-electron requires Electron as a peer dependency:

```bash
npm install electron@>=25.0.0
```

**Minimum Electron Version**: 25.0.0

The library depends on Electron's `app.getPath('userData')` for model storage paths, so it must be initialized after Electron's 'ready' event. See the [Integration Guide](integration-guide.md) for proper initialization patterns.

---

## Platform Requirements

genai-electron supports the following platforms:

### macOS

- **Version**: 11+ (Big Sur and later)
- **Architectures**: Intel (x64) and Apple Silicon (arm64)
- **GPU**: Metal support automatic on 2016+ Macs
- **Special Requirements**: None

### Windows

- **Version**: 10+ (64-bit)
- **Architectures**: x64
- **GPU**: NVIDIA CUDA support (optional)
- **Special Requirements**: None

### Linux

- **Distributions**: Ubuntu 20.04+, Debian 11+, Fedora 35+
- **Architectures**: x64
- **GPU**: NVIDIA CUDA, AMD ROCm (experimental), Intel
- **Special Requirements**: None

---

## GPU Drivers (Optional)

GPU acceleration is optional but recommended for better performance. The library works perfectly fine on CPU-only systems.

### macOS - Metal

Metal support is **automatic** on modern Macs (2016+). No driver installation needed.

To verify Metal support:
```bash
system_profiler SPDisplaysDataType
```

### Windows - NVIDIA CUDA

1. Install latest NVIDIA GPU drivers from [nvidia.com/drivers](https://nvidia.com/drivers)
2. CUDA toolkit is **not required** - the bundled binaries include CUDA runtime
3. Verify installation:
```bash
nvidia-smi
```

### Linux - NVIDIA CUDA

1. Install NVIDIA drivers:
```bash
# Ubuntu/Debian
sudo apt install nvidia-driver-535

# Fedora
sudo dnf install akmod-nvidia
```

2. Verify installation:
```bash
nvidia-smi
```

### Linux - AMD ROCm (Experimental)

AMD GPU support via ROCm is experimental:

1. Install ROCm: Follow [ROCm installation guide](https://rocmdocs.amd.com/en/latest/Installation_Guide/Installation-Guide.html)
2. Verify installation:
```bash
rocm-smi
```

**Note**: ROCm support is experimental and may not work with all models or configurations.

### Linux - Intel

Intel GPU support is automatic on systems with Intel integrated graphics. No special drivers needed beyond standard Linux graphics drivers.

---

## First Run Behavior

On the first call to `llamaServer.start()` or `diffusionServer.start()`, the library automatically:

1. **Downloads the appropriate binary** (~50-100MB) for your platform
2. **Tests GPU variants** in priority order:
   - CUDA (NVIDIA)
   - Vulkan (cross-platform)
   - CPU (fallback)
3. **Runs real functionality tests**:
   - LLM: Generates 1 token with GPU layers enabled (`-ngl 1`)
   - Diffusion: Generates tiny 64x64 image with 1 diffusion step
   - Verifies GPU actually works (not just that binary loads)
   - Parses output for GPU errors
4. **Falls back automatically** if test fails:
   - Example: Broken CUDA → tries Vulkan → CPU
   - Logs warnings but continues with working variant
5. **Caches the working variant** for fast subsequent starts

**What this means**:
- First start may take 2-10 seconds (download + testing)
- Subsequent starts are fast (~0.5 seconds with validation cache)
- Zero configuration required - works automatically

**Validation Caching**:
After the first successful validation, the library skips expensive validation tests and only verifies binary integrity via checksum:
- ✅ First start: Downloads → Runs Phase 1 & 2 tests → Saves validation cache
- ✅ Subsequent starts: Verifies checksum → Uses cached validation (fast)
- ✅ Modified binary: Checksum mismatch → Re-runs full validation
- ✅ Force validation: Use `forceValidation: true` after driver updates

---

## Environment Variables

genai-electron supports the following environment variables:

### llama.cpp Integration

```bash
# Base URL for llama.cpp server (if using external llama-server)
export LLAMACPP_API_BASE_URL=http://localhost:8080
```

**Default**: `http://localhost:8080`

**When to use**: If you're running llama-server manually outside of genai-electron, or on a different port.

### Image Generation

```bash
# TTL (time-to-live) for image generation results in milliseconds
export IMAGE_RESULT_TTL_MS=300000

# Cleanup interval for old results in milliseconds
export IMAGE_RESULT_CLEANUP_INTERVAL_MS=60000
```

**Defaults**:
- `IMAGE_RESULT_TTL_MS`: 300000 (5 minutes)
- `IMAGE_RESULT_CLEANUP_INTERVAL_MS`: 60000 (1 minute)

**When to use**: If you're using the HTTP API for async image generation and need to adjust how long results are stored before cleanup.

### Binary Management

```bash
# Force re-validation of binaries even if cached
# (Set in code via forceValidation: true, not environment variable)
```

**Note**: Binary download location is currently fixed to `userData/binaries/`. Configurable storage is planned for Phase 4.

---

## Verifying Installation

Create a simple test script to verify the installation:

```typescript
// test-install.ts
import { app } from 'electron';
import { systemInfo, modelManager } from 'genai-electron';

async function verifyInstallation() {
  console.log('Testing genai-electron installation...\n');

  // 1. Test system detection
  console.log('1. Testing system detection...');
  const capabilities = await systemInfo.detect();
  console.log('✅ System detection works');
  console.log(`   CPU: ${capabilities.cpu.cores} cores (${capabilities.cpu.model})`);
  console.log(`   RAM: ${(capabilities.memory.total / 1024 ** 3).toFixed(1)}GB`);
  console.log(`   GPU: ${capabilities.gpu.available ? `${capabilities.gpu.type} (${capabilities.gpu.name})` : 'none'}`);

  // 2. Test model manager
  console.log('\n2. Testing model manager...');
  const models = await modelManager.listModels();
  console.log(`✅ Model manager works`);
  console.log(`   Installed models: ${models.length}`);

  console.log('\n✅ Installation verified successfully!');
  console.log('\nNext steps:');
  console.log('  1. Download a model (see Model Management docs)');
  console.log('  2. Start a server (see LLM Server or Image Generation docs)');

  app.quit();
}

app.whenReady().then(verifyInstallation).catch((error) => {
  console.error('❌ Installation verification failed:', error);
  app.quit();
});
```

Run the test:
```bash
npx electron test-install.ts
```

Expected output:
```
Testing genai-electron installation...

1. Testing system detection...
✅ System detection works
   CPU: 8 cores (Intel Core i7-9700K)
   RAM: 16.0GB
   GPU: nvidia (NVIDIA GeForce RTX 2060)

2. Testing model manager...
✅ Model manager works
   Installed models: 0

✅ Installation verified successfully!

Next steps:
  1. Download a model (see Model Management docs)
  2. Start a server (see LLM Server or Image Generation docs)
```

---

## Technology Stack

genai-electron is built with:

- **Node.js**: 22.x LTS (native fetch, modern features)
- **Electron**: 34.x (peer dependency, minimum >=25.0.0)
- **TypeScript**: ^5.9.3 (strict mode, full type safety)
- **Runtime Dependencies**: Zero - uses only Node.js built-ins

The library uses ES modules (type: "module") with `.js` extensions for TypeScript imports (Node16 module resolution).

---

## What's Next?

After installation, proceed to:

1. **[System Detection](system-detection.md)** - Understand your hardware capabilities
2. **[Model Management](model-management.md)** - Download and manage models
3. **[LLM Server](llm-server.md)** or **[Image Generation](image-generation.md)** - Start using the library

For integration patterns, see the **[Integration Guide](integration-guide.md)**.

For issues, check **[Troubleshooting](troubleshooting.md)**.
