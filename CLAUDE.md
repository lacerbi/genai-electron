# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**genai-electron** is an Electron-specific library for managing local AI model servers (llama.cpp, stable-diffusion.cpp). It handles platform-specific operations like model downloads, binary management, server lifecycle, and resource orchestration. This library complements **genai-lite** (the API abstraction layer) by managing the runtime infrastructure.

**Current Status**: Phase 2.6 Complete (LLM + Image Generation + Async API). Production-ready with 273/273 tests passing.

## Essential Commands

```bash
# Build
npm run build                 # Compile TypeScript to dist/
npm run build:watch          # Watch mode for development

# Testing
npm test                     # Run all tests with Jest 30 (ESM mode)
npm run test:watch          # Watch mode for tests
npm run test:coverage       # Generate coverage report

# Code Quality
npm run lint                # Check with ESLint 9 (flat config)
npm run lint:fix            # Auto-fix linting issues
npm run format              # Format with Prettier
npm run format:check        # Check formatting only

# Clean
npm run clean               # Remove dist/ and coverage/
```

**Note**: All test commands use `NODE_OPTIONS=--experimental-vm-modules` for Jest ESM support.

## Architecture Overview

### Core Design Pattern: Singleton Managers

The library uses a **singleton pattern** for its three main managers, exposed as pre-instantiated exports:

```typescript
import { systemInfo, modelManager, llamaServer } from 'genai-electron';
```

Each manager is independent but can coordinate:
- **SystemInfo**: Hardware detection, capability assessment, config recommendations
- **ModelManager**: Model downloads, storage, metadata, checksums
- **LlamaServerManager**: Binary downloads, process spawning, health monitoring, lifecycle management
- **DiffusionServerManager**: Image generation server, HTTP wrapper for stable-diffusion.cpp (Phase 2)

### Module Organization

```
src/
├── managers/       # Core managers (ModelManager, LlamaServerManager, DiffusionServerManager,
│                   #   ResourceOrchestrator, GenerationRegistry, StorageManager, ServerManager)
├── system/         # Platform-specific hardware detection (SystemInfo, CPU, GPU, memory)
├── process/        # Process lifecycle (spawn, health checks, logs)
├── download/       # Download utilities (streaming, checksums, HuggingFace URLs)
├── config/         # Paths, defaults, binary versions
├── types/          # TypeScript definitions
├── errors/         # Custom error classes (all extend GenaiElectronError)
└── utils/          # Platform and file utilities (GGUF parser, generation-id, file-utils)
```

### Key Architectural Decisions

**1. Zero Runtime Dependencies**
- All functionality uses Node.js built-ins (fs, crypto, child_process, os, native fetch)
- Keeps package lightweight (~5-10MB code only, binaries downloaded on-demand)

**2. ESM-Only (type: "module")**
- All imports must use `.js` extensions (even for `.ts` files)
- Example: `import { foo } from './utils/file-utils.js';`
- This is TypeScript's Node16 module resolution requirement

**3. Per-App Storage (Phase 1)**
- Each Electron app has isolated model storage in its `userData` directory
- Phase 4+ will add configurable shared storage
- See `src/config/paths.ts` for directory structure

**4. Binary Download Strategy**
- llama-server and diffusion.cpp binaries are NOT bundled
- Downloaded on first `start()` call from GitHub releases
- Cached in `userData/binaries/` with version tracking
- Platform-specific downloads only (~50-100MB per platform)
- See `src/config/defaults.ts` for `BINARY_VERSIONS` configuration

**5. Event-Driven Server Lifecycle**
- LlamaServerManager extends EventEmitter
- Emits: 'started', 'stopped', 'crashed'
- Enables reactive UI updates in control panel apps

**6. genai-lite Integration Pattern** (Phase 2.6)
- genai-electron manages infrastructure: start/stop servers, health monitoring, resource orchestration
- genai-lite provides unified API: LLMService, ImageService with provider abstraction
- Example: `examples/electron-control-panel/` uses both (main/ for server management, renderer/ for UI)
- Communication: genai-electron → HTTP servers ← genai-lite

### Critical Implementation Details

**Electron Integration**
- The library depends on Electron's `app.getPath('userData')` for storage paths
- Must be initialized after Electron's 'ready' event
- See `src/config/paths.ts` for path management

**TypeScript Strict Mode**
- All code compiles under strict mode with zero errors
- Null safety is enforced - always check `optional?.properties`
- Use readonly arrays for recommendations: `readonly string[]`

**Health Checking Pattern**
- `llamaServer.start()` waits for health check before resolving
- Health endpoint: `http://localhost:{port}/health`
- Uses exponential backoff (see `src/process/health-check.ts`)
- Timeout configurable via `DEFAULT_TIMEOUTS.serverStart`

**Download Streaming**
- Uses native `fetch()` with `fs.createWriteStream()`
- Saves to `.partial` file during download
- Moves to final location on completion
- Supports progress callbacks for UI integration

**Error Hierarchy**
- All errors extend `GenaiElectronError` with `code` and `details` properties
- Specialized errors: ModelNotFoundError, DownloadError, InsufficientResourcesError, ServerError, PortInUseError, ChecksumError, BinaryError, FileSystemError
- Errors include actionable suggestions in details

**Key Exports** (Phase 2+)
- **Classes**: ResourceOrchestrator, GenerationRegistry, DiffusionServerManager, ServerManager
- **GGUF Utilities**: `fetchGGUFMetadata()`, `fetchLocalGGUFMetadata()`, `getArchField()` - Extract metadata from GGUF files
- **Reasoning Detection**: `detectReasoningSupport()`, `REASONING_MODEL_PATTERNS` - Identify reasoning-capable models
- **Generation ID**: `generateId()` - Used internally by async image generation API
- **Complete list**: See `src/index.ts` for all exported utilities, types, and classes

## Testing Approach

**Current Status** (Phase 2.6 Complete):
- Jest 30 + ts-jest with ESM experimental support
- 273/273 tests passing (100% pass rate)
- 13 test suites covering all Phase 1, 2, 2.5 functionality
- Clean test exit (no memory leaks, no warnings)
- Fast execution (~4 seconds for full suite)

**Test Coverage**:
- Phase 1: 138 tests (errors, utils, core managers)
- Phase 2: 50 tests (DiffusionServerManager, ResourceOrchestrator)
- Phase 2.5: 27 tests (GenerationRegistry, async API)
- Infrastructure: 58 tests (BinaryManager, health-check, validation cache)

**Test Structure**:
```
tests/
├── unit/              # Unit tests (all Phase 1 & 2 tests)
├── integration/       # Integration tests (future)
└── e2e/              # End-to-end tests (future)
```

**Running Specific Tests**:
```bash
npm test -- errors.test.ts           # Run specific file
npm test -- --testNamePattern="ModelNotFoundError"  # Run specific test
```

**Note**: See `docs/dev/ESM-TESTING-GUIDE.md` for ESM mocking patterns and best practices.

## Phase-Specific Context

**Phase 1 (Complete)**: LLM support
- SystemInfo, ModelManager, LlamaServerManager operational
- Binary management with variant testing (CUDA/Vulkan/CPU fallback)
- Documentation complete (README, genai-electron-docs/, SETUP.md)

**Phase 2 (Complete)**: Image generation & async API
- DiffusionServerManager (HTTP wrapper for stable-diffusion.cpp)
- ResourceOrchestrator (automatic LLM offload/reload when VRAM constrained)
- Cross-platform CI/CD with automated testing
- electron-control-panel example app available

**Phase 2.5 (Complete)**: Async image generation API
- GenerationRegistry (in-memory state with TTL cleanup)
- HTTP endpoints (POST for start, GET for polling)
- Batch generation support (1-5 images with auto-seed increment)
- Breaking change from synchronous to async polling pattern

**Future Phases**: See DESIGN.md for complete roadmap (Phase 3: Production Core, Phase 4: Production Polish)

## Important Files to Reference

- **DESIGN.md**: Complete architecture, all 5 phases, technical decisions
- **DESIGN-EXAMPLE-APP.md**: Detailed design for electron-control-panel example app
- **PROGRESS.md**: Current status (concise summary)
- **PLAN.md**: Documentation restructuring plan (Phases 1-4 complete)
- **docs/dev/phase1/**: Archived Phase 1 detailed planning and logs
- **docs/dev/phase2/PHASE2-PROGRESS.md**: Complete Phase 2 development history
- **docs/dev/ESM-TESTING-GUIDE.md**: ESM mocking patterns and testing best practices
- **genai-electron-docs/**: Self-contained documentation (11 modular files)
  - **index.md**: Documentation entry point with navigation
  - **installation-and-setup.md**: Setup, requirements, GPU drivers
  - **system-detection.md**: SystemInfo API and capabilities
  - **model-management.md**: ModelManager API and GGUF metadata
  - **llm-server.md**: LlamaServerManager API and binary management
  - **image-generation.md**: DiffusionServerManager API and async generation
  - **resource-orchestration.md**: ResourceOrchestrator for memory management
  - **integration-guide.md**: Electron patterns and error handling
  - **typescript-reference.md**: Complete type definitions (39 types)
  - **troubleshooting.md**: Common issues, error codes, FAQ
  - **example-control-panel.md**: Reference implementation patterns
- **docs/SETUP.md**: Development environment setup for all platforms
- **examples/electron-control-panel/**: Full integration example (Phase 2.6)
  - Uses genai-lite (LLMService + ImageService) + genai-electron (server management)
  - Structure: `main/` (server management), `renderer/` (UI components)

## Critical: Electron + ES Modules Gotcha

**IMPORTANT for Electron apps with `"type": "module"`:**

The electron-control-panel example uses `"type": "module"` in package.json, which tells Node.js to treat all `.js` files as ES modules. However, **Electron requires CommonJS for main and preload scripts**.

**Solution (already implemented in electron-control-panel):**
1. **Output `.cjs` extension** for main and preload builds
   - `vite.main.config.ts`: `fileName: () => 'main.cjs'`
   - `vite.preload.config.ts`: `fileName: () => 'preload.cjs'`
2. **Force CommonJS format** in rollupOptions:
   ```typescript
   rollupOptions: {
     output: { format: 'cjs' }
   }
   ```
3. **Update package.json**: `"main": ".vite/build/main.cjs"`
4. **Update preload path**: `join(__dirname, 'preload.cjs')`

**Why this matters:**
- Without `.cjs` extension, Node sees `.js` files as ES modules
- ES module main process can't properly load CommonJS preload scripts
- Results in "Unable to load preload script" or "exports is not defined" errors
- `window.api` will be undefined in renderer

This is documented in the electron-control-panel example for reference.

## Working with This Codebase

**Before Committing (CI Requirements)**:
1. **Run `npm run build`** - Must compile with 0 TypeScript errors
2. **Run `npm run lint`** - Must pass with 0 errors (warnings OK if intentional)
3. **Run `npm run format`** - Auto-format all files with Prettier
4. **Run `npm test`** - All tests must pass (273/273)
5. **Commit `package-lock.json`** - Never add lockfiles to .gitignore (needed for CI)

**Note**: CI will fail if any of these checks fail. Run them locally before pushing.

**When Adding New Features**:
1. Check if it's planned in DESIGN.md (phases 2-5)
2. Update PROGRESS.md with concise summary of changes
3. Follow singleton pattern for managers
4. Use Node.js built-ins (no new dependencies without discussion)
5. Ensure TypeScript strict mode compliance
6. Add JSDoc comments with examples

**When Adding New Managers**:
- Extend from ServerManager if it's a server lifecycle manager
- Implement singleton pattern via `private constructor` + `getInstance()`
- Add to `src/index.ts` exports (singleton instance + class)

**When Working with Binaries**:
- Update `BINARY_VERSIONS` in `src/config/defaults.ts`
- Include SHA256 checksums for all platforms
- Test download + verification logic
- Consider binary size impact on first-run experience

**When Modifying Tests**:
- ESM mocking is experimental in Jest 30 (use `unstable_mockModule`)
- Focus on integration tests over unit tests with complex mocking
- Prefer testing through public APIs rather than internal implementation

## Platform-Specific Considerations

**macOS**:
- Metal support is automatic (unified memory)
- Use `system_profiler SPDisplaysDataType` for GPU detection

**Windows**:
- NVIDIA detection via `nvidia-smi`
- Binary names use `.exe` extension

**Linux**:
- Multi-GPU support (NVIDIA via nvidia-smi, AMD via rocm-smi, Intel via /sys/class/drm)
- Most diverse platform - test thoroughly

## Related Projects

**genai-lite** (v0.5.1): Lightweight API abstraction layer for AI providers (cloud and local)
- genai-electron starts servers, genai-lite talks to those servers
- Clean separation: runtime management vs API abstraction
- Repository: https://github.com/lacerbi/genai-lite

## genai-lite Documentation Reference

**IMPORTANT**: When implementing features that integrate with genai-lite (LLMService, ImageService), **read the relevant documentation first** to ensure correct API usage.

**Documentation Location**: `.ath_materials/genai-lite-docs/` (v0.5.1 reference docs)

**Key Documentation Files**:
- **`index.md`** - Overview, installation, quick starts (LLM and image generation)
- **`llm-service.md`** - LLMService API for text generation and chat
- **`image-service.md`** - ImageService API for image generation (cloud and local)
- **`llamacpp-integration.md`** - llama.cpp setup, configuration, and advanced features
- **`core-concepts.md`** - API key management, presets, settings hierarchy, error handling
- **`prompting-utilities.md`** - Template engine, token counting, content parsing
- **`providers-and-models.md`** - Supported providers and model configurations
- **`typescript-reference.md`** - Type definitions and interfaces
- **`troubleshooting.md`** - Common issues and solutions
- **`example-chat-demo.md`** - Reference implementation for chat applications
- **`example-image-demo.md`** - Reference implementation for image generation

**When to Consult genai-lite Docs**:
- Implementing LLM chat features → Read `llm-service.md` and `llamacpp-integration.md`
- Implementing image generation → Read `image-service.md`
- Working with templates or prompts → Read `prompting-utilities.md`
- Debugging API integration → Read `core-concepts.md` and `troubleshooting.md`
- Understanding example app patterns → Read `example-chat-demo.md` or `example-image-demo.md`

**Integration Pattern** (Phase 2.6):
- genai-electron manages infrastructure: `llamaServer.start()`, `diffusionServer.start()`
- genai-lite provides unified API: `LLMService.sendMessage()`, `ImageService.generateImage()`
- See `examples/electron-control-panel/` for complete integration example
