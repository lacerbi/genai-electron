# ESM Testing Guide for genai-electron

**Last updated**: 2025-10-18

## Overview

This document explains the testing challenges we encountered with Jest and ES Modules (ESM), and the solutions we implemented across Phase 1 and Phase 2 of the project.

## The Problem: Jest + ESM + TypeScript

genai-electron uses:
- `"type": "module"` in package.json (ESM-only)
- TypeScript with Node16 module resolution
- Jest 30 with experimental VM modules support

This combination creates unique mocking challenges that differ from traditional CommonJS testing.

## Key Issues Encountered

### Issue 1: CommonJS `jest.mock()` Doesn't Work with ESM

**Problem**: Traditional `jest.mock()` doesn't work with ESM modules.

**Symptoms**:
```typescript
// ❌ WRONG - CommonJS pattern (doesn't work with ESM)
jest.mock('os', () => ({
  platform: jest.fn(),
  arch: jest.fn(),
}));
```

**Error**:
```
TypeError: os.platform.mockReturnValue is not a function
```

**Root cause**: In ESM, mocks must be set up using `jest.unstable_mockModule()` BEFORE importing the module.

### Issue 2: Mock Setup Order Matters

**Problem**: Imports are hoisted in ESM, so you must mock before importing.

**Symptoms**:
```typescript
// ❌ WRONG - Import happens before mock
import { getPlatform } from '../../src/utils/platform-utils.js';
jest.unstable_mockModule('node:os', ...); // Too late!
```

**Error**: Module is already loaded with real dependencies.

**Solution**: Mock first, then import with `await import()`:
```typescript
// ✅ CORRECT
jest.unstable_mockModule('node:os', () => ({...}));
const { getPlatform } = await import('../../src/utils/platform-utils.js');
```

### Issue 3: Default vs Named Exports

**Problem**: Must match the export style of the module being mocked.

**Example**: The `os` module uses default export:
```typescript
// Source file
import os from 'node:os'; // Default import
```

**Mocking**:
```typescript
// ❌ WRONG - Named exports
jest.unstable_mockModule('node:os', () => ({
  platform: mockPlatform,
  arch: mockArch,
}));

// ✅ CORRECT - Default export
jest.unstable_mockModule('node:os', () => ({
  default: {
    platform: mockPlatform,
    arch: mockArch,
  },
}));
```

### Issue 4: `node:` Prefix Required for Built-ins

**Problem**: Node.js built-in modules must use the `node:` prefix in mocks.

```typescript
// ❌ WRONG
jest.unstable_mockModule('os', ...);

// ✅ CORRECT
jest.unstable_mockModule('node:os', ...);
```

### Issue 5: Mocking `process` Global

**Problem**: `process` is a global object, not a module, so it can't be mocked with `jest.unstable_mockModule()`.

**Solution**: Use `Object.defineProperty()` to override globals:
```typescript
const originalPlatform = process.platform;

function mockProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

afterEach(() => {
  // Restore original
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  });
});
```

## Correct ESM Testing Patterns

### Pattern 1: Mocking Node.js Built-in Modules (Default Export)

**Use case**: Mocking `os`, `fs`, `crypto`, etc.

```typescript
import { jest } from '@jest/globals';

// 1. Create mock functions
const mockPlatform = jest.fn();
const mockArch = jest.fn();

// 2. Mock the module BEFORE importing anything
jest.unstable_mockModule('node:os', () => ({
  default: {
    platform: mockPlatform,
    arch: mockArch,
  },
}));

// 3. Import after mocking
const { getPlatform } = await import('../../src/utils/platform-utils.js');

// 4. Use in tests
describe('getPlatform()', () => {
  it('should return darwin for macOS', () => {
    mockPlatform.mockReturnValue('darwin');
    expect(getPlatform()).toBe('darwin');
  });
});
```

### Pattern 2: Mocking Node.js Built-in Modules (Named Exports)

**Use case**: Mocking `fs/promises`, `child_process`, etc.

```typescript
import { jest } from '@jest/globals';

// 1. Create mock functions
const mockMkdir = jest.fn();
const mockAccess = jest.fn();

// 2. Mock the module with named exports
jest.unstable_mockModule('node:fs/promises', () => ({
  mkdir: mockMkdir,
  access: mockAccess,
  constants: { F_OK: 0 },
}));

// 3. Import after mocking
const { ensureDirectory } = await import('../../src/utils/file-utils.js');

// 4. Use in tests
describe('ensureDirectory()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create directory', async () => {
    mockMkdir.mockResolvedValue(undefined);
    await ensureDirectory('/test/path');
    expect(mockMkdir).toHaveBeenCalledWith('/test/path', { recursive: true });
  });
});
```

### Pattern 3: Mocking Custom Classes

**Use case**: Mocking manager classes like `LogManager`, `BinaryManager`.

```typescript
import { jest } from '@jest/globals';

// 1. Create mock class
class MockLogManager {
  write = jest.fn().mockResolvedValue(undefined);
  getRecent = jest.fn().mockResolvedValue('');
  clear = jest.fn().mockResolvedValue(undefined);
}

// 2. Mock the module
jest.unstable_mockModule('../../src/process/log-manager.js', () => ({
  LogManager: MockLogManager,
}));

// 3. Import after mocking
const { DiffusionServerManager } = await import('../../src/managers/DiffusionServerManager.js');

// 4. Get mock instance to verify calls
let mockLogInstance: MockLogManager;

beforeEach(() => {
  mockLogInstance = new MockLogManager();
});

it('should write logs', async () => {
  await someOperation();
  expect(mockLogInstance.write).toHaveBeenCalled();
});
```

### Pattern 4: Mocking EventEmitter-Based Classes

**Use case**: Mocking `ProcessManager` which extends EventEmitter.

```typescript
import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

class MockProcessManager extends EventEmitter {
  spawn = jest.fn();
  kill = jest.fn();
  isRunning = jest.fn();
}

jest.unstable_mockModule('../../src/process/ProcessManager.js', () => ({
  ProcessManager: MockProcessManager,
}));

const { DiffusionServerManager } = await import('../../src/managers/DiffusionServerManager.js');

it('should handle process events', async () => {
  const mockProcess = new EventEmitter() as any;
  mockProcess.pid = 12345;
  mockProcess.stdout = new EventEmitter();
  mockProcess.stderr = new EventEmitter();

  const mockPm = new MockProcessManager();
  mockPm.spawn.mockReturnValue(mockProcess);

  // Simulate events
  mockProcess.stdout.emit('data', Buffer.from('step 1/10'));

  // Verify handling
  // ...
});
```

## File Organization

### Correct File Structure
```
tests/unit/MyModule.test.ts

1. Imports from '@jest/globals'
2. Mock setup (jest.unstable_mockModule calls)
3. Imports from source (await import(...))
4. Test suites (describe blocks)
```

### Example Template
```typescript
/**
 * Unit tests for MyModule
 */

// Step 1: Import Jest utilities
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Step 2: Create mock functions
const mockFoo = jest.fn();
const mockBar = jest.fn();

// Step 3: Mock modules BEFORE importing source
jest.unstable_mockModule('node:some-module', () => ({
  foo: mockFoo,
  bar: mockBar,
}));

// Step 4: Import source code AFTER mocking
const { myFunction } = await import('../../src/MyModule.js');

// Step 5: Write tests
describe('MyModule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('myFunction()', () => {
    it('should work correctly', () => {
      mockFoo.mockReturnValue('test');
      expect(myFunction()).toBe('test');
    });
  });
});
```

## Common Pitfalls and Solutions

### Pitfall 1: Forgetting `.js` Extension

**Problem**: TypeScript requires `.js` extensions in imports even for `.ts` files.

```typescript
// ❌ WRONG
import { foo } from '../../src/utils/file-utils';

// ✅ CORRECT
import { foo } from '../../src/utils/file-utils.js';
```

### Pitfall 2: Not Clearing Mocks Between Tests

**Problem**: Mock state leaks between tests.

**Solution**: Always clear mocks in `beforeEach()`:
```typescript
beforeEach(() => {
  jest.clearAllMocks();
});
```

### Pitfall 3: Mixing Async and Sync Operations

**Problem**: Forgetting `await` on async mock operations.

```typescript
// ❌ WRONG
mockFetch.mockResolvedValue(data);
const result = myFunction(); // Returns Promise!

// ✅ CORRECT
mockFetch.mockResolvedValue(data);
const result = await myFunction();
```

### Pitfall 4: Not Matching Implementation Return Types

**Problem**: Test expectations don't match actual implementation.

**Example from file-utils.test.ts**:
```typescript
// Implementation
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes'; // Not '0 B'
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${sizes[i]}`;
  // parseFloat removes trailing zeros: '1.00 KB' becomes '1 KB'
}

// ❌ WRONG expectation
expect(formatBytes(1024)).toBe('1.00 KB');

// ✅ CORRECT expectation
expect(formatBytes(1024)).toBe('1 KB');
```

## Testing Status by Module

### Phase 1 (LLM Support)
| Module | Status | Tests | Pattern |
|--------|--------|-------|---------|
| errors.test.ts | ✅ Passing | 14/14 | No mocking needed |
| platform-utils.test.ts | ✅ Passing | 19/19 | Global mocking (process) |
| file-utils.test.ts | ✅ Passing | 12/12 | ESM mocking (fs/promises) |
| SystemInfo.test.ts | ✅ Complete | - | ESM mocking (os, child_process) |
| ModelManager.test.ts | ✅ Complete | - | ESM mocking (StorageManager, Downloader) |
| LlamaServerManager.test.ts | ✅ Complete | - | ESM mocking (ProcessManager, health-check) |
| StorageManager.test.ts | ✅ Complete | - | ESM mocking (fs/promises) |
| Downloader.test.ts | ⚠️ Has issues | 2/10 | ESM mocking (fetch, fs) |

### Phase 2 (Image Generation)
| Module | Status | Tests | Pattern |
|--------|--------|-------|---------|
| ResourceOrchestrator.test.ts | ✅ Passing | 17/17 | Class mocking |
| DiffusionServerManager.test.ts | ✅ Passing | 33/33 | Class + EventEmitter mocking |

## Running Tests

### Run all tests
```bash
npm test
```

### Run specific test file
```bash
npm test -- platform-utils.test.ts
```

### Run tests in watch mode
```bash
npm run test:watch
```

### Run with coverage
```bash
npm run test:coverage
```

## Known Limitations

### 1. `jest.unstable_mockModule` is Experimental
- API may change in future Jest versions
- Current Jest version: 30.x
- Status: Experimental VM modules support

### 2. Global Mocking is Limited
- Globals like `process`, `console` require `Object.defineProperty()`
- Cannot use `jest.unstable_mockModule()` for globals

### 3. Mock Complexity
- Complex class hierarchies with EventEmitter require careful setup
- Must wire up event handlers correctly in mock objects

## Migration Checklist

If you find old CommonJS-style tests, migrate them using this checklist:

- [ ] Remove `jest.mock()` calls
- [ ] Add `jest.unstable_mockModule()` calls BEFORE imports
- [ ] Convert regular imports to `await import()`
- [ ] Update module paths to use `node:` prefix for built-ins
- [ ] Verify default vs named export matching
- [ ] Add `jest.clearAllMocks()` to `beforeEach()`
- [ ] Fix expectations to match actual implementation
- [ ] Run tests and verify they pass

## Additional Resources

- [Jest ESM Support](https://jestjs.io/docs/ecmascript-modules)
- [TypeScript Node16 Module Resolution](https://www.typescriptlang.org/docs/handbook/esm-node.html)
- [Node.js ES Modules](https://nodejs.org/api/esm.html)

## Conclusion

ESM testing in Jest requires a different mindset than CommonJS testing:
1. **Mock first, import later** - Always use `jest.unstable_mockModule()` before `await import()`
2. **Match export style** - Use `default:` for default exports, direct properties for named exports
3. **Use `node:` prefix** - Required for built-in Node.js modules
4. **Clear mocks** - Always use `beforeEach(() => jest.clearAllMocks())`
5. **Test implementation** - Verify expectations match actual code behavior

Following these patterns ensures tests are maintainable, reliable, and work correctly with the ESM module system.
