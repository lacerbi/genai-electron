# genai-electron Development Setup

> **Version**: 0.3.0 (Phase 2.6 Complete)
> **Last Updated**: 2025-10-23

Complete guide for setting up the genai-electron development environment.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start](#quick-start)
3. [Development Workflow](#development-workflow)
4. [Platform-Specific Setup](#platform-specific-setup)
5. [Testing](#testing)
6. [Code Quality](#code-quality)
7. [Troubleshooting](#troubleshooting)
8. [Contributing](#contributing)

---

## Prerequisites

### Required Software

#### Node.js 22.x LTS

genai-electron requires Node.js 22.x for native `fetch()` support and modern features.

**Installation**:

**macOS** (via Homebrew):
```bash
brew install node@22
```

**Windows** (via official installer):
- Download from [nodejs.org](https://nodejs.org/)
- Choose the "22.x LTS" version
- Run the installer

**Linux** (via NodeSource):
```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Fedora
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs
```

**Verify Installation**:
```bash
node --version  # Should show v22.x.x
npm --version   # Should show 10.x.x or higher
```

**Note**: Electron 25+ is a peer dependency. It's included in the example app (`examples/electron-control-panel`), so no global installation needed for development.

### Platform-Specific Requirements

Different platforms require additional build tools for native modules:

#### macOS

**Xcode Command Line Tools** (required for native compilation):

```bash
xcode-select --install
```

**Verify**:
```bash
xcode-select -p
# Should output: /Library/Developer/CommandLineTools
```

#### Windows

**Visual Studio Build Tools** (required for native compilation):

1. Download [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
2. Install with these workloads:
   - Desktop development with C++
   - MSVC v143 or later
   - Windows 10/11 SDK

**Alternative (automated)**:
```bash
npm install --global windows-build-tools
```

**Verify**:
```bash
npm config get msvs_version
# Should show 2022 or 2019
```

#### Linux

**Build Essential** (Ubuntu/Debian):
```bash
sudo apt-get update
sudo apt-get install -y build-essential
```

**Development Tools** (Fedora):
```bash
sudo dnf groupinstall "Development Tools"
```

**Verify**:
```bash
gcc --version
make --version
```

---

## Quick Start

### 1. Clone Repository

```bash
git clone https://github.com/yourusername/genai-electron.git
cd genai-electron
```

### 2. Install Dependencies

```bash
npm install
```

This installs:
- Development dependencies (TypeScript, Jest, ESLint, Prettier)
- No runtime dependencies (uses Node.js built-ins)

### 3. Build

```bash
npm run build
```

This:
- Compiles TypeScript to JavaScript (`dist/`)
- Generates type definitions (`.d.ts` files)
- Creates source maps for debugging

**Output**:
```
dist/
├── config/
├── download/
├── errors/
├── managers/
├── process/
├── system/
├── types/
├── utils/
├── index.js
├── index.d.ts
└── *.js.map (source maps)
```

### 4. Run Tests

```bash
npm test
```

**Current Status**: Phase 2.6 complete with 320 tests across 16 suites, 100% pass rate. All core functionality is fully tested.

### 5. Verify Everything Works

```bash
# Build
npm run build

# Lint
npm run lint

# Format check
npm run format:check

# Test
npm test
```

All commands should complete successfully with no errors.

---

## Development Workflow

### File Structure

```
genai-electron/
├── src/                      # Source code (TypeScript)
│   ├── config/               # Configuration and defaults
│   ├── download/             # Download utilities
│   ├── errors/               # Custom error classes
│   ├── managers/             # Core managers (Model, Server, Storage)
│   ├── process/              # Process management
│   ├── system/               # System capability detection
│   ├── types/                # TypeScript type definitions
│   ├── utils/                # Utility functions
│   └── index.ts              # Main entry point
├── tests/                    # Test files
│   ├── unit/                 # Unit tests
│   ├── integration/          # Integration tests (future)
│   └── e2e/                  # End-to-end tests (future)
├── docs/                     # Documentation
├── examples/                 # Example applications (future)
├── dist/                     # Compiled output (gitignored)
└── coverage/                 # Test coverage (gitignored)
```

### Development Commands

#### Build

```bash
# Full build
npm run build

# Watch mode (rebuild on file changes)
npm run build -- --watch
```

#### Testing

```bash
# Run all tests
npm test

# Watch mode (rerun on file changes)
npm run test:watch

# Generate coverage report
npm run test:coverage

# View coverage in browser
open coverage/lcov-report/index.html  # macOS
start coverage/lcov-report/index.html # Windows
xdg-open coverage/lcov-report/index.html # Linux
```

#### Code Quality

```bash
# Run ESLint
npm run lint

# Fix linting issues automatically
npm run lint:fix

# Run Prettier (check only)
npm run format:check

# Format all files
npm run format
```

#### Recommended Workflow

```bash
# 1. Start watch mode for TypeScript compilation
npm run build -- --watch

# In another terminal:
# 2. Start test watch mode
npm run test:watch

# Make changes to src/ files
# - Build automatically recompiles
# - Tests automatically rerun
```

---

## Testing

### Test Structure

**Current Status**: 320 tests across 16 suites, 100% pass rate, ~80% coverage

```
tests/
├── unit/                           # Unit tests for all modules
│   ├── errors.test.ts              # ✅ Error classes (14 tests)
│   ├── SystemInfo.test.ts          # ✅ System detection (18 tests)
│   ├── ModelManager.test.ts        # ✅ Model management (42 tests)
│   ├── LlamaServerManager.test.ts  # ✅ LLM server (38 tests)
│   ├── DiffusionServerManager.test.ts  # ✅ Image gen server (25 tests)
│   ├── ResourceOrchestrator.test.ts    # ✅ Resource management (25 tests)
│   ├── GenerationRegistry.test.ts  # ✅ Async image gen (27 tests)
│   ├── structured-logs.test.ts     # ✅ Log parsing (14 tests)
│   ├── electron-lifecycle.test.ts  # ✅ Lifecycle helpers (11 tests)
│   ├── error-helpers.test.ts       # ✅ Error formatting (22 tests)
│   ├── validation-cache.test.ts    # ✅ Binary validation (16 tests)
│   └── ... (16 suites total)
├── integration/                    # Integration tests (future)
└── e2e/                           # End-to-end tests (future)
```

**ESM Testing**: Full ESM support with Jest 30. See `docs/dev/ESM-TESTING-GUIDE.md` for patterns.

### Running Tests

```bash
# All tests
npm test

# Specific test file
npm test -- errors.test.ts

# With coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### Writing Tests

**Example Unit Test**:
```typescript
import { describe, it, expect } from '@jest/globals';
import { ModelNotFoundError } from '../../src/errors/index.js';

describe('ModelNotFoundError', () => {
  it('should create error with correct properties', () => {
    const error = new ModelNotFoundError('test-model');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ModelNotFoundError);
    expect(error.message).toContain('test-model');
    expect(error.code).toBe('MODEL_NOT_FOUND');
    expect(error.name).toBe('ModelNotFoundError');
  });
});
```

### Test Coverage

- **Current**: ~80% coverage across all modules (Phase 2.6 complete)
- **Goal**: 85%+ for Phase 3 (production polish)

All core functionality is tested: errors, managers, utilities, server lifecycle, resource orchestration, and async APIs.

---

## Code Quality

### ESLint Configuration

The project uses ESLint 9 with flat config (`eslint.config.mjs`):

```javascript
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  // Custom rules...
];
```

**Run Linter**:
```bash
npm run lint        # Check for issues
npm run lint:fix    # Auto-fix issues
```

**Common Issues**:
- Unused variables/imports
- Missing type annotations
- Unsafe type assertions
- Missing null checks

### Prettier Configuration

Code formatting is enforced with Prettier (`.prettierrc`):

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100,
  "arrowParens": "always"
}
```

**Format Code**:
```bash
npm run format              # Format all files
npm run format:check        # Check formatting only
```

**IDE Integration**:
- VS Code: Install "Prettier - Code formatter" extension
- Enable "Format on Save" in settings

### TypeScript Configuration

Strict mode is enabled (`tsconfig.json`):

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "node16",
    // ... other strict checks
  }
}
```

This catches:
- Implicit `any` types
- Null/undefined errors
- Unused locals
- Type safety violations

---

## Troubleshooting

### Build Issues

#### "Cannot find module 'electron'"

**Cause**: Electron is a peer dependency, not installed by default.

**Fix**:
```bash
npm install electron@>=25.0.0
```

Or for development:
```bash
npm install --save-dev electron@latest
```

#### "Module not found" after adding new file

**Cause**: ESM requires `.js` extensions in imports.

**Fix**:
```typescript
// ❌ Wrong
import { foo } from './utils/file';

// ✅ Correct
import { foo } from './utils/file.js';
```

#### TypeScript compilation errors

**Common Issues**:

1. **Strict null checks**:
```typescript
// ❌ Wrong
const value = maybeUndefined.property;

// ✅ Correct
const value = maybeUndefined?.property;
```

2. **Implicit any**:
```typescript
// ❌ Wrong
function process(data) { ... }

// ✅ Correct
function process(data: DataType) { ... }
```

### Test Issues

#### Test timeouts

**Cause**: Async operations taking too long.

**Fix**:
```typescript
it('should complete operation', async () => {
  // Increase timeout for this test
  jest.setTimeout(10000);
  await longRunningOperation();
}, 10000); // Or set timeout here
```

### Runtime Issues

#### "ENOENT: no such file or directory"

**Cause**: Path issues in Electron (userData not initialized).

**Fix**:
```typescript
// Ensure directories exist before use
import { ensureDirectories } from 'genai-electron';
await ensureDirectories();
```

#### "Port already in use"

**Cause**: Another process is using the port.

**Fix**:
```bash
# Find process using port 8080
# macOS/Linux:
lsof -ti:8080

# Windows:
netstat -ano | findstr :8080

# Kill process (use PID from above)
kill -9 <PID>       # macOS/Linux
taskkill /PID <PID> /F  # Windows
```

Or use a different port:
```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8081  // Use alternative port
});
```

### Platform-Specific Issues

#### macOS: "xcrun: error: invalid active developer path"

**Cause**: Xcode Command Line Tools not installed.

**Fix**:
```bash
xcode-select --install
```

#### Windows: "error MSB4019: The imported project ... was not found"

**Cause**: Visual Studio Build Tools not installed.

**Fix**: Install Visual Studio Build Tools (see [Prerequisites](#windows))

#### Linux: "g++: command not found"

**Cause**: Build essential not installed.

**Fix**:
```bash
sudo apt-get install build-essential  # Ubuntu/Debian
sudo dnf groupinstall "Development Tools"  # Fedora
```

---

## Contributing

### Development Process

1. **Create a branch**:
```bash
git checkout -b feature/your-feature-name
```

2. **Make changes**:
```bash
# Edit files in src/
# Add tests in tests/
```

3. **Test your changes**:
```bash
npm run build
npm test
npm run lint
```

4. **Commit with descriptive message**:
```bash
git add .
git commit -m "feat: add model verification API"
```

5. **Push and create PR**:
```bash
git push origin feature/your-feature-name
```

### Commit Message Convention

Follow conventional commits:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types**:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `test`: Test additions/changes
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `chore`: Build/tooling changes

**Examples**:
```bash
git commit -m "feat(model): add resume download support"
git commit -m "fix(server): handle SIGTERM gracefully"
git commit -m "docs(api): update ServerConfig examples"
git commit -m "test(storage): add metadata tests"
```

### Code Review Checklist

Before submitting PR:
- [ ] Code compiles without errors (`npm run build`)
- [ ] All tests pass (`npm test`)
- [ ] No linting errors (`npm run lint`)
- [ ] Code is formatted (`npm run format`)
- [ ] New features have tests
- [ ] Documentation updated
- [ ] PROGRESS.md updated with summary of changes

---

## Additional Resources

### Documentation

- [README.md](../README.md) - Project overview and quick start
- [genai-electron-docs/](../genai-electron-docs/) - Complete documentation (11 modular files)
- [DESIGN.md](../DESIGN.md) - Architecture and design decisions
- [PROGRESS.md](../PROGRESS.md) - Implementation progress (Phase 2.6 complete)
- [ESM-TESTING-GUIDE.md](dev/ESM-TESTING-GUIDE.md) - ESM testing patterns and best practices
- [2025-10-23-library-extraction-plan.md](dev/2025-10-23-library-extraction-plan.md) - Library extraction pattern reference
- [docs/dev/phase1/](dev/phase1/) - Phase 1 planning and logs
- [docs/dev/phase2/](dev/phase2/) - Phase 2 planning and logs

### External Resources

- [Node.js Documentation](https://nodejs.org/docs/latest-v22.x/api/)
- [Electron Documentation](https://www.electronjs.org/docs/latest/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [llama.cpp Repository](https://github.com/ggml-org/llama.cpp)

### Getting Help

- **Issues**: [GitHub Issues](https://github.com/yourusername/genai-electron/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/genai-electron/discussions)
- **Contributing**: See [CONTRIBUTING.md](../CONTRIBUTING.md) (if available)

---

## Next Steps

Now that your development environment is set up:

1. **Explore the codebase**: Start with `src/index.ts` and explore the modules
2. **Run the tests**: `npm test` to see all 320 tests in action
3. **Try the example app**: `cd examples/electron-control-panel && npm install && npm run dev`
   - Full-featured control panel demonstrating all library features
   - Shows integration with genai-lite for LLM and image generation
4. **Read the documentation**: [genai-electron-docs/index.md](../genai-electron-docs/index.md) for complete API reference with examples
5. **Check the roadmap**: [DESIGN.md](../DESIGN.md) for Phase 3+ planned features

Happy coding! 🚀
