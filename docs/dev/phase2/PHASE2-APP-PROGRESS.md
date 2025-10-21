# Phase 2 App Development - Detailed Progress

> **Status**: Complete (2025-10-21)
> **Scope**: electron-control-panel example app + resource orchestration + GGUF integration

This document contains detailed historical information about Phase 2 app development, including all issues resolved, implementation decisions, and debugging processes.

---

## Overview

Phase 2 app development focused on:
- Implementing diffusion server UI in electron-control-panel
- Building resource monitoring and orchestration features
- Integrating GGUF metadata extraction and viewer
- Resolving critical resource management issues that caused system crashes

**Key Achievement**: From "system crashes during image generation" to "transparent automatic resource orchestration"

---

## Phase 2 Example App: electron-control-panel

### Implementation Summary

Fully implemented Phase 2 features in the electron-control-panel example app, adding diffusion server management, resource monitoring, and unified model management.

### Features Implemented

**1. Diffusion Server Tab**
- Start/stop diffusion server with model selection
- Full image generation form (prompt, dimensions, steps, CFG scale, 8 samplers, seed)
- Generated image display with metadata
- Real-time multi-stage progress indicator (loading → diffusion → decoding)
- Busy state indicator preventing server stop during generation
- Health check monitoring

**2. Resource Monitor Tab**
- System memory usage with real-time polling (2-second intervals)
- GPU/VRAM usage display (conditional on GPU availability)
- Server status grid (LLM + Diffusion side-by-side)
- Resource orchestration status with warnings
- Event log (last 20 events, color-coded, scrollable)

**3. Unified Model Management**
- Model type selector in download form (LLM / Diffusion)
- Unified model list with type badges (blue "LLM", purple "DIFFUSION")
- Combined disk usage statistics
- Proper model filtering in server-specific tabs

**4. GGUF Info Modal**
- 📊 button next to each model
- Auto-fetches metadata for old models
- Essential + Advanced collapsible sections
- Raw JSON viewer with smart truncation (handles 50k+ item arrays)
- Refresh and Copy to Clipboard buttons

### Technical Implementation

**New Files Created:** 8 components + 2 hooks
**Modified Files:** 13 (main process, preload, renderer components, types)
**Lines Added:** ~1,900 net

---

## Issues Resolved During Phase 2 App Development

### Issue 1: Model Type Filtering ✅
- **Problem:** `useModels` hook hardcoded to fetch only 'llm' models
- **Impact:** Diffusion Server tab showed LLM models in dropdown
- **Fix:** Added type parameter to hook with default value 'llm'
- **Result:** Each tab correctly filters models by type

### Issue 2: Unified Model Display ✅
- **Problem:** Models tab only showed LLM models
- **Impact:** Users couldn't see or manage diffusion models
- **Fix:** Fetch both types, merge arrays, add type badges
- **Result:** All models visible with clear type identification

### Issue 3: Diffusion Binary Extraction Failure ✅
- **Problem:** `extractLlamaServerBinary()` hardcoded to search only for llama-server binary names
- **Impact:** Diffusion binary downloads succeeded but extraction failed
- **Root Cause:** Function searched for `llama-server.exe` instead of `sd.exe`
- **Fix:** Renamed to `extractBinary()`, added `binaryNames` parameter
- **Result:** Diffusion binaries extract successfully on all platforms

### Issue 4: Diffusion Binary Test Flag Incompatibility ✅
- **Problem:** `testBinary()` used `--version` flag for all binaries, but `sd.exe` doesn't support it
- **Impact:** ALL variants failed binary test phase
- **Root Cause:** `sd.exe --version` returns error, only supports `--help`
- **Fix:** Modified `testBinary()` to use type-specific flags
- **Result:** Diffusion binaries pass variant testing

### Issue 5: Missing CUDA Runtime Dependencies ✅
- **Problem:** Binary downloads only fetched main executables, missing required CUDA runtime DLLs
- **Impact:** CUDA variants hung indefinitely during execution
- **Root Cause:** Both binary types required CUDA runtime DLLs:
  - llama.cpp CUDA: Needs `cudart-llama-bin-win-cuda-12.4-x64.zip`
  - stable-diffusion.cpp CUDA: Needs `cudart-sd-bin-win-cu12-x64.zip`
- **Solution Implemented:**
  - Extended `BinaryVariantConfig` with optional `dependencies` array
  - Automatic dependency download BEFORE binary testing
  - Added CUDA GPU detection filter to skip CUDA variants on non-NVIDIA systems
  - Dependencies extracted to same directory as main binary
  - Automatic cleanup of dependencies if variant test fails
- **Architecture Benefits:**
  - Prevents ~100-200MB of unnecessary CUDA downloads on AMD/Intel/CPU-only systems
  - Dependencies verified with SHA256 checksums
  - Clean fallback chain: CUDA (with deps) → Vulkan → CPU

### Issue 6: Binary Variant Testing Visibility ✅
- **Problem:** Binary variant testing happened silently with no UI feedback
- **Solution:**
  - Added `'binary-log'` event to ServerManager
  - Binary Setup Status card in LLM and Diffusion Server tabs
  - Color-coded log display with auto-hide when server starts
- **Result:** Real-time visibility into variant selection process

### Issue 7: Phase 2 Testing Timeout with execFile ✅
- **Problem:** BinaryManager Phase 2 (real functionality testing) timed out on Windows
- **Root Cause:** Promisified execFile doesn't support stdio option, stdin remained open
- **Solution:**
  - Replaced with custom `spawnWithTimeout` helper using `spawn` directly
  - Proper stdio configuration: `['ignore', 'pipe', 'pipe']`
  - Updated both validation test methods
- **Result:** Binary variant testing works correctly, stdin properly closed

---

## Critical Resource Management Issues (Issues 8-11)

### Issue 8: Memory Cache Staleness Bug ✅

**Problem Identified:**
User report: "I loaded a 6GB LLM in memory and neither the 'System Info' nor the 'Resource monitor' are updated... I get 'Error: Insufficient RAM: model requires 3.1GB, but only 2.4GB available'."

**Root Cause:**
1. `SystemInfo.canRunModel()` used cached `detect()` results (60-second cache)
2. After loading 6GB LLM, memory consumed but cache showed old (higher) available memory
3. When loading diffusion model, used stale data and falsely reported insufficient RAM

**Solution Implemented:**
1. **Fixed `canRunModel()`**: Uses real-time `getMemoryInfo().available` instead of cached memory
2. **Fixed `getOptimalConfig()`**: Uses fresh `getMemoryInfo()` for context size calculations
3. **Strategic cache invalidation**: Clear cache after server start/stop in both managers
4. **UI enhancements**: Auto-polling (5s) + event listeners for automatic updates

**Impact:**
- ✅ Models can be loaded sequentially without false RAM errors
- ✅ System Info auto-updates every 5s + on server events
- ✅ Resource Monitor shows real-time memory and event-driven GPU updates
- ✅ ResourceOrchestrator makes accurate offload decisions

### Issue 9: Resource Orchestration Architecture ✅

**Problem Identified:**
User report: "I started the llama server with a large LLM, then started the diffusion server and generated an image. The computer struggled and crashed (switched off)."

**Root Cause:**
The UI component called `window.api.diffusion.generateImage()` directly, bypassing ResourceOrchestrator entirely. Both models loaded in memory simultaneously → RAM/VRAM exhaustion → system crash.

**Architecture Issue:**
- ResourceOrchestrator existed but users had to choose between two APIs
- Direct `generateImage()` caused crashes (unsafe default)
- For genai-lite integration, requiring orchestration knowledge would break abstraction

**Solution - Wrapper Pattern:**
Keep ResourceOrchestrator as clean, separate class, but make `DiffusionServerManager.generateImage()` use it internally as automatic behavior.

**Implementation:**
1. Added optional `llamaServer` parameter to DiffusionServerManager constructor
2. Creates internal ResourceOrchestrator if llamaServer provided
3. `generateImage()` delegates to orchestrator if it exists
4. Made `executeImageGeneration()` public for orchestrator to call
5. Singleton instantiation passes `llamaServer` to enable automatic orchestration

**Architecture Benefits:**
- ✅ Clean API: Just call `generateImage()`
- ✅ No orchestration knowledge needed: Happens automatically
- ✅ Safe by default: Won't crash from OOM
- ✅ Backward compatible: Custom instances work without orchestrator

### Issue 10: IPC Handler Bypassing Orchestration ✅

**Problem:**
Even after Issue 9 fix, system still hung during image generation.

**Root Cause:**
The example app's IPC handler made direct HTTP fetch to diffusion server, completely bypassing the library code:
```typescript
// OLD CODE - Direct HTTP bypass
const response = await fetch(`http://localhost:${port}/v1/images/generations`, {...});
```

**Solution:**
Changed IPC handler to call `diffusionServer.generateImage()` which triggers automatic orchestration:
```typescript
// NEW CODE - Uses library with orchestration
const result = await diffusionServer.generateImage({
  prompt: config.prompt,
  onProgress: (currentStep, totalSteps) => sendImageProgress(currentStep, totalSteps),
});
```

**Result:**
- ✅ No more system hangs or crashes
- ✅ Orchestration works automatically in example app
- ✅ LLM temporarily stopped and restored during image generation
- ✅ Production-ready behavior out of the box

### Issue 11: Auto-Config Not Saving to this._config ✅

**Problem:**
After fixing Issues 9 and 10, orchestration code path was correct but resource estimation was still wrong. Debug logging showed LLM VRAM usage calculated as 0 GB.

**Root Cause:**
In `LlamaServerManager.start()`:
```typescript
this._config = config;  // ❌ Saved ORIGINAL config (gpuLayers: undefined)
// ... later ...
const finalConfig = await this.autoConfigureIfNeeded(config, modelInfo); // gpuLayers: 41
// Server runs with finalConfig ✓ but this._config still has old values! ✗
```

Flow:
1. Auto-configure correctly calculated `gpuLayers: 41` ✓
2. Server spawned with correct args (`-ngl 41`) ✓
3. **BUT** `this._config` stored original config before auto-configuration ✗
4. `getConfig()` returned `gpuLayers: undefined` (becomes 0) ✗
5. Orchestrator calculated VRAM = 0 GB ✗
6. **LLM never offloaded** ✗

**The Fix:**
```typescript
// BEFORE:
this._config = config;  // ❌ Too early!
const finalConfig = await this.autoConfigureIfNeeded(config, modelInfo);

// AFTER:
const finalConfig = await this.autoConfigureIfNeeded(config, modelInfo);
this._config = finalConfig;  // ✓ Save AFTER auto-configuration
```

**Verification:**
- ✅ `getConfig()` returns actual running configuration
- ✅ Orchestrator sees correct VRAM usage (7.7 GB)
- ✅ **ORCHESTRATION WORKS!**

**User Experience:**
1. Start LLM server with auto-configure → uses 41 GPU layers (7.7 GB VRAM)
2. Click "Generate Image" → Orchestrator detects constraint
3. LLM server stopped → Image generated → LLM server restarted
4. **No crash, no hang** ✓

---

## GGUF Metadata Integration

### Overview
Integrated `@huggingface/gguf` library to extract accurate model metadata from GGUF files before downloading. Eliminates guesswork and enables pre-download validation.

### Core Features Implemented

1. **GGUF Parser Utility** (`src/utils/gguf-parser.ts`)
   - `fetchGGUFMetadata(url)` - Remote extraction (pre-download)
   - `fetchLocalGGUFMetadata(path)` - Local file extraction
   - Generic `getArchField()` helper for ANY architecture

2. **Enhanced Type System**
   - `GGUFMetadata` interface with 15+ typed fields
   - Added `ggufMetadata?` to `ModelInfo` (backward compatible)

3. **ModelManager Enhancements**
   - Pre-download metadata fetch with fast-fail validation
   - New methods: `updateModelMetadata()`, `getModelLayerCount()`, `getModelContextLength()`, `getModelArchitecture()`
   - Converts BigInt to JSON-serializable format

4. **Configurable Metadata Fetch Strategies**
   - `'local-remote'` (default) - Fast + resilient with auto-fallback
   - `'local-only'` - Fastest, offline-capable
   - `'remote-only'` - Force fetch from source
   - `'remote-local'` - Authoritative with offline fallback

**Default Changed to 'local-remote'**: Some GGUF files trigger "ArrayBuffer.prototype.resize: Invalid length" errors when read locally. The `local-remote` strategy provides the same speed when local file works, but automatically recovers by fetching from remote URL when local parsing fails.

5. **Generic Architecture Support**
   - `getArchField()` replaces 4 hardcoded extraction functions
   - Works with llama, gemma3, qwen3, mistral, phi, mamba, gpt2, falcon, and ANY future architectures
   - Dynamically constructs field paths: `${architecture}.${fieldPath}`

6. **UI Implementation**
   - GGUF Info modal with Essential + Advanced sections
   - Raw JSON viewer with smart truncation (handles 50k+ arrays)
   - Auto-fetch for models downloaded before GGUF integration
   - Refresh and Copy to Clipboard buttons

### Benefits
- 🎯 **No More Guessing**: Actual layer counts from model files
- ✅ **Pre-Download Validation**: Know model specs before downloading GBs
- 🚀 **Better Auto-Configuration**: Use model's actual context length
- 💾 **Accurate Resource Planning**: Real VRAM/RAM calculations
- 🔄 **Future-Proof**: Complete metadata stored, works with any architecture

### Impact Example
- Llama-2-7B: 32 layers (was: estimated 32) ✅
- Llama-2-13B: 40 layers (was: estimated 32) ❌ 25% error
- Llama-2-70B: 80 layers (was: estimated 32) ❌ 150% error

---

## Performance Optimizations

### Binary Validation Caching

**Problem:** Binary validation (Phase 1 & 2 tests) ran on EVERY server start, causing 2-10 second delay even for already-validated binaries.

**Solution:**
- Smart validation result caching with SHA256 checksum verification
- First start: Download + validate + cache results (~2-10s)
- Subsequent starts: Checksum verification only (~0.5s)
- Automatic re-validation if binary modified
- Manual `forceValidation` flag for driver updates

**Performance Impact:**
- **4-20x faster startup** after first run (0.5s vs 2-10s)
- Checksum calculation: ~0.5s for 50-100MB binaries

---

## Debug Tools

### Debug Panel Features (Resource Monitor Tab)

Added diagnostic panel with 4 buttons:
- **Print LLM Config** - Shows current server config (gpuLayers, threads, etc.)
- **Print System Capabilities** - Shows detected hardware (GPU, VRAM, RAM)
- **Print Optimal Config** - Calculates recommended settings for current model
- **Print Resource Estimates** - Shows orchestrator calculations and offload decision

**Use Case:** Essential for diagnosing issues like incorrect GPU layer configuration or resource estimation problems. Helped identify and fix Issue 11 (auto-config not saving).

---

## Lessons Learned

### Critical Architectural Insights

1. **Cache Invalidation is Critical**: Memory state changes frequently when loading/unloading models. Real-time checks for dynamic data (memory), cached values for static data (GPU specs).

2. **Transparent Orchestration**: Resource management should be automatic and invisible. Users shouldn't have to choose between "safe" and "unsafe" APIs.

3. **Configuration State Consistency**: When auto-configuring, save the FINAL values, not the INPUT values. Otherwise orchestrator sees wrong configuration.

4. **Metadata Fetch Strategies**: Local-first with remote fallback handles file corruption gracefully while maintaining speed.

5. **Generic Architecture Support**: Hardcoded extraction functions don't scale. Dynamic field path construction (`getArchField()`) makes the system future-proof for any GGUF architecture.

### Testing & Debugging

- Comprehensive logging with prefixes (`[Orchestrator]`, `[LlamaServer]`) essential for debugging
- Debug UI panels accelerate issue diagnosis dramatically
- Real-time visibility into binary variant testing prevents silent failures

---

## Summary

Phase 2 app development delivered:
- ✅ Full-featured control panel with 5 tabs
- ✅ Transparent automatic resource orchestration (prevents crashes)
- ✅ GGUF metadata integration with generic architecture support
- ✅ 246/246 tests passing (100% pass rate)
- ✅ Production-ready example app demonstrating all Phase 2 features

**Key Transformation:** From "system crashes during image generation" to "transparent automatic resource management with zero user intervention."
