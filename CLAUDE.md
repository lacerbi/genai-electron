# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**genai-electron** is an Electron-specific library for managing local AI model servers (llama.cpp, stable-diffusion.cpp). It handles platform-specific operations like model downloads, binary management, server lifecycle, and resource orchestration. This library complements **genai-lite** (the API abstraction layer) by managing the runtime infrastructure.

**Current Status**: Phase 1 MVP Complete (LLM support only). Phase 2 will add image generation via stable-diffusion.cpp.

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

### Module Organization

```
src/
├── managers/       # Core singleton managers (SystemInfo, ModelManager, LlamaServerManager, StorageManager)
├── system/         # Platform-specific hardware detection (CPU, GPU, memory)
├── process/        # Process lifecycle (spawn, health checks, logs)
├── download/       # Download utilities (streaming, checksums, HuggingFace URLs)
├── config/         # Paths, defaults, binary versions
├── types/          # TypeScript definitions
├── errors/         # Custom error classes (all extend GenaiElectronError)
└── utils/          # Platform and file utilities
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

## Testing Approach

**Current Status** (Phase 1):
- Jest 30 + ts-jest with ESM experimental support
- Error handling fully tested (14/14 passing, 100% coverage)
- Test templates created for all modules but deferred due to ESM mocking complexity
- Build system + TypeScript strict mode provides strong quality baseline

**Test Structure**:
```
tests/
├── unit/              # Unit tests (errors.test.ts fully implemented)
├── integration/       # Integration tests (future)
└── e2e/              # End-to-end tests (future)
```

**Running Specific Tests**:
```bash
npm test -- errors.test.ts           # Run specific file
npm test -- --testNamePattern="ModelNotFoundError"  # Run specific test
```

## Phase-Specific Context

**Phase 1 (Complete)**: LLM support only
- SystemInfo, ModelManager, LlamaServerManager operational
- Documentation complete (README, API.md, SETUP.md)
- Example app deferred to Phase 2+

**Phase 2 (Next)**: Image generation
- DiffusionServerManager (HTTP wrapper for stable-diffusion.cpp)
- Resource orchestration (automatic LLM offload/reload when VRAM constrained)
- electron-control-panel example app (demonstrates both LLM and image gen)

**Future Phases**: See DESIGN.md for complete roadmap

## Important Files to Reference

- **DESIGN.md**: Complete architecture, all 5 phases, technical decisions
- **DESIGN-EXAMPLE-APP.md**: Detailed design for electron-control-panel example app
- **PROGRESS.md**: Current status (concise summary)
- **docs/phase1/**: Archived Phase 1 detailed planning and logs
- **docs/API.md**: Complete API reference with examples
- **docs/SETUP.md**: Development environment setup for all platforms

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

**genai-lite**: Lightweight API abstraction layer for AI providers (cloud and local)
- genai-electron starts servers, genai-lite talks to those servers
- Clean separation: runtime management vs API abstraction
- Located at: (separate repository - see docs/GENAI-LITE-README.md for reference)
