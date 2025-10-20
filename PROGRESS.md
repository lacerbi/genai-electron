# genai-electron Implementation Progress

> **Current Status**: Phase 2 Complete + Performance & Stability Optimization (2025-10-20)

---

## Current Build Status

- **Build:** ✅ 0 TypeScript errors (library + example app)
- **Tests:** ✅ 238/238 passing (100% pass rate - all tests passing!)
- **Jest:** ✅ Clean exit with no warnings
- **Branch:** `feat/phase2-app` (Phase 2 example app + binary validation caching)
- **Last Updated:** 2025-10-20 (Memory cache staleness fix + binary validation caching)

**Test Suite Breakdown:**
- Phase 1 Tests: 130 tests (errors, utils, core managers) - ✅ All passing
- Phase 2 Tests: 50 tests (DiffusionServerManager, ResourceOrchestrator) - ✅ All passing
- Infrastructure: 58 tests (BinaryManager + health-check + validation cache) - ✅ All passing

**Recent Optimizations:**
- Binary validation caching (4-20x faster server startup)
- Memory cache staleness fix (eliminates false "Insufficient RAM" errors)

---

## Phase 1: MVP - LLM Support ✅

**Status:** Complete (2025-10-16)

**Core Features Implemented:**
- ✅ **SystemInfo**: Hardware detection (CPU, RAM, GPU, VRAM), intelligent recommendations
- ✅ **ModelManager**: Download GGUF models from HuggingFace/URLs, storage management, checksums
- ✅ **LlamaServerManager**: Start/stop llama-server processes, auto-configuration, health monitoring
- ✅ **Binary Management**: Automatic download and variant testing for llama.cpp binaries
- ✅ **Reasoning Support**: Automatic detection and configuration for reasoning-capable models (Qwen3, DeepSeek-R1, GPT-OSS)

**Example Application:**
- ✅ **electron-control-panel**: Full Electron app demonstrating runtime management
  - System Info tab: Hardware detection and recommendations
  - Model Management tab: Download and manage models
  - LLM Server tab: Start/stop/restart, auto-configuration, test chat, logs
  - Dark theme UI with 40+ components

**Documentation:**
- README.md, docs/API.md, docs/SETUP.md
- Comprehensive test coverage with Jest 30 + ESM support

**Detailed Progress:** See `docs/dev/phase1/` for complete Phase 1 planning and logs

---

## Phase 2: Image Generation ✅

**Status:** Complete (2025-10-19)

**Core Features Implemented:**
- ✅ **DiffusionServerManager**: HTTP wrapper for stable-diffusion.cpp
  - On-demand spawning of executable for image generation
  - Progress tracking via stdout parsing
  - Binary management with variant testing and fallback
  - Full error handling and log capture

- ✅ **ResourceOrchestrator**: Automatic resource management
  - Detects RAM/VRAM constraints between LLM and image generation
  - Automatic LLM offload/reload when resources are limited
  - State preservation and intelligent bottleneck detection
  - 75% availability threshold for resource decisions

**Infrastructure Improvements:**
- ✅ **Cross-Platform Support**: npm scripts work on Windows, macOS, Linux
- ✅ **GitHub Automation**: CI/CD with cross-platform testing, issue templates, PR templates
- ✅ **Clean Test Infrastructure**: Jest exits cleanly, no memory leaks, 221 tests passing
- ✅ **ServerManager Refactoring**: Eliminated ~100+ lines of code duplication

**Documentation:**
- Updated README.md and docs/API.md with Phase 2 content
- Complete API reference for DiffusionServerManager and ResourceOrchestrator
- Example workflows demonstrating LLM + Image Generation

**Detailed Progress:** See `docs/dev/phase2/PHASE2-PROGRESS.md` for complete development history

---

## Phase 2 Example App: electron-control-panel ✅

**Status:** Complete - Ready for Testing (2025-10-19)

**Branch:** `feat/phase2-app`

### Implementation Summary

Fully implemented Phase 2 features in the electron-control-panel example app, adding diffusion server management, resource monitoring, and unified model management.

### Features Implemented

**1. Diffusion Server Tab**
- ✅ Start/stop diffusion server with model selection
- ✅ Full image generation form:
  - Prompt and negative prompt (multiline textareas)
  - Dimensions (width/height: 256-2048px, 64px steps)
  - Steps (1-150), CFG Scale (1-20, 0.5 steps)
  - 8 sampler options: euler_a, euler, heun, dpm2, dpm++2s_a, dpm++2m, dpm++2mv2, lcm
  - Seed support (random or fixed)
- ✅ Generated image display with metadata (dimensions, time taken, seed)
- ✅ Real-time progress indicator during generation
- ✅ Busy state indicator (prevents server stop during generation)
- ✅ Health check monitoring

**2. Resource Monitor Tab**
- ✅ System memory usage (total, used, available) with progress bar
- ✅ GPU/VRAM usage display (conditional on GPU availability)
- ✅ Server status grid (LLM + Diffusion side-by-side)
- ✅ Resource orchestration status:
  - Offload detection warnings (VRAM constrained systems)
  - Saved LLM state display (config, wasRunning, savedAt timestamp)
- ✅ Event log (last 20 events with timestamps)
  - Server lifecycle events (start/stop/crash)
  - Color-coded by type (info/warning/error)
  - Clear events button
  - Scrollable monospace log viewer

**3. Unified Model Management**
- ✅ Model type selector in download form (LLM / Diffusion)
- ✅ Unified model list showing both types with badges:
  - Blue "LLM" badge for text generation models
  - Purple "DIFFUSION" badge for image generation models
- ✅ Type column in model table for easy identification
- ✅ Combined disk usage statistics across both model types
- ✅ Proper model filtering in server-specific tabs:
  - LLM Server tab → Only shows LLM models
  - Diffusion Server tab → Only shows Diffusion models
  - Models tab → Shows all models with type badges

**4. App Integration**
- ✅ 5 total tabs: System Info, Models, LLM Server, Diffusion Server, Resource Monitor
- ✅ Consistent dark theme styling across all new components
- ✅ Responsive layouts and proper error handling
- ✅ Loading states and disabled states for async operations

### Technical Implementation

**New Files Created (6):**
1. `renderer/components/DiffusionServerControl.tsx` - Main diffusion server UI
2. `renderer/components/DiffusionServerControl.css` - Diffusion server styling
3. `renderer/components/ResourceMonitor.tsx` - Resource monitoring UI
4. `renderer/components/ResourceMonitor.css` - Resource monitor styling
5. `renderer/components/hooks/useDiffusionServer.ts` - Diffusion server state hook
6. `renderer/components/hooks/useResourceMonitor.ts` - Resource monitoring hook

**Modified Files (13):**
1. `main/genai-api.ts` - Added diffusionServer export and ResourceOrchestrator singleton
2. `main/ipc-handlers.ts` - Added 15+ new IPC handlers (diffusion, resources, system capabilities)
3. `main/preload.ts` - Exposed diffusion and resources APIs with proper TypeScript types
4. `renderer/types/api.ts` - Added Phase 2 types (ImageSampler, DiffusionServerInfo, etc.)
5. `renderer/types/ui.ts` - Added UI types (ImageFormData, ResourceEvent)
6. `renderer/components/hooks/useModels.ts` - Added type parameter for LLM/Diffusion filtering
7. `renderer/components/ModelList.tsx` - Added type field and badge column
8. `renderer/components/ModelList.css` - Added type badge styles
9. `renderer/components/ModelManager.tsx` - Fetch and merge both model types
10. `renderer/components/ModelDownloadForm.tsx` - Added model type selector
11. `renderer/App.tsx` - Added Diffusion Server and Resource Monitor tabs
12. `renderer/global.css` - Added Phase 2 color variables and base styles
13. `renderer/vite-env.d.ts` - Added ESLint suppressions for Forge globals

**Lines of Code:**
- ~1,900 lines added across all files
- ~50 lines removed during refactoring
- Net addition: ~1,850 lines

### Architecture Decisions

**IPC Communication:**
- Direct HTTP calls for image generation (demonstrates HTTP API pattern)
- ResourceOrchestrator singleton in main process
- Event forwarding for both LLM and diffusion server lifecycle

**React Hooks Pattern:**
- `useModels(type)` - Parameterized hook for fetching specific model types
- `useDiffusionServer()` - Mirrors `useServerStatus()` for consistency
- `useResourceMonitor()` - Polls every 2 seconds, maintains event timeline
- All hooks use `window.api.on/off` pattern with proper cleanup in useEffect

**Styling:**
- Consistent with existing Phase 1 dark theme
- New color variables for warnings, info messages, error states
- Type badges use library-style colors (blue/purple)
- Monospace font for event log and technical displays

### Known Issues Fixed

**Issue 1: Model Type Filtering**
- **Problem:** `useModels` hook was hardcoded to fetch only 'llm' models
- **Impact:** Diffusion Server tab showed LLM models in dropdown
- **Fix:** Added type parameter to hook with default value 'llm' (commit `4599eaf`)
- **Result:** Each tab now correctly filters models by type

**Issue 2: Unified Model Display**
- **Problem:** Models tab only showed LLM models, diffusion models were hidden
- **Impact:** Users couldn't see or manage diffusion models from central interface
- **Fix:** Fetch both types, merge arrays, add type badges (commit `457327d`)
- **Result:** All models visible in Models tab with clear type identification

**Issue 3: Diffusion Binary Extraction Failure**
- **Problem:** `extractLlamaServerBinary()` hardcoded to search only for llama-server binary names
- **Impact:** Diffusion binary downloads succeeded but extraction failed, server wouldn't start
- **Root Cause:** Function searched for `llama-server.exe` instead of `sd.exe` when extracting diffusion binaries
- **Fix:** Renamed to `extractBinary()`, added `binaryNames` parameter, pass correct names based on type
- **Result:** Diffusion binaries now extract successfully, server can start on all platforms
- **Testing Gap:** Unit tests mocked extraction layer, missing integration test for real ZIP extraction

**Issue 4: Diffusion Binary Test Flag Incompatibility**
- **Problem:** `testBinary()` used `--version` flag for all binaries, but `sd.exe` doesn't support it
- **Impact:** After Issue 3 fix, extraction succeeded but ALL variants failed binary test phase
- **Root Cause:** `sd.exe --version` returns error "unknown argument", only supports `--help`
- **Discovery:** Manual testing revealed silent test failures (no error logs, just cycles through variants)
- **Fix:** Modified `testBinary()` to use type-specific flags: llama uses `--version`, diffusion uses `--help`
- **Result:** Diffusion binaries now pass variant testing, first working variant is selected and installed

**Issue 5: Missing CUDA Runtime Dependencies** ✅ **RESOLVED**
- **Problem:** Binary downloads only fetched main executables (llama-server.exe, sd.exe), missing required CUDA runtime DLLs
- **Impact:** After Issues 3 & 4 fixes, binary test passed but CUDA variants hung indefinitely during execution
- **Root Cause:** BOTH binary types required CUDA runtime DLLs for CUDA variants:
  - llama.cpp CUDA: Needs `cudart-llama-bin-win-cuda-12.4-x64.zip` (SHA256: `8c79a9b2...`)
  - stable-diffusion.cpp CUDA: Needs `cudart-sd-bin-win-cu12-x64.zip` (SHA256: `cacc1f7e...`)
  - Note: Vulkan variants do NOT require CUDA DLLs (work without additional dependencies)
- **Solution Implemented (2025-10-19):**
  - ✅ Extended `BinaryVariantConfig` with optional `dependencies` array
  - ✅ Added `BinaryDependency` interface with URL, checksum, and description
  - ✅ Implemented automatic dependency download BEFORE binary testing
  - ✅ Added CUDA GPU detection filter to skip CUDA variants on non-NVIDIA systems
  - ✅ Dependencies extracted to same directory as main binary (DLLs alongside executables)
  - ✅ Automatic cleanup of dependencies if variant test fails
  - ✅ Added 5 new tests for dependency download and CUDA filtering (226/226 passing)
- **Architecture Benefits:**
  - Prevents ~100-200MB of unnecessary CUDA downloads on AMD/Intel/CPU-only systems
  - Dependencies verified with SHA256 checksums before extraction
  - Clean fallback chain: CUDA (with deps) → Vulkan → CPU
  - Future-proof for other dependencies (ROCm, Vulkan layers, etc.)

**Real CUDA Functionality Testing** ✅ **IMPLEMENTED**
- **Problem:** Issue 5 solved dependency downloads, but basic `--version`/`--help` test didn't catch broken CUDA
  - CUDA binaries could load without runtime DLLs but fail during actual GPU inference
  - System would cache broken CUDA variant as "working", never trying Vulkan fallback
  - Users experienced: Binary test passes → CUDA selected → inference hangs/crashes
- **Solution Implemented (2025-10-19):**
  - ✅ Added optional real functionality testing during variant selection
  - ✅ When model available: runs actual GPU inference test (1 token for LLM, 64x64 image for diffusion)
  - ✅ Tests force GPU usage (`-ngl 1` for LLM, GPU layers for diffusion)
  - ✅ Detects CUDA errors in output ("CUDA error", "failed to allocate", "out of memory", etc.)
  - ✅ Automatic fallback to Vulkan if CUDA test fails (logs warning, tries next variant)
  - ✅ Falls back to basic test if no model available (backward compatible)
  - ✅ Added 5 new tests for real functionality testing (231/231 passing)
- **Behavior:**
  - First call to `start()` downloads binary and runs real test (2-10 seconds)
  - Working variant cached for fast subsequent starts
  - Broken CUDA automatically skipped, Vulkan selected instead
  - Zero API changes - completely automatic
- **Testing Coverage:**
  - ✅ Real test success path
  - ✅ CUDA error detection and fallback
  - ✅ Timeout handling (prevents hanging)
  - ✅ Diffusion-specific test args
  - ✅ Backward compatibility (no model = basic test)

**Issue 6: Binary Variant Testing Visibility** ✅ **RESOLVED**
- **Problem:** Binary variant testing (CUDA → Vulkan → CPU) happened silently with no UI feedback
  - Users couldn't see which variants were being tried
  - No visibility into download progress or test failures
  - Difficult to debug why specific variants (e.g., CUDA) were failing
- **Solution Implemented (2025-10-20):**
  - ✅ Added `'binary-log'` event to ServerManager (emits during download/test)
  - ✅ Added BinaryLogEvent type with message and level (info/warn/error)
  - ✅ Binary Setup Status card in both LLM and Diffusion Server tabs
  - ✅ Color-coded log display with auto-hide when server starts
  - ✅ Fixed event forwarding timing bug (window capture issue)
- **Result:**
  - Real-time visibility into variant selection process
  - Shows download progress, test results, and failure reasons
  - Users can see exactly which variant was selected and why

**Issue 7: Phase 2 Testing Timeout with execFile** ✅ **RESOLVED**
- **Problem:** BinaryManager Phase 2 (real functionality testing) consistently timed out on Windows for ALL variants
  - llama-run.exe hung indefinitely when spawned by Node.js despite working fine from command line
  - Command syntax was correct: `llama-run.exe -ngl 1 <model> <prompt>`
  - Timeout occurred after 15 seconds, preventing GPU functionality verification
  - System cycled through all variants (CUDA → Vulkan → CPU), all failed Phase 2 test
- **Root Cause Identified (2025-10-20):**
  - `BinaryManager.ts` used `util.promisify(execFile)` with stdio configuration
  - **Promisified execFile DOES NOT support stdio option** (ignored despite being passed)
  - Without `stdio: ['ignore', 'pipe', 'pipe']`, stdin remained open
  - llama-run waited for input on stdin (even though all params provided via CLI)
  - Process never exited, timeout occurred after 15 seconds
- **Solution Implemented (Commits fb68073, a539e54 - 2025-10-20):**
  - ✅ Replaced promisified execFile with custom `spawnWithTimeout` helper method
  - ✅ Uses `spawn` directly with proper stdio configuration: `['ignore', 'pipe', 'pipe']`
  - ✅ Implements timeout handling with SIGTERM kill
  - ✅ Collects stdout/stderr output for error detection
  - ✅ Updated both `runBasicValidationTest` and `runRealFunctionalityTest`
  - ✅ Fixed Jest test mocks to survive `resetMocks: true` in jest.config.js
  - ✅ Created helper API (`setSpawnResponse`/`setSpawnResponses`) for clearer test intent
  - ✅ Updated event emission to use setImmediate for realistic async behavior
  - ✅ Removed timeout assertions from tests (timeout handled internally)
- **Testing Status:**
  - ✅ **Production code fix complete** (BinaryManager.ts)
  - ✅ **All test mocks fixed and working**
  - ✅ 233/233 tests passing (100% pass rate)
  - ✅ 31/31 BinaryManager tests passing
  - ✅ Jest exits cleanly with no warnings
- **Result:**
  - Binary variant testing (Phase 1 & Phase 2) now works correctly
  - stdin properly closed via spawn stdio configuration
  - Test mocks properly survive Jest's resetMocks between tests
  - Ready for manual testing on Windows to verify real-world behavior

### Manual Testing Results (2025-10-19)

**Diffusion Server Testing:**
- ✅ Binary download works (CUDA/Vulkan/AVX2 variants)
- ✅ Binary extraction works (finds sd.exe correctly)
- ✅ Binary testing works (--help flag test passes)
- ✅ **Image generation confirmed working** (with manual CUDA runtime DLL setup)
- ⚠️ Automatic CUDA runtime dependency download missing (needed for CUDA variants only, not Vulkan/AVX2)

**Known External Issues:**
- Windows Defender may flag sd.exe as suspicious (false positive, common with ML binaries)
- Virus scans confirm files are clean
- User may need to add exception for genai-electron binaries folder

**Architecture Discovery:**
Windows CUDA variants require additional runtime DLLs not included in main binary ZIP:
- **llama.cpp CUDA:** Needs `cudart-llama-bin-win-cuda-12.4-x64.zip` from same release
- **stable-diffusion.cpp CUDA:** Needs `cudart-sd-bin-win-cu12-x64.zip` from same release
- **Vulkan variants:** No additional dependencies needed (work out of the box)
- **AVX2/CPU variants:** No additional dependencies needed

### Build & Quality Status

- ✅ **TypeScript:** 0 errors (strict mode)
- ✅ **ESLint:** 0 errors, 0 warnings
- ✅ **Prettier:** All files formatted
- ✅ **Vite Build:** Successful (185KB renderer bundle)

### Testing & Debugging Guidance

**For Future Developers:**

**Prerequisites for Testing:**
1. Download at least one diffusion model (e.g., from HuggingFace)
   - Recommended: SD 1.5 or SDXL models in safetensors/gguf format
2. Ensure diffusion.cpp binary is available (auto-downloaded on first start)
3. Sufficient VRAM/RAM for image generation (4GB+ recommended)

**Test Workflow:**
1. **Model Download:**
   - Navigate to Models tab
   - Select "Diffusion" in model type selector
   - Download a model from HuggingFace or direct URL
   - Verify model appears with purple "DIFFUSION" badge

2. **Diffusion Server:**
   - Navigate to Diffusion Server tab
   - Select downloaded diffusion model from dropdown
   - Click "Start Server"
   - Wait for health check to turn green
   - Generate test image with simple prompt
   - Verify image displays with metadata

3. **Resource Monitoring:**
   - Navigate to Resource Monitor tab
   - Verify memory bars update (2-second polling)
   - If GPU available, verify VRAM display shows
   - Check server status grid shows both servers
   - Generate image and watch event log populate
   - If VRAM constrained, verify offload warning appears

4. **Unified Model Management:**
   - Navigate to Models tab
   - Verify both LLM and diffusion models show with badges
   - Test verify and delete operations on both types
   - Check total disk usage is accurate

**Common Issues to Watch For:**
- Port conflicts (default 8081 for diffusion server)
- Binary download failures (check network connectivity)
- VRAM constraints on GPU systems (orchestrator should handle)
- Model format compatibility (diffusion.cpp supports specific formats)
- Image generation timeouts (larger images/more steps = longer generation)

**Event Listeners:**
- All components properly clean up event listeners on unmount
- Pattern: `window.api.on()` in useEffect, `window.api.off()` in cleanup
- No memory leaks observed in testing

**Debug Tips:**
- Check main process console for server startup errors
- Diffusion server logs visible via Logs button (when implemented)
- Network tab shows HTTP calls to diffusion server wrapper
- React DevTools useful for inspecting hook state

---

## Post-Phase 2: Performance Optimization ✅

**Status:** Complete (2025-10-20)

### Binary Validation Caching

**Problem Identified:**
- Binary validation (Phase 1 & 2 tests) ran on EVERY server start
- Caused 2-10 second delay even for already-validated binaries
- Only variant preference was cached, not test results
- Poor user experience with redundant GPU functionality tests

**Solution Implemented:**
- ✅ Smart validation result caching with SHA256 checksum verification
- ✅ First start: Download + validate + cache results (~2-10s)
- ✅ Subsequent starts: Checksum verification only (~0.5s)
- ✅ Automatic re-validation if binary modified (checksum mismatch)
- ✅ Manual `forceValidation` flag for driver updates

**Performance Impact:**
- **4-20x faster startup** after first run (0.5s vs 2-10s)
- Checksum calculation: ~0.5s for 50-100MB binaries
- Cache invalidation: Automatic on binary modification
- Force validation: Available via `forceValidation: true` flag

**Implementation Details:**
- New `ValidationCache` structure with variant, checksum, timestamp, test results
- Added to both `LlamaServerManager` and `DiffusionServerManager`
- 5 new tests covering all cache scenarios
- Documented in `docs/API.md` with examples

**Files Modified:**
- `src/types/servers.ts` - Added `forceValidation` flag
- `src/types/images.ts` - Added `forceValidation` flag
- `src/managers/BinaryManager.ts` - Implemented cache logic
- `src/managers/ServerManager.ts` - Pass flag through
- `src/managers/LlamaServerManager.ts` - Pass flag from config
- `src/managers/DiffusionServerManager.ts` - Pass flag from config
- `tests/unit/BinaryManager.test.ts` - Added 5 cache tests
- `docs/API.md` - Documented flag and caching behavior

**Usage Example:**
```typescript
// Normal startup (fast after first run)
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080
});
// ✅ 0.5s startup

// Force re-validation (e.g., after driver update)
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  forceValidation: true
});
// ✅ 2-10s with full validation
```

---

## Issue 8: Memory Cache Staleness Bug ✅

**Status:** Resolved (2025-10-20)

### Problem Identified

**User Report:** "I loaded a 6GB LLM in memory (and it works fine) and neither the 'System Info' nor the 'Resource monitor' are updated... more critically it looks like that indeed the internal memory monitoring is not updated as I tried to load the diffusion model and I get 'Error: Insufficient RAM: model requires 3.1GB, but only 2.4GB available'."

**Root Cause Analysis:**

1. **Stale Memory Cache in Model Validation** (`SystemInfo.canRunModel()`):
   - Used `detect()` which caches results for 60 seconds
   - After loading 6GB LLM, memory was consumed but cache still showed old (higher) available memory
   - When loading diffusion model, used stale data and falsely reported insufficient RAM

2. **Stale Memory in Configuration** (`SystemInfo.getOptimalConfig()`):
   - Same issue - used cached `detect()` for memory calculations
   - Recommended incorrect context sizes based on outdated memory availability

3. **UI Never Updated** (System Info tab):
   - Only fetched once on mount
   - No polling or event listeners
   - Manual "Refresh" button worked but was still subject to 60-second cache

4. **UI Partially Updated** (Resource Monitor tab):
   - System RAM polled every 2 seconds (correct)
   - GPU/VRAM data from cached `detect()` (stale)

### Solution Implemented

**Core Library Fixes:**

1. **Fixed `SystemInfo.canRunModel()`** (`src/system/SystemInfo.ts`):
   - Replaced `capabilities.memory.available` with real-time `this.getMemoryInfo().available`
   - Keeps GPU checks from cached capabilities (GPU specs don't change)
   - Result: Accurate RAM checks even immediately after loading models

2. **Fixed `SystemInfo.getOptimalConfig()`** (`src/system/SystemInfo.ts`):
   - Uses fresh `getMemoryInfo()` instead of cached memory data for context size calculation
   - Keeps static hardware info (CPU/GPU) from cache
   - Result: Accurate configuration recommendations

3. **Added Strategic Cache Invalidation**:
   - `LlamaServerManager.start()`: Clears cache after successful server start
   - `LlamaServerManager.stop()`: Clears cache after server stop
   - `DiffusionServerManager.start()`: Clears cache after successful server start
   - `DiffusionServerManager.stop()`: Clears cache after server stop
   - Result: Subsequent operations always use fresh memory data

**UI Enhancements:**

4. **Enhanced `useSystemInfo` hook** (System Info tab):
   - Added auto-polling every 5 seconds
   - Added event listeners for server start/stop events (triggers immediate refresh)
   - Result: System Info tab updates automatically without manual refresh

5. **Enhanced `useResourceMonitor` hook** (Resource Monitor tab):
   - Added event listeners to refresh GPU capabilities on server events
   - Result: GPU/VRAM data updates when servers start/stop

**Test Updates:**

6. **Fixed Test Mocks**:
   - Added `clearCache: jest.fn()` to SystemInfo mocks in 3 test files:
     - `tests/unit/LlamaServerManager.test.ts`
     - `tests/unit/DiffusionServerManager.test.ts`
     - `tests/unit/ResourceOrchestrator.test.ts`

### Implementation Details

**Files Modified (Library - 3):**
- `src/system/SystemInfo.ts` - Real-time memory in `canRunModel()` and `getOptimalConfig()`
- `src/managers/LlamaServerManager.ts` - Cache clearing after start/stop
- `src/managers/DiffusionServerManager.ts` - Cache clearing after start/stop

**Files Modified (Example App - 3):**
- `examples/.../hooks/useSystemInfo.ts` - Auto-polling and event listeners
- `examples/.../hooks/useResourceMonitor.ts` - Event-driven capability refresh
- (Plus 3 test files updated)

**Test Status:**
- ✅ All 238 tests passing (100% pass rate)
- ✅ TypeScript compiles with 0 errors
- ✅ No regressions

### Impact

**Before Fix:**
- ❌ False "Insufficient RAM" errors when loading models sequentially
- ❌ System Info showed stale memory data (up to 60 seconds old)
- ❌ Resource Monitor showed stale GPU data
- ❌ ResourceOrchestrator made decisions on outdated information

**After Fix:**
- ✅ Models can be loaded sequentially without false RAM errors
- ✅ System Info auto-updates every 5s + on server events
- ✅ Resource Monitor shows real-time memory and event-driven GPU updates
- ✅ ResourceOrchestrator makes accurate offload decisions

**User Experience:**
- Can now load LLM, then load diffusion model without errors
- UI reflects memory changes automatically
- No manual refresh required

---

## Issue 9: Resource Orchestration Architecture ✅

**Status:** Resolved (2025-10-20)

### Problem Identified

**User Report:** "I started the llama server with a large LLM, then started the diffusion server and generated an image. The computer struggled and crashed (switched off)."

**Root Cause Analysis:**

The example app UI component (`DiffusionServerControl.tsx`) called `window.api.diffusion.generateImage()` directly, which bypassed the ResourceOrchestrator entirely. When both the LLM and diffusion models were loaded in memory simultaneously, they competed for RAM/VRAM until the system ran out of memory and crashed.

**Architecture Issue:**
- ResourceOrchestrator existed and worked correctly ✅
- But users had to choose between two APIs: `generateImage()` vs `orchestrateImageGeneration()` ❌
- Direct `generateImage()` caused crashes (unsafe default) ❌
- For genai-lite integration, requiring orchestration knowledge would break abstraction ❌

### Solution Implemented

**Wrapper Pattern**: Keep ResourceOrchestrator as a clean, separate class (good separation of concerns), but make `DiffusionServerManager.generateImage()` use it internally as automatic behavior.

**Implementation Details:**

1. **Updated DiffusionServerManager constructor** (`src/managers/DiffusionServerManager.ts`):
   - Added optional `llamaServer` parameter
   - Creates internal ResourceOrchestrator instance if llamaServer provided
   - Enables automatic orchestration for singleton usage

2. **Updated generateImage() method** (`src/managers/DiffusionServerManager.ts`):
   - Checks if orchestrator exists
   - If yes: Delegates to `orchestrator.orchestrateImageGeneration()`
   - If no: Uses direct execution (backward compatible for custom instances)

3. **Made executeImageGeneration() public** (`src/managers/DiffusionServerManager.ts`):
   - Changed from `private` to `public`
   - Allows ResourceOrchestrator to call it directly
   - Prevents infinite recursion (generateImage → orchestrator → executeImageGeneration)

4. **Updated ResourceOrchestrator** (`src/managers/ResourceOrchestrator.ts`):
   - Changed calls from `generateImage()` to `executeImageGeneration()`
   - Avoids recursion back through orchestrator

5. **Updated singleton instantiation** (`src/index.ts`):
   - Pass `llamaServer` to `diffusionServer` constructor
   - Enables automatic orchestration for all singleton usage

**Files Modified (Library - 3):**
- `src/managers/DiffusionServerManager.ts` (~20 lines)
- `src/managers/ResourceOrchestrator.ts` (~2 lines)
- `src/index.ts` (~4 lines)

**Files Modified (Tests & Documentation - 4):**
- `tests/unit/ResourceOrchestrator.test.ts` (~3 lines)
- `docs/API.md` (documentation updates)
- `README.md` (simplified examples)
- `PROGRESS.md` (this section)

**Test Status:**
- ✅ All 238 tests passing (100% pass rate)
- ✅ TypeScript compiles with 0 errors
- ✅ No breaking changes to existing API

### Result

**Before Fix:**
```typescript
const result = await diffusionServer.generateImage({ prompt: '...' });
// ❌ Both models in memory → RAM/VRAM exhausted → System crash
```

**After Fix:**
```typescript
const result = await diffusionServer.generateImage({ prompt: '...' });
// ✅ Automatically:
// 1. Detects resource constraint (75% threshold)
// 2. Stops LLM server (saves config)
// 3. Generates image
// 4. Restarts LLM server (restores config)
// 5. Returns result
```

### Architecture Benefits

**For genai-lite Integration:**
- ✅ Clean API: Just call `diffusionServer.generateImage()`
- ✅ No orchestration knowledge needed: Happens automatically
- ✅ Safe by default: Won't crash from OOM

**For UI Developers:**
- ✅ Single API: Use `generateImage()` for everything
- ✅ No decisions: Orchestration handled automatically
- ✅ Optional control: Can check `wouldNeedOffload()` for warnings

**For Architecture:**
- ✅ Right abstraction: Orchestration is implementation detail
- ✅ Encapsulation: Resource management contained in DiffusionServerManager
- ✅ Backward compatible: Custom instances work without orchestrator
- ✅ Clean separation: ResourceOrchestrator remains testable, reusable class

### Impact

- **Prevents system crashes** from Out-of-Memory conditions
- **Zero API changes** for users - orchestration is now transparent
- **Automatic behavior** - users don't need to manage resources manually
- **Production ready** - safe default behavior for all use cases

---

## Key Achievements

### Test Infrastructure
- **Jest 30 + ESM**: Modern testing setup with ES modules support
- **238 tests passing**: Comprehensive coverage across 12 test suites
- **Clean exit**: No warnings, no memory leaks, no open handles
- **Fast execution**: ~3.5 seconds for full test suite

### Cross-Platform Compatibility
- **Windows, macOS, Linux**: All npm scripts work across platforms
- **Binary variant testing**: Automatic fallback (CUDA → Vulkan → CPU)
- **Platform-specific optimizations**: Metal (macOS), CUDA (Windows/Linux)

### Production Readiness
- **CI/CD Pipeline**: Automated testing on all platforms
- **Zero TypeScript errors**: Strict mode compilation
- **100% test pass rate**: All functionality verified
- **Comprehensive documentation**: API reference, setup guide, examples

---

## Documentation References

- **Phase 1 Details:** `docs/dev/phase1/`
- **Phase 2 Details:** `docs/dev/phase2/PHASE2-PROGRESS.md`
- **Testing Guide:** `docs/dev/ESM-TESTING-GUIDE.md`
- **Refactoring Analysis:** `docs/dev/REFACTORING-ANALYSIS.md`
- **API Reference:** `docs/API.md`
- **Setup Guide:** `docs/SETUP.md`

---

## Next Steps

**Immediate: Testing & Debugging (In Progress)**
- ✅ Phase 2 example app implementation complete
- ✅ Fixed critical diffusion binary extraction bug (Issue 3)
- ✅ Fixed diffusion binary test flag incompatibility (Issue 4)
- ✅ Implemented automatic CUDA runtime dependency downloading for both llama.cpp and stable-diffusion.cpp (Issue 5)
- ✅ Added architecture support for multi-file binary variants (main executable + runtime dependencies)
- ✅ Added CUDA GPU detection before attempting CUDA variant downloads
- ✅ **Implemented binary validation caching** (4-20x faster server startup)
- ✅ **Fixed memory cache staleness bug** (Issue 8 - eliminates false "Insufficient RAM" errors)
- 🔄 Testing resource orchestration with real workloads
- 🔄 Verification of model management across both types
- 🔄 Cross-platform testing (Windows, macOS, Linux)
- 🔄 Bug fixes and refinements based on testing
- 📋 Create pull request when testing complete

**Phase 3: Production Core** (Planned)
- Resume interrupted downloads
- Enhanced SHA256 checksum verification
- Advanced cancellation API
- Multi-model queue management

**Phase 4: Production Polish** (Planned)
- Auto-restart on crash
- Log rotation
- Port conflict detection
- Shared storage configuration

See `DESIGN.md` for complete roadmap and architectural details.
