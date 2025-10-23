# genai-electron Documentation Restructuring Plan

**Date**: 2025-10-23
**Goal**: Transform documentation from large scattered files into a portable, modular `genai-electron-docs/` folder optimized for developers building apps with genai-electron.

---

## Current Status

**Phase 1: COMPLETE** ✅ (2025-10-23)
- All 11 files created in `genai-electron-docs/`
- Total: ~19,922 words (18.4% expansion from 16,826 source words)
- Within target: 17,000-21,000 words (0-25% expansion) ✅
- Ground truth intact: README.md and API.md unchanged ✅

**Next:** Phase 2 (Audit and Trim) - Verify against codebase, remove bloat

---

## Executive Summary

### Current State

**Source Files** (ground truth, keep unchanged until Phase 4):
- README.md: 709 lines
- docs/API.md: 3,691 lines (massive monolith)
- examples/electron-control-panel/README.md: 262 lines
- **Total**: 4,659 lines, 16,826 words

### Target State

**After Restructuring**:
- README.md: ~500 words (condensed in Phase 4)
- docs/API.md: DELETED (in Phase 4)
- `genai-electron-docs/`: 11 focused documents
- **Target size**: ~17,000-21,000 words (0-25% expansion max, justified for portability/navigation)

---

## Guiding Principles for Modular Documentation

### Core Design Principles

**1. Portability First**
- **What**: Single self-contained folder that can be copied anywhere
- **Why**: Developers need documentation context when building apps using the library
- **How**: `genai-electron-docs/` folder works standalone, no external dependencies

**2. Single Responsibility Per Document**
- **What**: Each document answers one category of questions
- **Why**: Developers can find information quickly without reading everything
- **How**: Split by developer mental model (setup, detection, management, server operations, etc.)

**3. Self-Contained Documents**
- **What**: Each document includes everything needed to understand its topic
- **Why**: Copy one file to another project and it should make sense
- **How**: No links to README.md or API.md (they may change or will be deleted), reproduce necessary context

**4. Right-Sized Documents**
- **What**: Target 1,000-4,000 tokens (~400-1,600 words) per document
- **Why**: Too small = fragmentation overhead, too large = defeats modularity purpose
- **How**: Combine related APIs (e.g., all ModelManager methods in one doc)

**5. Flat Structure**
- **What**: No nested subdirectories in docs folder
- **Why**: Maximizes portability, eliminates path confusion when copying
- **How**: All 11 files at same level in `genai-electron-docs/`

**6. Front-Load Critical Information**
- **What**: Most important info in first 100-200 lines
- **Why**: Both humans and LLMs scan documents top-to-bottom
- **How**: Start with overview, then quick reference, then details

**7. Code-First Explanations**
- **What**: Show working example first, then explain
- **Why**: Developers learn by seeing code, not reading theory
- **How**: Every API method gets a runnable example before explanation

**8. Progressive Complexity**
- **What**: Simple → intermediate → advanced
- **Why**: Beginners aren't overwhelmed, experts can skip ahead
- **How**: Basic usage up front, advanced patterns and edge cases later

**9. Self-Contained Examples**
- **What**: Every code block should be runnable or near-runnable
- **Why**: Copy-paste into project and it should work (or almost work)
- **How**: Include imports, show complete minimal working examples

### Anti-Patterns to Avoid

**❌ Over-Fragmentation**
- Don't create one file per function (e.g., separate docs for `start()`, `stop()`, `restart()`)
- Do group related operations (entire LlamaServerManager in llm-server.md)

**❌ Circular Dependencies**
- Don't require reading Doc A to understand Doc B which requires Doc A
- Do make each document understandable on its own

**❌ Buried Critical Information**
- Don't hide important config details 1000 lines deep
- Do put critical setup info in first 200 lines

**❌ Vague Titles**
- Don't use generic names like "API.md" or "Guide.md"
- Do use specific names like "llm-server.md" or "integration-guide.md"

**❌ Undocumented APIs**
- Don't document an API without showing usage
- Do include working examples for every method

### Ground Truth Files Strategy

**During Phases 1-3**: Keep README.md and API.md **completely unchanged**
- **Why**: They are the source of truth for content
- **Why**: Prevents accidental information loss during restructuring
- **Why**: Allows comparison to verify completeness

**During Phase 4 Only**: Condense README.md, delete API.md
- **Why**: By then, all content safely extracted and verified
- **Why**: Final condensed README can link to portable docs folder

---

## Target Structure

```
genai-electron/
├── README.md (unchanged until Phase 4 → then ~500 words)
├── docs/
│   └── API.md (unchanged until Phase 4 → then DELETED)
├── src/
└── genai-electron-docs/                     # NEW: Portable documentation folder
    ├── index.md                             # Navigation hub + quick starts
    ├── installation-and-setup.md            # Installation, requirements, first steps
    ├── system-detection.md                  # SystemInfo API
    ├── model-management.md                  # ModelManager API + GGUF metadata
    ├── llm-server.md                        # LlamaServerManager API + binary management
    ├── image-generation.md                  # DiffusionServerManager + HTTP API + async patterns
    ├── resource-orchestration.md            # ResourceOrchestrator API
    ├── integration-guide.md                 # Lifecycle helpers, error formatting, Electron patterns
    ├── typescript-reference.md              # Types, interfaces, enums
    ├── troubleshooting.md                   # Common issues, error codes, FAQ
    └── example-control-panel.md             # Reference implementation patterns
```

**Developer Mental Model** (how to find docs):
1. "How do I install?" → installation-and-setup.md
2. "What hardware do I have?" → system-detection.md
3. "How do I get models?" → model-management.md
4. "How do I run an LLM?" → llm-server.md
5. "How do I generate images?" → image-generation.md
6. "Both LLM + images on limited resources?" → resource-orchestration.md
7. "Electron integration best practices?" → integration-guide.md
8. "What types are available?" → typescript-reference.md
9. "I'm stuck, help!" → troubleshooting.md
10. "Show me a real example" → example-control-panel.md

---

## Detailed File Breakdown

### 1. index.md (~600-800 words)

**Purpose**: Navigation hub + overview + quick starts

**Contents**:
- Navigation section (links to all docs with descriptions)
- Overview (what is genai-electron, how it relates to genai-lite)
- Quick Start: LLM (minimal working example)
- Quick Start: Image Generation (minimal working example)
- Quick Start: Both (with resource orchestration)
- What's Next? (guide to next steps)

**Source Material**:
- README.md: Overview, Features, Quick Start, Complete Example
- API.md: Complete Example: LLM + Image Generation (end of doc)

**Target**: ~800 words max

---

### 2. installation-and-setup.md (~400-600 words)

**Purpose**: Get developers running

**Contents**:
- Installation (`npm install genai-electron`)
- Peer dependencies (Electron >=25.0.0)
- Platform requirements (macOS 11+, Windows 10+, Linux versions)
- GPU drivers (optional setup: CUDA, Metal, ROCm, Vulkan)
- First run behavior (binary auto-download on first `start()`)
- Environment variables (LLAMACPP_API_BASE_URL, IMAGE_RESULT_TTL_MS, etc.)
- Verifying installation (simple test script)

**Source Material**:
- README.md: Installation, Platform Support, Technology Stack
- API.md: Environment Setup notes scattered throughout

**Target**: ~500 words

---

### 3. system-detection.md (~500-700 words)

**Purpose**: SystemInfo API - understand hardware capabilities

**Contents**:
- Overview (what SystemInfo does, when to use it)
- Core methods:
  - `detect()` - complete detection with caching behavior (60s cache)
  - `getMemoryInfo()` - real-time memory checks (no cache)
  - `canRunModel()` - with available vs total memory modes
  - `getOptimalConfig()` - auto-configuration for models
- Cache invalidation behavior (automatic on server start/stop)
- Platform-specific detection:
  - macOS: Metal support, system_profiler
  - Windows: NVIDIA via nvidia-smi
  - Linux: Multi-GPU support (NVIDIA, AMD, Intel)
- Examples for each method

**Source Material**:
- API.md: SystemInfo section (lines 40-195)
- README.md: System capability detection feature

**Target**: ~600 words

---

### 4. model-management.md (~700-900 words)

**Purpose**: ModelManager API - download, verify, manage models

**Contents**:
- Overview (model storage in userData, GGUF support)
- Core operations:
  - `downloadModel()` - URL and HuggingFace sources with examples
  - `listModels()` - filtering by type ('llm' | 'diffusion')
  - `getModelInfo()` - with GGUF metadata access
  - `deleteModel()` - with error handling
  - `verifyModel()` - checksum verification
- Download management:
  - `cancelDownload()` - abort in-progress downloads
  - `isDownloading()` - check download status
  - Progress callbacks
- GGUF metadata features:
  - Pre-download extraction (validates before downloading)
  - Accurate layer counts (`block_count`)
  - Context length (`context_length`)
  - Architecture detection (llama, gemma3, qwen3, etc.)
  - `updateModelMetadata()` - for models downloaded before GGUF integration
  - Metadata fetch strategies (local-remote, local-only, remote-only, remote-local)
  - Convenience methods: `getModelLayerCount()`, `getModelContextLength()`, `getModelArchitecture()`
- Reasoning model detection:
  - `detectReasoningSupport()` function
  - `REASONING_MODEL_PATTERNS` constant
  - Supported models (Qwen3, DeepSeek-R1, GPT-OSS)
  - Automatic flag injection (`--jinja --reasoning-format deepseek`)
- Error handling (ModelNotFoundError, DownloadError, ChecksumError)

**Source Material**:
- API.md: ModelManager section (lines 196-661), GGUF Metadata (lines 2562-2625), Reasoning Detection (lines 3168-3230)
- README.md: Model Management, GGUF metadata, Reasoning Models sections

**Target**: ~850 words

---

### 5. llm-server.md (~800-1000 words)

**Purpose**: LlamaServerManager API - run local LLMs

**Contents**:
- Overview (llama.cpp integration, auto-configuration, singleton pattern)
- Server lifecycle:
  - `start()` - auto-configuration vs manual config examples
  - `stop()` - graceful shutdown (SIGTERM → SIGKILL)
  - `restart()` - convenience method
- Configuration options:
  - Required: `modelId`, `port`
  - Optional: `threads`, `contextSize`, `gpuLayers`, `parallelRequests`, `flashAttention`
  - `forceValidation` flag
- Status and health:
  - `getStatus()` - simple string (synchronous)
  - `getInfo()` - complete ServerInfo (synchronous)
  - `isHealthy()` - async health check
  - `getHealthStatus()` - detailed health status
- Logs:
  - `getLogs()` - raw string array
  - `getStructuredLogs()` - parsed LogEntry objects for filtering/formatting
- Events (EventEmitter):
  - 'started' - server started successfully
  - 'stopped' - server stopped
  - 'crashed' - server crashed unexpectedly (with Error)
  - 'binary-log' - binary download/validation progress
- Binary management:
  - Auto-download on first `start()` (~50-100MB)
  - Variant testing (priority order: CUDA → Vulkan → CPU)
  - Real functionality tests (generates 1 token with `-ngl 1`)
  - Automatic fallback on GPU errors
  - Validation caching (checksum-based, 4-20x faster subsequent starts)
  - `forceValidation` for driver updates
- Reasoning model support (automatic flag injection for Qwen3, DeepSeek-R1, GPT-OSS)
- Error handling (ServerError, PortInUseError, BinaryError, InsufficientResourcesError)

**Source Material**:
- API.md: LlamaServerManager section (lines 663-1092), Binary Download and Variant Testing, Binary Validation Caching
- README.md: LLM Server Lifecycle, Binary Management features

**Target**: ~900 words

---

### 6. image-generation.md (~900-1200 words)

**Purpose**: DiffusionServerManager - generate images locally

**Contents**:
- Overview (stable-diffusion.cpp, HTTP wrapper architecture, on-demand spawning)
- Server lifecycle:
  - `start()` - auto-configuration, port defaults to 8081
  - `stop()` - graceful shutdown
- Configuration options:
  - Required: `modelId`
  - Optional: `port`, `threads`, `gpuLayers`, `vramBudget` (Phase 3, not yet implemented)
- Node.js API:
  - `generateImage()` - synchronous image generation
  - ImageGenerationConfig options:
    - Required: `prompt`
    - Optional: `negativePrompt`, `width`, `height`, `steps`, `cfgScale`, `seed`, `sampler`, `count`
    - `onProgress` callback with stage information
  - Progress tracking:
    - Stages: loading (model tensors) → diffusion (denoising steps) → decoding (VAE)
    - Self-calibrating time estimates
    - Stage-specific progress reporting
  - ImageGenerationResult (single image, for batch use HTTP API)
- HTTP API (async polling pattern):
  - Architecture: POST returns ID immediately, GET polls for status/results
  - Endpoints:
    - `POST /v1/images/generations` - start generation (returns {id, status, createdAt})
    - `GET /v1/images/generations/:id` - poll status (returns state with progress/result/error)
    - `GET /health` - server health and busy status
  - Complete workflow example (polling loop)
  - Batch generation (count: 1-5 images with auto-seed increment)
  - Error codes: SERVER_BUSY, NOT_FOUND, INVALID_REQUEST, BACKEND_ERROR, IO_ERROR
  - GenerationRegistry (TTL cleanup, configurable via env vars)
  - Migration notes from Phase 2.0 synchronous API
- Status and health:
  - `getStatus()`, `getInfo()`, `isHealthy()`
  - `busy` field in DiffusionServerInfo
- Logs:
  - `getLogs()`, `getStructuredLogs()`, `clearLogs()`
- Events (started, stopped, crashed, binary-log)
- Binary management (similar to LLM: variant testing, validation caching)
- Automatic resource orchestration (mention, link to resource-orchestration.md)
- Error handling

**Source Material**:
- API.md: DiffusionServerManager (lines 1095-1496), HTTP API Endpoints (lines 2070-2424), GenerationRegistry (lines 1746-2066)
- README.md: DiffusionServerManager section, HTTP API for Async Generation

**Target**: ~1100 words

---

### 7. resource-orchestration.md (~500-700 words)

**Purpose**: ResourceOrchestrator - manage resources when running both LLM and images

**Contents**:
- Overview (when to use: limited RAM/VRAM running both servers)
- How it works:
  - Detects bottleneck (RAM vs VRAM)
  - Estimates resource usage for both services
  - Offloads LLM if needed, generates image, reloads LLM
  - 75% availability threshold
- Automatic vs manual usage:
  - Singleton `diffusionServer` has built-in orchestration (transparent)
  - Manual `ResourceOrchestrator` for custom instances
- Constructor (`new ResourceOrchestrator(systemInfo, llamaServer, diffusionServer, modelManager)`)
- Methods:
  - `orchestrateImageGeneration()` - automatic LLM offload/reload
  - `wouldNeedOffload()` - check if offload would be needed
  - `getSavedState()` - inspect SavedLLMState (config, wasRunning, savedAt)
  - `clearSavedState()` - prevent automatic reload
- Resource estimation:
  - LLM formula: GPU mode = model_size * (gpu_layers / total_layers) * 1.2, CPU mode = model_size * 1.2
  - Diffusion formula: model_size * 1.2
  - Bottleneck detection (GPU systems use VRAM, CPU-only use RAM)
- Example scenarios:
  - 8GB VRAM system (offload needed)
  - 24GB VRAM system (no offload)
  - 16GB RAM CPU-only (offload needed)
- Batch generation limitation (orchestration bypassed for count > 1, planned Phase 3)

**Source Material**:
- API.md: ResourceOrchestrator section (lines 1500-1743)
- README.md: Automatic Resource Management

**Target**: ~600 words

---

### 8. integration-guide.md (~600-800 words)

**Purpose**: Electron integration patterns and best practices

**Contents**:
- Overview (integrating genai-electron into Electron apps)
- Initialization:
  - Must wait for `app.whenReady()` (userData path dependency)
  - Async initialization patterns
- Lifecycle management:
  - `attachAppLifecycle(app, managers)` - automatic cleanup on app quit
  - Registers `before-quit` listener
  - Stops all running servers gracefully
  - Manual cleanup patterns (if not using helper)
- Error handling:
  - `formatErrorForUI(error)` - converts library errors to UIErrorFormat
  - UIErrorFormat interface: {code, title, message, remediation}
  - Error codes reference table (all 8 error classes + unknown)
  - Benefits: eliminates brittle substring matching, consistent UI errors
  - IPC error handling patterns
- Integration with genai-lite:
  - Separation of concerns: genai-electron manages infrastructure, genai-lite provides API
  - Example pattern from electron-control-panel
  - Architecture diagram
- Best practices:
  - System detection on startup
  - Auto-configuration vs manual config
  - Health monitoring patterns
  - Event-driven UI updates
  - Log streaming to renderer
  - Model download progress (via IPC)
- Common patterns:
  - IPC handlers for server control
  - Structured log parsing for UI display
  - Resource monitoring (real-time memory checks)

**Source Material**:
- API.md: Lifecycle Management (lines 3338-3400), Error Formatting (lines 3403-3507), Utilities section
- README.md: Error Handling, Architecture diagram
- electron-control-panel README: Architecture, IPC Communication
- PROGRESS.md: Library Extraction Phase 1 Part 2

**Target**: ~700 words

---

### 9. typescript-reference.md (~800-1000 words)

**Purpose**: Complete type reference

**Contents**:
- Overview (TypeScript-first library, comprehensive type definitions)
- System types:
  - SystemCapabilities (cpu, memory, gpu, platform, recommendations, detectedAt)
  - CPUInfo (cores, model, architecture)
  - MemoryInfo (total, available, used)
  - GPUInfo (available, type, name, vram, cuda, metal, rocm, vulkan)
  - SystemRecommendations (maxModelSize, recommendedQuantization, threads, gpuLayers)
- Model types:
  - ModelInfo (id, name, type, size, path, downloadedAt, source, checksum, supportsReasoning, ggufMetadata)
  - ModelType ('llm' | 'diffusion')
  - ModelSource (type, url, repo?, file?)
  - GGUFMetadata (version, tensor_count, kv_count, architecture, block_count, context_length, etc.)
  - MetadataFetchStrategy ('local-remote' | 'local-only' | 'remote-only' | 'remote-local')
- Server types:
  - ServerStatus ('stopped' | 'starting' | 'running' | 'stopping' | 'crashed')
  - HealthStatus ('ok' | 'loading' | 'error' | 'unknown')
  - ServerInfo (status, health, pid?, port, modelId, startedAt?)
  - ServerConfig (modelId, port, threads?, contextSize?, gpuLayers?, parallelRequests?, flashAttention?, forceValidation?)
  - DiffusionServerInfo (extends ServerInfo with busy?)
  - DiffusionServerConfig (modelId, port?, threads?, gpuLayers?, vramBudget?)
- Image generation types:
  - ImageGenerationConfig (prompt, negativePrompt?, width?, height?, steps?, cfgScale?, seed?, sampler?, count?, onProgress?)
  - ImageGenerationResult (image, format, timeTaken, seed, width, height)
  - ImageSampler (8 options: euler_a, euler, heun, dpm2, dpm++2s_a, dpm++2m, dpm++2mv2, lcm)
  - ImageGenerationStage ('loading' | 'diffusion' | 'decoding')
  - ImageGenerationProgress (currentStep, totalSteps, stage, percentage?, currentImage?, totalImages?)
- Async generation types (HTTP API):
  - GenerationStatus ('pending' | 'in_progress' | 'complete' | 'error')
  - GenerationState (id, status, createdAt, updatedAt, config, progress?, result?, error?)
  - GenerationRegistryConfig (maxResultAgeMs?, cleanupIntervalMs?)
- Logging types:
  - LogEntry (timestamp, level, message)
  - LogLevel ('info' | 'warn' | 'error' | 'debug')
- Resource types:
  - SavedLLMState (config, wasRunning, savedAt)
- UI types:
  - UIErrorFormat (code, title, message, remediation?)
- Notable explanations:
  - GGUF architecture support (generic via getArchField)
  - Reasoning model patterns
  - Metadata fetch strategies (when to use which)
  - Progress percentage calculation across stages

**Source Material**:
- API.md: Types and Interfaces section (lines 2427-2974)
- README.md: Type mentions in features

**Target**: ~900 words

---

### 10. troubleshooting.md (~500-700 words)

**Purpose**: Common issues and solutions

**Contents**:
- Installation issues:
  - Electron version mismatch (require >=25.0.0)
  - Node.js version (require 22.x LTS)
  - Platform compatibility
- Server won't start:
  - Check model selection
  - Check available RAM/VRAM (use SystemInfo)
  - Check logs for errors
  - Port already in use
  - Model not found
- Download fails:
  - Network connectivity
  - Disk space insufficient
  - Invalid URL or HuggingFace path
  - Checksum mismatch (corruption)
  - Firewall/proxy issues
- GPU not detected:
  - macOS: Metal automatic (2016+ Macs)
  - Windows: NVIDIA drivers installation
  - Linux: NVIDIA drivers + cuda-toolkit, AMD ROCm (experimental)
  - Verify detection with `systemInfo.detect()`
- Binary validation failures:
  - CUDA errors (try Vulkan or CPU fallback)
  - Missing shared libraries
  - Use `forceValidation: true` after driver updates
  - Check binary-log events for details
- Model compatibility:
  - Wrong model type (LLM vs diffusion)
  - Unsupported architecture
  - Check GGUF metadata for architecture field
- Memory errors:
  - InsufficientResourcesError
  - Model too large for system
  - Use resource orchestration for both LLM + images
  - Check real-time memory with `getMemoryInfo()`
- HTTP API errors:
  - Error codes table (SERVER_BUSY, NOT_FOUND, INVALID_REQUEST, BACKEND_ERROR, IO_ERROR)
  - Generation not found (TTL expired, default 5 minutes)
  - Polling frequency recommendations
- llama.cpp connection issues:
  - Server not running (ECONNREFUSED)
  - Wrong port (check LLAMACPP_API_BASE_URL)
  - Health check timeout
- FAQ:
  - How to change binary download location? (Phase 4 feature)
  - How to use shared model storage? (Phase 4 feature)
  - Can I use custom llama.cpp builds? (yes, via LLAMACPP_API_BASE_URL)
  - How to disable GPU? (set gpuLayers: 0)
  - How to enable embeddings with llama.cpp? (use --embeddings flag)

**Source Material**:
- API.md: Error Classes section (lines 2977-3135), error handling examples throughout
- README.md: Error Handling section, Troubleshooting mentions
- electron-control-panel README: Troubleshooting section (lines 163-187)
- PROGRESS.md: Common issues during development

**Target**: ~650 words

---

### 11. example-control-panel.md (~600-800 words)

**Purpose**: Reference implementation patterns from electron-control-panel

**Contents**:
- Overview:
  - What the example demonstrates (not a tutorial, but patterns to study)
  - Location: examples/electron-control-panel/
  - Purpose: reference implementation for infrastructure management apps
- Features showcase:
  - System Info tab (hardware detection, auto-refresh, status indicators)
  - Model Management tab (LLM + Diffusion models, download progress, GGUF metadata viewer)
  - LLM Server tab (lifecycle, auto-config, test chat, log viewer)
  - Diffusion Server tab (image generation, progress tracking, parameter control)
  - Resource Monitor tab (real-time memory/GPU tracking, orchestration status, event log)
- Architecture:
  - Tech stack: Electron + React + TypeScript + Vite
  - Structure: main/ (server management) + renderer/ (UI components)
  - IPC communication patterns
  - genai-lite integration (LLMService + ImageService for API, genai-electron for infrastructure)
- Key patterns (reference, not step-by-step):
  - System info polling (every 5s + on server events)
  - Server lifecycle via IPC (start/stop/restart handlers)
  - Model download with progress (streaming updates via IPC)
  - Health monitoring (periodic checks + event-driven updates)
  - GGUF metadata viewer (modal with collapsible sections, refresh capability)
  - Resource monitor implementation (real-time memory, event log with TTL)
  - Structured log parsing for UI (using `getStructuredLogs()`)
  - Event-driven UI updates (server events → webContents.send → React state)
- Integration pattern (genai-electron + genai-lite):
  - genai-electron in main process (server management, binaries, resources)
  - genai-lite in main process (LLMService, ImageService for unified API)
  - Separation of concerns diagram
- Running the example:
  - Prerequisites (Node.js 22.x, platform requirements)
  - Installation (cd examples/electron-control-panel && npm install)
  - Development (npm run dev)
  - Building (npm run build && npm run package)
- Using for testing:
  - Make changes to genai-electron source
  - Rebuild library (npm run build in root)
  - Restart example app
  - Test interactively
- Link to app's own README for complete setup details

**Source Material**:
- examples/electron-control-panel/README.md (complete)
- CLAUDE.md: electron-control-panel section
- DESIGN-EXAMPLE-APP.md (if needed for architecture details)

**Target**: ~700 words

---

## Implementation Phases

### Phase 1: Create Structure and Initial Split

**Goal**: Extract all content from ground truth files into new structure

**Steps**:
1. Create `genai-electron-docs/` folder
2. Create 11 empty .md files with headers and table of contents
3. Extract content from README.md, API.md, app README into appropriate files
4. Add navigation to index.md
5. Verify all content is accounted for (nothing lost in split)

**Important**:
- Do NOT modify README.md or API.md (keep as ground truth)
- Initial split may be bloated (that's okay, Phase 2 will trim)
- Focus on completeness, not word count yet

**Deliverable**: 11 populated docs in `genai-electron-docs/` folder

**Estimated Time**: 4-6 hours

---

### Phase 2: Audit and Trim

**Status**: ✅ **COMPLETE** (2025-10-23)

**Goal**: Verify accuracy, remove bloat, ensure self-containment

**Completion Summary**:
- All 11 files audited and verified against codebase
- All files trimmed for conciseness while maintaining completeness
- All files double-checked for accuracy
- Self-containment verified (no README/API.md links)
- Production-ready `genai-electron-docs/` folder achieved

**Critical Insight**: AI-generated documentation bloats to 2-3x original size without aggressive trimming. The genai-lite restructuring initially ballooned from 7,123 words to 21,201 words (3x) before trimming back to 10,397 words (51% reduction). We must be vigilant.

---

#### Step-by-Step Verification Workflow (For Each File)

**Step 1: Read and Understand**
- Read the entire document from start to finish
- Understand what it's trying to teach
- Note what feels verbose or redundant

**Step 2: VERIFY AGAINST CODEBASE** ⚠️ CRITICAL STEP
- **Why**: README.md can be outdated or marketing-focused. Codebase is the source of truth.
- **Why**: Type definitions, method signatures, env vars must match actual code users will write.
- **How**: Open the actual source files and check everything (see checklist below)

**What to Check in Codebase** (Concrete Checklist):

✅ **Type Definitions** (`src/types/`)
- Interface field names and types (e.g., `SystemCapabilities` interface)
- Union type options (e.g., `ServerStatus = 'stopped' | 'starting' | ...`)
- Optional vs required fields (presence of `?`)
- Generic type parameters
- Enum values and their string literals

✅ **Method Signatures** (`src/managers/*.ts`)
- Method names (exact spelling, capitalization)
- Parameter names and order
- Parameter types (string, number, config objects)
- Optional parameters (check for `?`)
- Return types (Promise<X>, void, synchronous values)
- Default parameter values in code

✅ **Environment Variables** (grep codebase for `process.env`)
- Variable names (exact case: `LLAMACPP_API_BASE_URL` not `llamacpp_api_base_url`)
- Default values in code (what happens if not set?)
- Where they're used (which managers check them?)

✅ **Error Classes** (`src/errors/`)
- Error class names (exact: `ModelNotFoundError` not `ModelNotFound`)
- Error codes (e.g., `'MODEL_NOT_FOUND'`)
- Error message patterns (what strings users will actually see)
- Details object structure

✅ **Configuration Options** (look at manager constructors and `start()` methods)
- Config field names (exact spelling)
- Default values (what's the default if not specified?)
- Valid ranges (e.g., `steps: 1-150`)
- Required vs optional fields

✅ **Actual Strings Users Reference** (constants, enums)
- Event names: `'started'`, `'stopped'`, `'crashed'`
- Sampler names: `'euler_a'`, `'dpm++2m'`
- Provider IDs: `'llamacpp'`
- Any string literal a user must type exactly

**Step 3: Verify Against Ground Truth Files**
- **Grep README.md** for related keywords to find any missing content
- **Grep API.md** for method names to ensure complete API coverage
- Note what's missing that should be added back after trimming

**Step 4: Create Trimming Plan**
- Now you know what's accurate (from codebase) and what's missing (from ground truth)
- Identify verbose sections to cut (see "What is Bloat" below)
- Plan to preserve essential content (see "What to Keep" below)
- Plan to add back any missing content found in step 3

**Step 5: Execute Trimming**
- Remove verbose prose (see "Common Bloating Patterns" below)
- Remove obvious comments from code
- Simplify examples while keeping them functional
- Add back any missing content identified in step 3
- Ensure self-containment (no README.md links)

**Step 6: Measure Results**
- Count words: `wc -w filename.md`
- Track reduction percentage
- Verify still complete and accurate

---

#### What is Bloat vs What to Keep

**🗑️ BLOAT** (Remove This):

**Verbose Introductions**
- ❌ "In this section, we will explore the fascinating world of system detection, which is a crucial component of the genai-electron library that allows developers to understand their hardware capabilities..."
- ✅ "SystemInfo detects hardware capabilities (CPU, RAM, GPU)."

**Philosophical Explanations**
- ❌ "It's worth noting that understanding your system's capabilities is essential for optimal performance, as it allows the library to make intelligent decisions about resource allocation..."
- ✅ "Auto-configuration uses detected capabilities to set optimal threads and GPU layers."

**Obvious Comments in Code**
- ❌ `// Create service instance`
- ❌ `// This calls the start method`
- ❌ `// We await the promise to get the result`
- ✅ (no comment, the code is self-explanatory)

**Redundant "Related Documentation" Sections**
- ❌ Listing 10 related docs at the end of every file
- ✅ Link only to directly related docs (2-3 max)

**Restating What Code Obviously Does**
- ❌ "Here we import the systemInfo object from genai-electron, and then we call the detect method which returns a promise..."
- ✅ (just show the code, it's clear)

**Transitional Filler**
- ❌ "As we can see from the example above..."
- ❌ "Let's take a closer look at..."
- ❌ "Now that we understand X, let's move on to Y..."
- ✅ (direct statements, no fluff transitions)

**🔐 KEEP** (Preserve This):

**Non-Obvious Edge Cases**
- ✅ "Note: `canRunModel()` has two modes: available memory (default) for LLM servers, total memory (`checkTotalMemory: true`) for diffusion servers. This is because diffusion loads models on-demand after ResourceOrchestrator frees memory."
- **Why**: This is not obvious and affects usage

**Important Caveats**
- ✅ "Warning: Binary validation caching uses SHA256 checksum. If you update GPU drivers, use `forceValidation: true` to re-run functionality tests."
- **Why**: Users will hit this issue and need to know the solution

**Configuration Gotchas**
- ✅ "Default TTL is 5 minutes. If polling too slowly, results may expire. Configure with `IMAGE_RESULT_TTL_MS` environment variable."
- **Why**: Not obvious, will cause "not found" errors if unaware

**Actual Technical Details**
- ✅ "Cache invalidation happens automatically on `llamaServer.start()` and `diffusionServer.start()` to reflect memory state changes."
- **Why**: Explains behavior that might confuse users

**When Not to Do Something**
- ✅ "Don't use `--jinja` flag manually. LlamaServerManager automatically adds it for reasoning-capable models (detected via filename patterns)."
- **Why**: Prevents common mistakes

**Why a Design Decision Was Made**
- ✅ "HTTP API uses polling pattern (not WebSockets) because stable-diffusion.cpp is a one-shot executable, not a persistent server."
- **Why**: Explains architecture, prevents feature requests for WebSockets

---

#### Common Bloating Patterns (Recognize and Eliminate)

**Pattern 1: Three-Paragraph Intro Where One Sentence Suffices**
- ❌ Para 1: "Welcome to the SystemInfo documentation..."
- ❌ Para 2: "System detection is important because..."
- ❌ Para 3: "In this document you will learn..."
- ✅ One sentence: "SystemInfo detects hardware (CPU, RAM, GPU) and recommends optimal configurations."

**Pattern 2: "As We Can See" Disease**
```markdown
❌ As we can see from the example above, the detect() method returns a Promise...
As we can see, we can access the CPU information through the cpu property...
As you can see, the memory information includes both total and available RAM...
```
✅ (Just describe what's there, don't narrate that we're seeing it)

**Pattern 3: Explaining the Obvious**
```typescript
❌ // First, we import the systemInfo singleton from genai-electron
❌ import { systemInfo } from 'genai-electron';
❌
❌ // Then, we await the detect() method to get capabilities
❌ const capabilities = await systemInfo.detect();
❌
❌ // Finally, we log the CPU cores to the console
❌ console.log(capabilities.cpu.cores);
```
```typescript
✅ import { systemInfo } from 'genai-electron';
✅
✅ const capabilities = await systemInfo.detect();
✅ console.log('CPU cores:', capabilities.cpu.cores);
```

**Pattern 4: Excessive "Related Documentation"**
```markdown
❌ ## Related Documentation
❌ - [Installation](installation.md) - How to install the library
❌ - [Model Manager](model-management.md) - Managing models
❌ - [LLM Server](llm-server.md) - Running LLM servers
❌ - [Diffusion Server](image-generation.md) - Image generation
❌ - [Resource Orchestration](resource-orchestration.md) - Managing resources
❌ - [Integration Guide](integration-guide.md) - Electron patterns
❌ - [TypeScript Reference](typescript-reference.md) - Types
❌ - [Troubleshooting](troubleshooting.md) - Common issues
```
```markdown
✅ See also: [Model Manager](model-management.md) for checking model requirements,
✅ [LLM Server](llm-server.md) for using detected capabilities.
```

**Pattern 5: Verbose Method Descriptions**
```markdown
❌ The `detect()` method is an asynchronous function that, when called, will
❌ perform a comprehensive scan of your system's hardware capabilities including
❌ the CPU configuration, memory availability, and GPU presence. The method will
❌ return a Promise that resolves to a SystemCapabilities object containing all
❌ of this detailed information which you can then use throughout your application.
```
```markdown
✅ `detect()` scans system hardware (CPU, RAM, GPU) and returns SystemCapabilities.
✅ Results are cached for 60 seconds.
```

**Pattern 6: Step-by-Step Narration**
```markdown
❌ Let's walk through this example step by step. First, we'll import the necessary
❌ components. Then, we'll call the detection method. After that, we'll examine
❌ the results. Finally, we'll use those results to configure our server.
```
```markdown
✅ Example:
✅ (show the code directly with minimal explanation)
```

---

#### Ensure Self-Containment Checklist

After trimming, verify:
- [ ] No links to `README.md` (it may change in future)
- [ ] No links to `../docs/API.md` (will be deleted in Phase 4)
- [ ] All necessary context reproduced from README (don't assume user has read it)
- [ ] All cross-references stay within `genai-electron-docs/` folder
- [ ] Test: "If I copy this single file to another project, can I understand it?"
- [ ] Test: "If I copy the entire folder, does it work standalone?"

---

**Deliverable**: Lean, accurate, self-contained documentation (0-25% expansion max)

**Estimated Time**: 6-8 hours (most time-consuming but most important phase)

---

### Phase 3: Polish and Verify (Parallelizable)

**Status**: ✅ **COMPLETE** (2025-10-23)

**Goal**: Final quality checks and consistency across all documentation files

**Approach**: Phase 3 is designed for **parallel execution** across multiple workers. Each worker verifies one documentation file independently and produces a standardized report. After all workers complete, aggregate tasks combine results and perform cross-file checks.

**Completion Summary**:
- **All 11 worker tasks completed**: Each documentation file verified independently
- **All 2 aggregate tasks completed**: Cross-file consistency (Task 12) and final statistics (Task 13)
- **Final word count**: 14,753 words across 11 files
- **Budget achievement**: 70.3% utilization (well under 21,000 word limit)
- **Word count change**: -12.3% reduction from 16,826 baseline (eliminated duplication, improved organization)
- **Critical issues found**: 0
- **Minor issues found**: 0 (1 found in typescript-reference.md and fixed immediately)
- **Links verified**: 30+ internal links, all valid, zero links to README/API.md
- **Examples verified**: 16+ code examples, all verified against actual codebase
- **Types verified**: 39 TypeScript types, 100% accuracy (all fields match source exactly)
- **Tests passed**: All 273 tests passing (verified by parallel worker)
- **Production readiness**: ✅ All files ready for Phase 4

**Key Achievement**: Despite 12.3% fewer words, achieved better organization (11 focused files vs 2 monolithic), easier navigation, complete API coverage, and verified accuracy.

---

#### Worker Tasks (1-11): Independent File Verification

Each worker task verifies one documentation file using the checklist below. Workers operate independently with no dependencies on each other.

**Standard Verification Checklist (All Workers)**:

For your assigned file, perform these checks:

1. **Link Verification**:
   - ✅ All `[text](file.md)` links point to existing files in `genai-electron-docs/`
   - ✅ All `[text](file.md#section)` anchor links exist in target files
   - ✅ All paths are relative (no absolute paths)
   - ❌ **CRITICAL**: NO links to `../README.md` or `../docs/API.md` (docs must be self-contained)
   - List all broken or invalid links

2. **Example Verification** (check against actual codebase):
   - ✅ Imports match exports in `src/index.ts`
   - ✅ Method names match source in `src/managers/*.ts`
   - ✅ Parameter names/order match method signatures
   - ✅ Type names match `src/types/*.ts`
   - ✅ Examples would actually work if copy-pasted
   - List any examples with errors

3. **Formatting Consistency**:
   - ✅ Heading hierarchy (H1 → H2 → H3, no skipping levels)
   - ✅ Code blocks use ` ```typescript` language tag (not `js` or unmarked)
   - ✅ Consistent terminology (document any variations found)
   - List formatting issues

4. **Word Count**:
   - Count words: `wc -w genai-electron-docs/[filename].md`
   - Report total for this file

**Output Format**: Use the Report Template below

---

#### Task 1: Verify `index.md`

**File**: `genai-electron-docs/index.md`

**Additional Checks** (specific to this file):
- ✅ Navigation section has links to all 10 other docs
- ✅ Each navigation link has a brief description
- ✅ Quick start examples are runnable
- ✅ "What's Next" section guides to appropriate docs

**Perform**: Standard Verification Checklist + Additional Checks

**Report**: Use Report Template for "index.md"

---

#### Task 2: Verify `installation-and-setup.md`

**File**: `genai-electron-docs/installation-and-setup.md`

**Additional Checks**:
- ✅ Installation command is correct
- ✅ Peer dependency versions match package.json
- ✅ Platform requirements are accurate
- ✅ Environment variables match actual code usage (grep `process.env`)

**Perform**: Standard Verification Checklist + Additional Checks

**Report**: Use Report Template for "installation-and-setup.md"

---

#### Task 3: Verify `system-detection.md`

**File**: `genai-electron-docs/system-detection.md`

**Additional Checks**:
- ✅ All SystemInfo methods documented
- ✅ Method signatures match `src/system/system-info.ts`
- ✅ Cache behavior (60s) mentioned where relevant
- ✅ Platform-specific detection details accurate

**Perform**: Standard Verification Checklist + Additional Checks

**Report**: Use Report Template for "system-detection.md"

---

#### Task 4: Verify `model-management.md`

**File**: `genai-electron-docs/model-management.md`

**Additional Checks**:
- ✅ All ModelManager methods documented
- ✅ DownloadConfig options match types
- ✅ GGUF metadata features explained
- ✅ Reasoning model detection documented
- ✅ MetadataFetchStrategy values match type definition

**Perform**: Standard Verification Checklist + Additional Checks

**Report**: Use Report Template for "model-management.md"

---

#### Task 5: Verify `llm-server.md`

**File**: `genai-electron-docs/llm-server.md`

**Additional Checks**:
- ✅ All LlamaServerManager methods documented
- ✅ ServerConfig options match type definition
- ✅ Binary management process explained
- ✅ Validation caching documented
- ✅ Event names ('started', 'stopped', 'crashed', 'binary-log') correct

**Perform**: Standard Verification Checklist + Additional Checks

**Report**: Use Report Template for "llm-server.md"

---

#### Task 6: Verify `image-generation.md`

**File**: `genai-electron-docs/image-generation.md`

**Additional Checks**:
- ✅ All DiffusionServerManager methods documented
- ✅ ImageGenerationConfig options match type
- ✅ HTTP API endpoints documented
- ✅ Async polling pattern explained
- ✅ GenerationStatus values ('pending', 'in_progress', 'complete', 'error') correct
- ✅ Error codes (SERVER_BUSY, NOT_FOUND, etc.) match implementation

**Perform**: Standard Verification Checklist + Additional Checks

**Report**: Use Report Template for "image-generation.md"

---

#### Task 7: Verify `resource-orchestration.md`

**File**: `genai-electron-docs/resource-orchestration.md`

**Additional Checks**:
- ✅ ResourceOrchestrator constructor signature correct
- ✅ All methods documented
- ✅ Resource estimation formulas accurate
- ✅ 75% threshold mentioned
- ✅ SavedLLMState interface correct

**Perform**: Standard Verification Checklist + Additional Checks

**Report**: Use Report Template for "resource-orchestration.md"

---

#### Task 8: Verify `integration-guide.md`

**File**: `genai-electron-docs/integration-guide.md`

**Additional Checks**:
- ✅ attachAppLifecycle() signature correct
- ✅ formatErrorForUI() signature and return type correct
- ✅ UIErrorFormat interface matches type definition
- ✅ Error codes table complete (all 8 error classes)
- ✅ Electron integration patterns accurate

**Perform**: Standard Verification Checklist + Additional Checks

**Report**: Use Report Template for "integration-guide.md"

---

#### Task 9: Verify `typescript-reference.md`

**File**: `genai-electron-docs/typescript-reference.md`

**Additional Checks**:
- ✅ All type interfaces match `src/types/*.ts`
- ✅ Field names and types accurate
- ✅ Optional fields (?) marked correctly
- ✅ Enum/union values complete
- ✅ No hallucinated types or fields

**Perform**: Standard Verification Checklist + Additional Checks

**Report**: Use Report Template for "typescript-reference.md"

---

#### Task 10: Verify `troubleshooting.md`

**File**: `genai-electron-docs/troubleshooting.md`

**Additional Checks**:
- ✅ Error class names match `src/errors/*.ts`
- ✅ Solutions reference actual methods/config options
- ✅ Common issues cover major failure modes
- ✅ FAQ answers are accurate

**Perform**: Standard Verification Checklist + Additional Checks

**Report**: Use Report Template for "troubleshooting.md"

---

#### Task 11: Verify `example-control-panel.md`

**File**: `genai-electron-docs/example-control-panel.md`

**Additional Checks**:
- ✅ Features list matches actual app features
- ✅ Tech stack accurate
- ✅ Integration patterns reflect actual implementation
- ✅ Running instructions are correct

**Perform**: Standard Verification Checklist + Additional Checks

**Report**: Use Report Template for "example-control-panel.md"

---

#### Report Template

Each worker must produce a report in this exact format:

```markdown
# Phase 3 Verification Report: [filename.md]

**Worker**: Task [N]
**File**: genai-electron-docs/[filename].md
**Date**: [YYYY-MM-DD]

---

## 1. Link Verification

**Status**: ✅ PASS / ❌ FAIL

**Internal Links Checked**: [number]

**Broken Links**:
- [List each broken link, or write "None"]

**Links to README.md or API.md**:
- [List any forbidden links, or write "None"]

**Issues**:
- [List any other link issues, or write "None"]

---

## 2. Example Verification

**Status**: ✅ PASS / ❌ FAIL

**Code Examples Checked**: [number]

**Issues Found**:
- [List examples with problems, or write "None"]
  - Example at line [X]: [description of issue]

**Verification Notes**:
- [Any observations about examples]

---

## 3. Formatting Consistency

**Status**: ✅ PASS / ❌ FAIL

**Heading Hierarchy**: ✅ PASS / ❌ FAIL
- [Details if failed, or "Correct hierarchy"]

**Code Block Language Tags**: ✅ PASS / ❌ FAIL
- [List any unmarked or incorrectly tagged blocks, or "All tagged correctly"]

**Terminology Consistency**:
- [List any terminology variations noted, or "Consistent"]

**Other Formatting Issues**:
- [List any issues, or "None"]

---

## 4. Additional Checks (File-Specific)

**Status**: ✅ PASS / ❌ FAIL

[For each additional check specific to this file:]
- ✅/❌ [Check name]: [Details]

---

## 5. Word Count

**Total Words**: [number]

---

## Summary

**Overall Status**: ✅ READY / ⚠️ NEEDS FIXES / ❌ MAJOR ISSUES

**Critical Issues**: [number]
**Minor Issues**: [number]

**Recommended Actions**:
- [List any fixes needed, or "None - file is ready"]

---
```

---

#### Aggregate Task 12: Cross-File Consistency

**Depends On**: All worker tasks (1-11) complete

**Goal**: Analyze all 11 worker reports to identify cross-file inconsistencies

**Inputs**: All 11 worker reports

**Tasks**:
1. **Terminology Consistency**:
   - Compare terminology sections from all reports
   - Identify inconsistent usage across files (e.g., "LLM server" vs "llama-server")
   - Create list of terms that need standardization

2. **Formatting Consistency**:
   - Check if all files use same heading style
   - Check if all files use same code block patterns
   - Check if all files use similar example structures

3. **Link Network**:
   - Verify all cross-references form a coherent network
   - Check for orphaned files (not linked from index.md)
   - Check for circular or redundant links

4. **Completeness**:
   - Verify all 11 files covered
   - Check no features/APIs missing across all files
   - Verify docs answer common developer questions

**Output**: Aggregate consistency report with list of cross-file issues to fix

---

#### Aggregate Task 13: Final Word Count and Stats

**Depends On**: All worker tasks (1-11) complete

**Goal**: Calculate final statistics and verify within budget

**Tasks**:
1. **Sum Word Counts**:
   - Extract word count from each of 11 worker reports
   - Calculate total across all files
   - Verify total ≤ 21,000 words (max 25% expansion from 16,826 baseline)

2. **Generate Stats**:
   - Total words: [X]
   - Baseline (README + API + app README): 16,826 words
   - Expansion: [X]% [(total - 16826) / 16826 * 100]
   - Average words per file: [X / 11]

3. **Word Count Breakdown**:
   - Create table showing words per file
   - Identify any files that are outliers (too long/short)
   - Flag files to trim if over budget

4. **Phase 3 Completion Summary**:
   - Total issues found: [from all reports]
   - Critical issues: [count]
   - Minor issues: [count]
   - Ready for Phase 4: ✅/❌

**Output**: Final statistics document + go/no-go decision for Phase 4

---

#### Success Criteria

Phase 3 is complete when:

✅ **All 11 worker reports submitted** with standardized format
✅ **Aggregate consistency report** identifies cross-file issues (if any)
✅ **Final word count** ≤ 21,000 words (or trimming plan created)
✅ **All critical issues** documented with clear fix recommendations
✅ **Links verified**: No broken links, no README/API.md links
✅ **Examples verified**: All examples match actual codebase
✅ **Formatting consistent**: Same patterns across all files

---

**Deliverable**: Production-ready `genai-electron-docs/` folder (or clear list of remaining fixes)

**Estimated Time**:
- **Parallel execution**: 15-30 minutes (all 11 workers run simultaneously)
- **Aggregate tasks**: 15-20 minutes (sequential, after workers)
- **Total**: 30-50 minutes (vs 2-3 hours sequential)

---

### Phase 4: Final Cleanup (Ground Truth Modification)

**Status**: ✅ **COMPLETE** (2025-10-23)

**Goal**: Update/remove original files

**Completion Summary**:

**Task 1: Condense README.md** ✅
- Before: 2,810 words
- After: 313 words
- Reduction: 89% (2,497 words removed)
- Result: Clean landing page with prominent link to genai-electron-docs/

**Task 2: Delete docs/API.md** ✅ (handled by parallel worker)
- All 12,747 words migrated to genai-electron-docs/
- File deleted
- References updated across codebase

**Task 3: Update CLAUDE.md** ✅
- Updated Phase 1 context (line 172)
- Updated "Important Files to Reference" section (lines 188-212)
- Added detailed genai-electron-docs/ breakdown
- All API.md references removed

**Task 4: Update References** ✅
- docs/SETUP.md: 2 references updated
- DESIGN.md: 2 references updated (file structure + documentation section)
- PROGRESS.md: 4 references updated
- No broken links remaining
- Historical docs (docs/dev/) preserved as-is

**Final Statistics**:
- README.md: 2,810 → 313 words (89% reduction)
- Total documentation: 15,557 → 15,066 words (3% reduction, massively better organization)
- Structure: 2 monolithic files → 1 landing page + 11 modular docs

**Deliverable**: Clean repository with portable docs folder ✅

**Completion Time**: ~45 minutes (parallel execution)

---

## Success Metrics

The restructuring succeeds when these criteria are met:

### Phase 1 Completion
1. ✅ **Structure created**: `genai-electron-docs/` folder with 11 .md files
2. ✅ **Content extracted**: All content from README.md + API.md + app README accounted for
3. ✅ **Ground truth intact**: README.md and API.md completely unchanged
4. ✅ **Navigation hub**: index.md has links to all docs with descriptions

### Phase 2 Completion
1. ✅ **Accuracy verified**: Every API checked against actual source code in `src/`
   - Type definitions match `src/types/`
   - Method signatures match manager files
   - Environment variables match `process.env` usage
   - Error classes match `src/errors/`
2. ✅ **Bloat removed**: Applied "What is Bloat vs What to Keep" guidelines to every file
3. ✅ **Size discipline**: Total ≤ 21,000 words (max 25% expansion from 16,826)
4. ✅ **Self-contained**: No links to README.md or API.md, all docs work standalone
5. ✅ **Completeness**: No important content lost in trimming (checked against ground truth)

### Phase 3 Completion
1. ✅ **Links verified**: All internal links work, correct relative paths
2. ✅ **Examples verified**: Code examples actually compile/work
3. ✅ **Consistency**: Same formatting, heading levels, terminology across all docs
4. ✅ **Code-first**: Every API method has working example before explanation

### Phase 4 Completion
1. ✅ **README condensed**: 313 words (89% reduction from 2,810) with prominent link to docs folder
2. ✅ **API.md deleted**: File removed, all 12,747 words migrated to genai-electron-docs/
3. ✅ **CLAUDE.md updated**: References changed from "docs/API.md" to "genai-electron-docs/"
4. ✅ **Other files updated**: docs/SETUP.md (2 refs), DESIGN.md (2 refs), PROGRESS.md (4 refs)

### Final Results Summary

**Documentation Transformation**:
- Before: 2,810 (README) + 12,747 (API.md) = 15,557 words (2 monolithic files)
- After: 313 (README) + 14,753 (genai-electron-docs/) = 15,066 words (1 landing + 11 modular files)
- Net change: -491 words (-3%), massively improved organization

**Word Count Achievement**:
- Total: 14,753 words (11 files in genai-electron-docs/)
- Budget: 21,000 words maximum
- Utilization: 70.3% (well under budget)
- Baseline comparison: -12.3% reduction from 16,826 baseline

**Quality Achievements**:
- 0 critical issues found across all 11 files
- 0 minor issues remaining (1 found in typescript-reference.md, fixed immediately)
- 39 TypeScript types verified (100% accuracy)
- 30+ links verified (all valid, zero broken links)
- 16+ code examples verified against actual codebase
- All 273 tests passing

**Key Success**: Achieved 12.3% word count reduction while improving organization from 2 monolithic files to 11 focused, navigable files

### Overall Quality Checks
1. ✅ **Portability test**: Copy `genai-electron-docs/` to another project, does it work standalone?
2. ✅ **Navigation test**: Can developer find any API by thinking "what am I trying to do?"
3. ✅ **Accuracy test**: All APIs, types, env vars match actual codebase
4. ✅ **Flat structure**: No nested directories in docs folder
5. ✅ **Clarity**: Example app docs show integration patterns, not feature lists
6. ✅ **No bloat**: Verbose prose eliminated, non-obvious details preserved

---

## Key Differences from genai-lite Restructuring

1. **Larger baseline**: 16,826 words vs genai-lite's 7,123 words (2.4x more content)
2. **More complex API surface**: 5 major managers vs genai-lite's 2 services
3. **HTTP API addition**: Async image generation adds ~800 words of unique content
4. **Electron-specific patterns**: Integration guide has no equivalent in genai-lite
5. **Binary management**: Complex variant testing/caching unique to genai-electron (~400 words)
6. **Resource orchestration**: Cross-manager coordination unique to genai-electron
7. **Ground truth approach**: Keep README.md and API.md unchanged until final phase (learn from genai-lite experience)

---

## Lessons Learned from genai-lite Documentation Restructuring

### What Happened in genai-lite (October 2025)

**Initial State**: Single README.md with 7,123 words
**After Phase 1 Split**: 9 documents with 21,201 words (3x bloat! 🚨)
**After Phase 2 Trimming**: 9 documents with 10,397 words (51% reduction, 46% expansion)

### Critical Insights to Apply

**1. Verify Against Codebase is NON-NEGOTIABLE**
- **What happened**: Initial docs had hallucinated APIs, wrong type names, incorrect env vars
- **Why it matters**: README can be outdated, marketing-focused, or simply wrong
- **Solution**: Always check actual source code - types, method signatures, env vars, error strings
- **For genai-electron**: Check `src/types/`, `src/managers/`, `src/errors/`, grep for `process.env`

**2. AI-Generated Docs Bloat 2-3x Without Aggressive Trimming**
- **What happened**: LLM added verbose intros, philosophical explanations, obvious comments
- **Why it matters**: Defeats the purpose of modular documentation
- **Solution**: Follow "What is Bloat vs What to Keep" guidelines religiously
- **For genai-electron**: Expect initial split to be ~40,000-50,000 words, must trim to ~17,000-21,000

**3. Self-Contained ≠ Redundant**
- **What happened**: Confusion about whether to link to README or reproduce content
- **Why it matters**: Portable docs must work standalone, but shouldn't duplicate everything
- **Solution**: Reproduce *necessary* context from README, but trim aggressively within docs folder
- **For genai-electron**: Each doc reproduces its own context, but no duplicate API descriptions

**4. Flat Structure is Essential for Portability**
- **What happened**: Initial plan had nested `api/`, `guides/`, `examples/` subdirectories
- **Why it matters**: Nested paths break when copying folder elsewhere
- **Solution**: All docs at same level in `genai-electron-docs/`
- **For genai-electron**: 11 files, all at root of docs folder, no subdirectories

**5. Example Apps Need "Reference Implementation" Framing**
- **What happened**: Example docs read like feature lists, not integration patterns
- **Why it matters**: Developers expect patterns to study, not tutorials
- **Solution**: Frame as "what the example demonstrates" not "how to build a chat app"
- **For genai-electron**: example-control-panel.md shows *patterns* not step-by-step tutorial

**6. 50% Reduction is Achievable While Maintaining Completeness**
- **What happened**: genai-lite went from 21,201 → 10,397 words (51% cut)
- **Why it matters**: Proves the bloat was all fluff, not content
- **Solution**: Smart trimming (remove verbose prose, keep technical details)
- **For genai-electron**: Expect to cut ~50% from initial bloated state

### New Strategies for genai-electron

**1. Keep Ground Truth Files Unchanged During Phases 1-3**
- **Lesson from genai-lite**: Modifying README.md early led to confusion about source of truth
- **Solution**: Keep README.md and API.md completely unchanged until Phase 4
- **Why**: Prevents accidental information loss, allows comparison to verify completeness

**2. More Emphasis on Electron Integration Patterns**
- **Lesson from genai-lite**: Pure API libraries don't need integration guides
- **Solution**: Create dedicated integration-guide.md for Electron-specific patterns
- **Why**: genai-electron has unique Electron dependencies (userData paths, app lifecycle, IPC)

**3. Explicit Step-by-Step Verification Workflow**
- **Lesson from genai-lite**: "Verify against codebase" was too vague
- **Solution**: Concrete checklist with specific things to check (see Phase 2 above)
- **Why**: Prevents skipping the critical verification step

---

## Timeline Estimate

- **Phase 1**: 4-6 hours (structure + initial split)
- **Phase 2**: 6-8 hours (audit + trim)
- **Phase 3**: 2-3 hours (polish + verify)
- **Phase 4**: 1-2 hours (condense README, delete API.md)
- **Total**: 13-19 hours

---

## Quick Reference: Core Principles

**When splitting content (Phase 1):**
- ✅ Extract ALL content from README.md + API.md + app README
- ✅ Keep README.md and API.md unchanged (ground truth)
- ✅ Focus on completeness, not word count
- ❌ Don't trim yet, just split

**When verifying accuracy (Phase 2, Step 2 - CRITICAL):**
- ✅ Check `src/types/` for type definitions
- ✅ Check `src/managers/*.ts` for method signatures
- ✅ Grep `process.env` for environment variables
- ✅ Check `src/errors/` for error class names and codes
- ❌ Don't trust README.md alone (can be outdated)
- ❌ Don't skip codebase verification (prevents hallucinations)

**When trimming (Phase 2, Step 5):**
- ✅ Remove: Verbose intros, philosophical prose, obvious comments, "as we can see" filler
- ✅ Keep: Non-obvious edge cases, important caveats, config gotchas, technical details
- ✅ Ask: "Would a developer need to know this?" not "Is this interesting?"
- ❌ Don't over-trim technical details (that's not bloat)
- ❌ Don't link to README.md (docs must be self-contained)

**When checking if done (Phase 2, Step 6):**
- ✅ Total ≤ 21,000 words (max 25% expansion)
- ✅ Test: "Can I copy this folder to another project and use it?"
- ✅ Test: "Are all APIs verified against actual codebase?"
- ✅ Test: "Is every method documented with a working example?"

**Remember:**
- **Codebase is source of truth** for technical details (types, methods, env vars)
- **README/API are source of truth** for features and content completeness
- **Check BOTH** during verification
- **AI will bloat 2-3x** without aggressive trimming
- **50% reduction is achievable** while maintaining completeness

---

## Next Steps

1. Execute Phase 1 (create structure, extract content)
2. Execute Phase 2 (verify against codebase, trim intelligently)
3. Execute Phase 3 (polish, consistency, verify)
4. Execute Phase 4 (condense README.md, delete API.md, commit)
5. Move this PLAN.md to `/docs/dev` appropriately renamed with date prefix for future reference
