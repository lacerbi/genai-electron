# Installation and Setup

---

## Installation

Install via npm:

```bash
npm install genai-electron
```

**Peer dependency for root manager APIs**:
```bash
npm install electron@>=25.0.0
```

Electron is optional when an application imports only `genai-electron/llama-server-launch` or
`genai-electron/llm-calibration-policy`. The package root and manager APIs require an Electron host;
they depend on `app.getPath('userData')` and must be used after Electron's ready event. This
repository installs exact Electron 43.2.0 as a development dependency so builds and packed root
declaration tests remain reproducible; that development pin does not change the consumer peer range.
See [Integration Guide](integration-guide.md) for initialization and module-loader patterns.

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

**Technology Stack**: Node.js >=22.0.0, TypeScript ^5.7.2, and two external runtime
dependencies (`@huggingface/gguf`, `tar`). The exact-pinned adm-zip implementation is embedded in
the generated ZIP worker; it is a development/update input rather than a runtime dependency.

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

1. **Downloads the appropriate binary** for your platform (GPU archives and
   their runtime dependencies can total hundreds of megabytes)
2. **Tests GPU variants** in platform-specific priority order (e.g., CUDA → Vulkan → CPU on Linux/Windows)
3. **Runs real functionality tests**:
   - LLM: Generates 1 token with GPU layers enabled (`-ngl 1`)
   - Diffusion: Generates 64x64 image with 1 diffusion step
   - Diffusion validation uses the same resolved CPU-offload and diffusion
     flash-attention flags as production generation
   - Verifies GPU actually works (not just that binary loads)
4. **Falls back automatically** if test fails (e.g., broken CUDA → Vulkan → CPU)
5. **Caches working variant** for fast subsequent starts

On Windows, ZIP inflation runs in a self-contained worker thread so Electron's main event loop
remains responsive and packaged applications do not need a loose/resolvable `adm-zip`. The
`'binary-progress'` event reports throttled uncompressed bytes written plus the existing entry
counters during extraction. Its extraction percentage prefers bytes, falls back to entries, and is
omitted without a positive denominator. Because `adm-zip` inflates a complete member before
writing it, byte updates do not represent streaming decompression. Once all writes finish, a
phase-only `finalizing` event covers worker/isolate resource release; this can take tens of seconds
for very large Windows archives even though extraction is complete and the main event loop remains
responsive. After validation, a phase-only `installing` event covers candidate copying,
metadata/checksum work, and atomic publication.
Successfully installed dependency archives are recorded by checksum
in `userData/binaries/<type>/.deps.json`; byte-identical CUDA runtimes are reused
across upstream release-URL changes. If provisioning is interrupted, the next
run clears stale extraction staging and reuses any complete archive whose
checksum still matches. If installation completed before the interruption,
the validated-binary fast path removes leftover main archives and extraction
directories. An unmanifested dependency archive is retained as a recovery copy
until a later provisioning run can verify, extract, and record it. Partial
downloads are not range-resumed.

**Timing**:
- First start: 2-10 seconds for variant testing, plus download, extraction, and installation time;
  large Windows CUDA trees can take minutes on slow or heavily scanned storage
- Subsequent starts: ~0.5 seconds (checksum verification only)

**Server-start (health-check) timeout**: After the binary is ready, `start()` waits for the server to become healthy before resolving. The default timeout is **120 seconds** (`DEFAULT_TIMEOUTS.serverStart`), raised to accommodate cold loads of large GGUFs on slow disks. Override it per start with the `startupTimeout` option (milliseconds):

```typescript
await llamaServer.start({
  modelId: 'huge-70b',
  startupTimeout: 300000, // 5 minutes for a very large cold load
});
```

**Validation Caching**:
After first successful validation, subsequent starts skip expensive tests and only verify binary integrity via checksum. Use `forceValidation: true` to re-run full tests after driver updates.

Provisioning messages are also written to `llama-server.log` or
`diffusion-server.log` from the beginning of `start()`, including failed
downloads and variant validation. Hosts may still subscribe to `'binary-log'`
for live UI output.

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

### Debugging

```bash
# Enable verbose internal debug logging (auto-configuration and
# ResourceOrchestrator traces). Silent by default.
export GENAI_ELECTRON_DEBUG=1
```

Set `GENAI_ELECTRON_DEBUG` to any truthy value to surface the library's internal diagnostics (server auto-config decisions, resource orchestration steps) on the console. Leave it unset for normal operation.

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
