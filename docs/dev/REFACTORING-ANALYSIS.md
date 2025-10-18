# Refactoring Analysis: LlamaServerManager vs DiffusionServerManager

**Date**: 2025-10-18
**Status**: Phase 1 complete, recommendations for Phase 2+

## Executive Summary

Found and eliminated ~121 lines of code duplication (30-40%) between `LlamaServerManager` and `DiffusionServerManager`. High-priority refactoring complete with all tests passing. Medium-priority opportunities documented for future consideration (Phase 3+).

---

## Original Analysis

### Code Duplication Discovered

**File Sizes (Before Refactoring):**
- `LlamaServerManager.ts`: 583 lines
- `DiffusionServerManager.ts`: 649 lines
- `ServerManager.ts`: 239 lines
- **Total**: 1,471 lines

**Duplication Assessment:**
- ~200-250 lines duplicated across both managers
- Approximately 30-40% code duplication
- Both extend `ServerManager` but didn't leverage base class enough

### Specific Duplication Patterns Found

#### 1. Identical Methods (100% duplicate)
- `getLogs(lines: number)` - 14 lines × 2 = 28 lines
- `clearLogs()` - 12 lines × 2 = 24 lines
- Property: `logManager?: LogManager` - duplicated

**Total**: ~52 lines of exact duplication

#### 2. Port Checking Logic (100% duplicate)
```typescript
// Both files had identical code:
const { isServerResponding } = await import('../process/health-check.js');
if (await isServerResponding(port, 2000)) {
  throw new PortInUseError(port);
}
```
**Lines**: 4 lines × 2 = 8 lines

#### 3. Log Initialization (95% duplicate)
```typescript
// LlamaServerManager:
const logPath = path.join(PATHS.logs, 'llama-server.log');
this.logManager = new LogManager(logPath);
await this.logManager.initialize();
await this.logManager.write(`Starting llama-server on port ${port}`, 'info');

// DiffusionServerManager: (identical except log file name and message)
const logPath = path.join(PATHS.logs, 'diffusion-server.log');
this.logManager = new LogManager(logPath);
await this.logManager.initialize();
await this.logManager.write(`Starting diffusion server on port ${port}`, 'info');
```
**Lines**: 4 lines × 2 = 8 lines (95% similar)

#### 4. Error Handling in start() (90% duplicate)
```typescript
// Both files had nearly identical error handling:
} catch (error) {
  this.setStatus('stopped');
  // Cleanup logic (slightly different between files)

  if (this.logManager) {
    await this.logManager.write(
      `Failed to start: ${error instanceof Error ? error.message : String(error)}`,
      'error'
    );
  }

  // Re-throw typed errors (IDENTICAL)
  if (
    error instanceof ModelNotFoundError ||
    error instanceof PortInUseError ||
    error instanceof BinaryError ||
    error instanceof InsufficientResourcesError ||
    error instanceof ServerError
  ) {
    throw error;
  }

  // Wrap unknown errors (IDENTICAL pattern, different message)
  throw new ServerError(
    `Failed to start llama-server: ${error instanceof Error ? error.message : 'Unknown error'}`,
    { error: error instanceof Error ? error.message : String(error) }
  );
}
```
**Lines**: ~25 lines × 2 = 50 lines (90% similar)

#### 5. Constructor Pattern (100% duplicate)
```typescript
constructor(
  modelManager: ModelManager = ModelManager.getInstance(),
  systemInfo: SystemInfo = SystemInfo.getInstance()
) {
  super();
  this.processManager = new ProcessManager();
  this.modelManager = modelManager;
  this.systemInfo = systemInfo;
}
```
**Lines**: 9 lines × 2 = 18 lines

---

## Completed Refactoring (High Priority)

### Changes Made

**1. Moved to ServerManager base class:**
- `getLogs()` method
- `clearLogs()` method
- `logManager?: LogManager` property

**2. Created protected helper methods in ServerManager:**

```typescript
// Check if port is available
protected async checkPortAvailability(port: number, timeout: number = 2000): Promise<void>

// Initialize log manager with server-specific log file
protected async initializeLogManager(logFileName: string, port: number): Promise<void>

// Handle startup errors with consistent logging and error re-throwing
protected async handleStartupError(error: unknown, serverName: string): Promise<never>
```

**3. Updated both managers to use shared helpers:**
- Removed duplicate `getLogs()`/`clearLogs()` methods
- Removed duplicate `logManager` property
- Replaced inline port checking with `this.checkPortAvailability(port)`
- Replaced log initialization code with `this.initializeLogManager('server.log', port)`
- Replaced error handling code with `this.handleStartupError(error, 'server-name')`

### Results

**File Sizes (After Refactoring):**
- `LlamaServerManager.ts`: 519 lines (-64, -11%)
- `DiffusionServerManager.ts`: 592 lines (-57, -8.8%)
- `ServerManager.ts`: 352 lines (+113)
- **Total**: 1,463 lines (-8 lines overall)

**Lines of Duplication Eliminated**: ~121 lines

**Key Win**: Changes to logging, port checking, and error handling now only need to be made in ONE place instead of TWO.

### Test Results

✅ **All tests passing after refactoring:**
- Phase 1 tests: 45/45 passing
- Phase 2 tests: 50/50 passing
- **Total**: 95/95 tests passing

**Test changes required:**
- Updated `DiffusionServerManager.test.ts` to expect new log message format: `"Starting server on port"` instead of `"Starting diffusion server"`

### Commits

- `c4ad0ed` - refactor: eliminate code duplication between LlamaServerManager and DiffusionServerManager
- `70057f9` - docs: document code deduplication refactoring in PROGRESS.md

---

## Future Refactoring Opportunities (Medium Priority)

### Opportunity 1: Template Method Pattern for start()

**Effort**: ~3-4 hours
**Impact**: High - Could eliminate another 100-150 lines
**Risk**: Medium - Requires careful testing, adds abstraction

#### Current Duplication in start()

Both `start()` methods follow nearly identical workflows:

```typescript
async start(config: ServerConfig): Promise<ServerInfo> {
  // 1. Check if already running (IDENTICAL)
  if (this._status === 'running') {
    throw new ServerError('Server is already running', {
      suggestion: 'Stop the server first with stop()',
    });
  }

  this.setStatus('starting');
  this._config = config;

  try {
    // 2. Validate model exists (IDENTICAL)
    const modelInfo = await this.modelManager.getModelInfo(config.modelId);

    // 3. Check if system can run this model (IDENTICAL)
    const canRun = await this.systemInfo.canRunModel(modelInfo);
    if (!canRun.possible) {
      throw new InsufficientResourcesError(/* ... */);
    }

    // 4. Ensure binary is downloaded (90% SIMILAR)
    this.binaryPath = await this.ensureBinary();

    // 5. Check port availability (NOW SHARED ✅)
    await this.checkPortAvailability(port);

    // 6. Initialize logging (NOW SHARED ✅)
    await this.initializeLogManager('server.log', port);

    // 7-10. Server-specific logic (DIFFERENT)
    // ...

  } catch (error) {
    // Cleanup and error handling (NOW SHARED ✅)
    await this.handleStartupError(error, 'server-name');
  }
}
```

#### Proposed Refactoring

**Create protected template method in ServerManager:**

```typescript
protected async validateAndPrepareServer(
  config: ServerConfig,
  modelTypeFilter?: 'llm' | 'diffusion'
): Promise<{ modelInfo: ModelInfo; port: number }> {
  // Check if already running
  if (this._status === 'running') {
    throw new ServerError('Server is already running', {
      suggestion: 'Stop the server first with stop()',
    });
  }

  this.setStatus('starting');
  this._config = config;

  // Validate model exists
  const modelInfo = await this.modelManager.getModelInfo(config.modelId);

  // Optional: Check model type
  if (modelTypeFilter && modelInfo.type !== modelTypeFilter) {
    throw new ModelNotFoundError(
      `Model ${config.modelId} is not a ${modelTypeFilter} model (type: ${modelInfo.type})`
    );
  }

  // Check if system can run this model
  const canRun = await this.systemInfo.canRunModel(modelInfo);
  if (!canRun.possible) {
    throw new InsufficientResourcesError(
      `System cannot run model: ${canRun.reason || 'Insufficient resources'}`,
      {
        required: `Model size: ${Math.round(modelInfo.size / 1024 / 1024 / 1024)}GB`,
        available: `Available RAM: ${Math.round(
          (await this.systemInfo.getMemoryInfo()).available / 1024 / 1024 / 1024
        )}GB`,
        suggestion: canRun.suggestion || canRun.reason || 'Try a smaller model',
      }
    );
  }

  return { modelInfo, port: config.port || this.getDefaultPort() };
}

// Subclasses must provide default port
protected abstract getDefaultPort(): number;
```

**Then subclasses become much simpler:**

```typescript
// LlamaServerManager
async start(config: ServerConfig): Promise<ServerInfo> {
  try {
    const { modelInfo, port } = await this.validateAndPrepareServer(config);

    // Download binary
    this.binaryPath = await this.ensureBinary();
    await this.checkPortAvailability(port);
    await this.initializeLogManager('llama-server.log', port);

    // Server-specific logic only
    const finalConfig = await this.autoConfigureIfNeeded(config, modelInfo);
    const args = this.buildCommandLineArgs(finalConfig, modelInfo);
    this.processManager.spawn(this.binaryPath, args, /* ... */);
    await waitForHealthy(port, DEFAULT_TIMEOUTS.serverStart);

    this._startedAt = new Date();
    this.setStatus('running');
    this.emitEvent('started', this.getInfo());
    return this.getInfo();
  } catch (error) {
    // Cleanup
    this.setStatus('stopped');
    if (this._pid && this.processManager.isRunning(this._pid)) {
      await this.processManager.kill(this._pid, 5000);
    }
    await this.handleStartupError(error, 'llama-server');
  }
}

protected getDefaultPort(): number {
  return DEFAULT_PORTS.llama;
}
```

**Estimated savings**: ~50-70 lines per manager = 100-140 lines total

#### Pros and Cons

**Pros:**
- ✅ Eliminates significant duplication
- ✅ Single source of truth for validation logic
- ✅ Easier to add new server types
- ✅ Bugs fixed once benefit all servers

**Cons:**
- ❌ Adds abstraction (harder to follow for new developers)
- ❌ Template method can be harder to debug
- ❌ Requires careful testing to ensure no regressions
- ❌ May be premature - only 2 server types currently

### Opportunity 2: Abstract ensureBinary() Pattern

**Effort**: ~1-2 hours
**Impact**: Medium - Could clean up ~20-30 lines
**Risk**: Low

#### Current Duplication

```typescript
// LlamaServerManager
private async ensureBinary(): Promise<string> {
  const platformKey = getPlatformKey();
  const binaryConfig = BINARY_VERSIONS.llamaServer; // ONLY DIFFERENCE
  const variants = binaryConfig.variants[platformKey];

  const binaryManager = new BinaryManager({
    type: 'llama',  // ONLY DIFFERENCE
    binaryName: 'llama-server',  // ONLY DIFFERENCE
    platformKey,
    variants: variants || [],
    log: this.logManager ? (message, level = 'info') => {
      this.logManager?.write(message, level).catch(() => {});
    } : undefined,
  });

  return await binaryManager.ensureBinary();
}

// DiffusionServerManager - nearly identical, different config values
```

#### Proposed Refactoring

**Option A: Make it abstract in ServerManager**

```typescript
// ServerManager base class
protected async ensureBinaryHelper(
  type: 'llama' | 'diffusion',
  binaryName: string,
  binaryConfig: BinaryConfig
): Promise<string> {
  const platformKey = getPlatformKey();
  const variants = binaryConfig.variants[platformKey];

  const binaryManager = new BinaryManager({
    type,
    binaryName,
    platformKey,
    variants: variants || [],
    log: this.logManager
      ? (message, level = 'info') => {
          this.logManager?.write(message, level).catch(() => {});
        }
      : undefined,
  });

  return await binaryManager.ensureBinary();
}
```

**Then subclasses:**

```typescript
// LlamaServerManager
private async ensureBinary(): Promise<string> {
  return this.ensureBinaryHelper('llama', 'llama-server', BINARY_VERSIONS.llamaServer);
}

// DiffusionServerManager
private async ensureBinary(): Promise<string> {
  return this.ensureBinaryHelper('diffusion', 'stable-diffusion', BINARY_VERSIONS.diffusionCpp);
}
```

**Estimated savings**: ~10-15 lines per manager = 20-30 lines total

---

## Recommendations

### When to Pursue Remaining Refactoring

**Recommended timing: Phase 3+**

Consider implementing template method pattern when:

1. **Adding a third server type**
   - The pattern really pays off with 3+ implementations
   - Rule of three: don't abstract until you have 3 examples

2. **Encountering bugs that affect both managers**
   - If validation logic needs fixing in both places
   - Shows need for single source of truth

3. **Major architectural changes**
   - If planning to restructure server lifecycle
   - Good time to consolidate

4. **Team has bandwidth for larger refactoring**
   - Not during critical feature development
   - When quality/tech debt is the priority

### Why Current State is Good Enough

**Already achieved major wins:**
- ✅ Eliminated ~121 lines of 100% duplicate code
- ✅ All infrastructure shared (logging, ports, errors)
- ✅ Managers are 10% smaller
- ✅ Key maintainability improvements achieved
- ✅ All tests passing

**Remaining duplication is acceptable:**
- Only 2 server types currently (pattern not yet proven necessary)
- Duplication is in higher-level logic (easier to keep in sync)
- Current code is simple and easy to follow
- Risk of over-engineering outweighs benefits

### Trade-offs: Simplicity vs DRY

**Current approach favors simplicity:**
- Easy to understand each manager independently
- Clear what each manager does without jumping to base class
- Less abstraction = easier for new contributors
- Duplication in business logic is more acceptable than infrastructure

**Future approach would favor DRY:**
- Single source of truth for all validation
- Easier to add new server types
- More consistent behavior across managers
- But: harder to follow, more abstract

---

## Conclusion

The high-priority refactoring successfully eliminated the most egregious code duplication (100% duplicate infrastructure code) while keeping the codebase simple and maintainable.

The remaining opportunities are documented here for future consideration, with clear guidance on when and why to pursue them. The current state strikes a good balance between DRY principles and code simplicity.

**Next Steps:**
1. Monitor for bugs that affect both managers (indicates need for shared validation)
2. Revisit this analysis in Phase 3+ when adding new server types
3. Consider template method pattern if duplication becomes a maintenance burden

---

## References

- Commits: `c4ad0ed`, `70057f9`
- Related files:
  - `src/managers/ServerManager.ts` (base class)
  - `src/managers/LlamaServerManager.ts`
  - `src/managers/DiffusionServerManager.ts`
- Tests: `tests/unit/LlamaServerManager.test.ts`, `tests/unit/DiffusionServerManager.test.ts`
- Progress: `PROGRESS.md` (lines 82-102)
