# Updating llama.cpp Binaries

This guide explains how to update genai-electron to use a new llama.cpp release.

## Archive Format Change (b7956+)

Starting with llama.cpp **b7956**, macOS and Linux binaries use **`.tar.gz`** format instead of `.zip`. Windows binaries remain `.zip`. The codebase handles both formats automatically via `src/utils/archive-utils.ts`.

## When to Update

Check for new llama.cpp releases at: https://github.com/ggml-org/llama.cpp/releases

Updates are typically needed when:
- A new release fixes critical bugs
- Performance improvements are available
- New features are needed
- Security patches are released

## Process Overview

1. Extract SHA256 checksums from GitHub release
2. Update `src/config/defaults.ts` with new version and checksums
3. Verify all required variants are available
4. Build and test
5. Commit changes

## Step 1: Extract SHA256 Checksums

### Method 1: Using WebFetch (Preferred)

The releases page can be fetched programmatically:

```bash
# Try fetching from the main releases page
# This worked for b6784 update
```

Example WebFetch prompt:
```
URL: https://github.com/ggml-org/llama.cpp/releases
Prompt: Look for release bXXXX. Extract ALL SHA256 checksums for these files:
- llama-bXXXX-bin-macos-arm64.tar.gz (macOS/Linux use .tar.gz since b7956)
- llama-bXXXX-bin-macos-x64.tar.gz
- llama-bXXXX-bin-win-cuda-12.4-x64.zip (Windows still uses .zip)
- llama-bXXXX-bin-win-vulkan-x64.zip
- llama-bXXXX-bin-win-cpu-x64.zip
- llama-bXXXX-bin-ubuntu-x64.tar.gz
- llama-bXXXX-bin-ubuntu-vulkan-x64.tar.gz

List them in format: filename | sha256:FULL_HASH
```

### Method 2: Manual HTML Parsing

If WebFetch fails (truncated asset list), download the HTML manually:

1. **Navigate** to the release page (e.g., `https://github.com/ggml-org/llama.cpp/releases/tag/b6784`)
2. **Click "Show more assets"** to expand the full list
3. **Save HTML** with browser's "Save Page As" feature
4. **Parse HTML** using the pattern below

#### HTML Pattern

Each asset follows this structure:

```html
<a href="/ggml-org/llama.cpp/releases/download/b6784/llama-b6784-bin-ubuntu-vulkan-x64.zip" ...>
  <span ...>llama-b6784-bin-ubuntu-vulkan-x64.zip</span>
</a>
...
<span ...>sha256:3f1ba3be1dd9beda20989348cf881d725b33a8b04c74d7beefc98aa77ace6e7c</span>
```

**Extraction algorithm**:
1. Search for filename (e.g., `llama-b6784-bin-ubuntu-vulkan-x64.zip`)
2. Find the next occurrence of `sha256:` after that filename
3. Extract the 64-character hexadecimal hash immediately following `sha256:`
4. Repeat for each required file

#### Parsing Script (Optional)

You can write a Node.js script to automate this:

```javascript
const fs = require('fs');

const html = fs.readFileSync('release.html', 'utf-8');

const files = [
  'llama-b7956-bin-macos-arm64.tar.gz',  // macOS/Linux use .tar.gz since b7956
  'llama-b7956-bin-macos-x64.tar.gz',
  'llama-b7956-bin-win-cuda-12.4-x64.zip',  // Windows still uses .zip
  'llama-b7956-bin-win-vulkan-x64.zip',
  'llama-b7956-bin-win-cpu-x64.zip',
  'llama-b7956-bin-ubuntu-x64.tar.gz',
  'llama-b7956-bin-ubuntu-vulkan-x64.tar.gz',
];

files.forEach(filename => {
  const fileIndex = html.indexOf(filename);
  if (fileIndex === -1) {
    console.log(`${filename} | NOT FOUND`);
    return;
  }

  const sha256Index = html.indexOf('sha256:', fileIndex);
  if (sha256Index === -1) {
    console.log(`${filename} | NO CHECKSUM`);
    return;
  }

  const checksum = html.slice(sha256Index + 7, sha256Index + 7 + 64);
  console.log(`${filename} | ${checksum}`);
});
```

## Step 2: Update Configuration

### File: `src/config/defaults.ts`

Update three things:

1. **Version number**:
   ```typescript
   version: 'b6784',  // Change this
   ```

2. **URLs** (all variants):
   ```typescript
   url: 'https://github.com/ggml-org/llama.cpp/releases/download/b6784/llama-b6784-bin-macos-arm64.zip',
   ```

3. **Checksums** (all variants):
   ```typescript
   checksum: 'ea4be04a6de5348868730eb8665e62de40c469bc53d78ec44295ce29cf08fea1',
   ```

### Required Variants

Ensure ALL these variants are available in the release:

- **macOS ARM64**: Metal support (required)
- **macOS x64**: CPU fallback for Intel Macs
- **Windows CUDA**: NVIDIA GPU with CUDA runtime
- **Windows Vulkan**: Cross-vendor GPU (NVIDIA/AMD/Intel) without CUDA
- **Windows CPU**: Final fallback
- **Linux Ubuntu (CUDA)**: Default for Linux with NVIDIA
- **Linux Ubuntu Vulkan**: Fallback for Linux with any GPU

### Fallback Priority

The order matters! Users' systems will try variants in this order:

```typescript
'win32-x64': [
  { type: 'cuda', ... },      // Try first: NVIDIA + CUDA runtime
  { type: 'vulkan', ... },    // Try second: Any GPU with Vulkan drivers
  { type: 'cpu', ... },       // Try last: CPU-only fallback
],
```

## Step 3: Verify Variant Availability

**IMPORTANT**: Variants appearing "missing" are almost always just hidden by GitHub's UI!

**Common Issue**: GitHub truncates long asset lists with a "Show more assets" button. If a variant seems missing:

1. **First**: Click "Show more assets" on the release page
2. **Second**: Download the full HTML after expanding the list
3. **Last resort**: If truly missing (extremely rare), file an issue with llama.cpp

**Example**: b6783 and b6784 initially appeared to lack `win-vulkan-x64`, but it was just hidden by truncation.

**Always verify ALL required variants exist** by checking the expanded asset list before updating.

## Step 4: Build and Test

```bash
# Build TypeScript
npm run build

# If successful, no output = good!
```

### Manual Testing (Recommended)

Test the download and fallback mechanism:

1. **Delete existing binary**: Remove `userData/binaries/llama-server` (or `.exe`)
2. **Start server**: In electron-control-panel example app
3. **Verify download**: Check logs for "Trying X variant" messages
4. **Verify extraction**: Binary should be extracted and tested with `--version`
5. **Verify fallback**: If CUDA fails, should try Vulkan next (on Windows/Linux)

### Platform-Specific Testing

Ideally test on all platforms:
- macOS ARM64 (Metal should always work)
- macOS x64 (CPU fallback)
- Windows with NVIDIA GPU (CUDA → Vulkan → CPU chain)
- Windows without CUDA drivers (Vulkan → CPU chain)
- Linux with NVIDIA GPU (CUDA → Vulkan chain)
- Linux with AMD/Intel GPU (Vulkan fallback)

## Step 5: Commit Changes

Use a descriptive commit message:

```bash
git add src/config/defaults.ts
git commit -m "feat: update to llama.cpp bXXXX with proper checksum verification

Updated to the latest llama.cpp release (bXXXX) with real SHA256 checksums
for all binary variants.

Changes:
- Version: bYYYY → bXXXX
- Updated all URLs and checksums
- Verified all variants available

Checksums:
- macOS ARM64: abc123...
- macOS x64: def456...
(etc.)
"
```

## Common Issues

### Issue: WebFetch Returns Truncated List

**Symptom**: Missing checksums for some files (e.g., win-vulkan-x64)

**Cause**: GitHub truncates long asset lists with "Show more assets" button

**Solution**: Download HTML manually after clicking "Show more assets", then parse

### Issue: Variant Appears Not Available

**Symptom**: A critical variant (e.g., win-vulkan-x64) doesn't appear in release

**Cause**: 99% of the time - GitHub UI truncation! The asset list is cut off with "Show more assets" button.

**Solution**:
1. **Click "Show more assets"** on the release page to expand full list
2. **Download full HTML** after expanding to ensure you see all assets
3. **Parse the complete HTML** to extract all checksums

**If truly missing** (extremely rare):
- Discuss with project developer/maintainer
- May need to wait for next release or use alternative variant

### Issue: Checksum Mismatch

**Symptom**: Download succeeds but checksum verification fails

**Causes**:
- Incorrect checksum copied (typo, truncation)
- GitHub release updated after you fetched checksums
- Network corruption during download

**Solution**:
1. Re-fetch checksums from GitHub
2. Verify you copied full 64-character hash
3. Try downloading binary manually to verify GitHub's checksum

### Issue: Binary Test Fails

**Symptom**: Binary downloads and extracts, but `--version` test fails

**Causes**:
- Missing drivers (CUDA/Vulkan/etc.)
- Wrong architecture (e.g., ARM binary on x64)
- Corrupted download (should be caught by checksum)

**Expected Behavior**: System should fall back to next variant automatically

## Update Checklist

- [ ] Check new release exists on GitHub
- [ ] Click "Show more assets" to expand full asset list on GitHub
- [ ] Extract SHA256 checksums for ALL variants (all 7 files)
- [ ] Update version in `src/config/defaults.ts`
- [ ] Update all 7 URLs to new version
- [ ] Update all 7 checksums with correct hashes
- [ ] Run `npm run build` to verify TypeScript compiles
- [ ] Test download on at least one platform
- [ ] Commit with descriptive message
- [ ] Update PROGRESS.md if this is a significant change

## Historical Context

### Why Vulkan Fallback Matters

Initially, the Windows fallback chain was: CUDA → CPU, skipping Vulkan entirely.

**Problem**: Users with:
- AMD GPUs (no CUDA support)
- Intel GPUs (no CUDA support)
- NVIDIA GPUs without CUDA runtime installed

...would fall back to CPU, missing out on GPU acceleration.

**Solution**: Add Vulkan as middle fallback: CUDA → Vulkan → CPU

Vulkan works with any GPU vendor (NVIDIA, AMD, Intel) using standard drivers, without requiring CUDA runtime.

### Why Multiple Variants Per Platform

Different GPU configurations require different binaries:
- **CUDA**: Best performance on NVIDIA, requires CUDA runtime
- **Vulkan**: Works on any GPU (NVIDIA/AMD/Intel), requires Vulkan drivers
- **CPU**: Universal fallback, no GPU required

The library tests each variant with `--version` to verify drivers are present before using it.

## Handling Binary Dependencies (CUDA Runtime DLLs)

Some binary variants require additional dependencies to function correctly. The most common example is CUDA variants on Windows, which need CUDA runtime DLLs.

### When Dependencies Are Needed

**CUDA Variants (Windows only):**
- llama.cpp CUDA: Requires `cudart-llama-bin-win-cuda-12.4-x64.zip`
- stable-diffusion.cpp CUDA: Requires `cudart-sd-bin-win-cu12-x64.zip`

**Vulkan/CPU Variants:**
- No dependencies needed (work out of the box)

### Adding Dependencies to Configuration

Dependencies are added to the `dependencies` array in `BinaryVariantConfig`:

```typescript
{
  type: 'cuda' as BinaryVariant,
  url: 'https://github.com/.../llama-cuda.zip',
  checksum: 'abc123...',
  dependencies: [
    {
      url: 'https://github.com/.../cudart-llama.zip',
      checksum: 'def456...',
      description: 'CUDA 12.4 runtime libraries required for NVIDIA GPU acceleration',
    },
  ],
}
```

### Extracting Dependency Checksums

Follow the same process as for main binaries (see "Step 1: Extract SHA256 Checksums" above):

1. Navigate to the release page
2. Click "Show more assets" to expand full list
3. Find the dependency file (e.g., `cudart-llama-bin-win-cuda-12.4-x64.zip`)
4. Extract the SHA256 checksum following the same pattern

**Example (from llama.cpp b6784):**
```
cudart-llama-bin-win-cuda-12.4-x64.zip | 8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6
```

### How Dependencies Work

1. **Download Order:** Dependencies are downloaded BEFORE the main binary
2. **Extraction:** Dependencies are extracted to the same directory as the main binary
3. **Testing:** Binary is tested WITH dependencies present
4. **Cleanup:** If binary test fails, BOTH binary and dependencies are cleaned up
5. **Deployment:** All files (binary + dependencies) are copied to the final binaries directory

### CUDA GPU Detection

The library automatically detects CUDA GPU availability and skips CUDA variants on systems without NVIDIA GPUs. This prevents unnecessary downloads (~100-200MB per binary type).

**Behavior:**
- NVIDIA GPU detected → Try CUDA variant (with dependencies)
- AMD/Intel GPU detected → Skip CUDA, try Vulkan
- No GPU detected → Skip CUDA, try CPU

### Update Checklist (with Dependencies)

When updating to a new release that requires dependencies:

- [ ] Extract SHA256 for main binary
- [ ] Extract SHA256 for dependency (if CUDA variant)
- [ ] Update main binary URL and checksum
- [ ] Add or update `dependencies` array
- [ ] Verify dependency URL is correct
- [ ] Test download on target platform
- [ ] Confirm binary works with dependencies

### Example: Updating llama.cpp with CUDA Dependencies

```typescript
'win32-x64': [
  {
    type: 'cuda' as BinaryVariant,
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b6784/llama-b6784-bin-win-cuda-12.4-x64.zip',
    checksum: 'a7a8981f742cdc0e1c93c02caa955fb2ad2716407fb3556cbc71e7e4e44f7d72',
    dependencies: [
      {
        url: 'https://github.com/ggml-org/llama.cpp/releases/download/b6784/cudart-llama-bin-win-cuda-12.4-x64.zip',
        checksum: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
        description: 'CUDA 12.4 runtime libraries required for NVIDIA GPU acceleration',
      },
    ],
  },
  // ... other variants (Vulkan, CPU) don't need dependencies
]
```

## Real Functionality Testing

The library automatically performs real GPU functionality testing during variant selection to catch broken CUDA/GPU acceleration before caching a variant as "working".

### How It Works

**When a model is available:**
1. BinaryManager downloads variant (e.g., CUDA)
2. Downloads dependencies if needed (CUDA runtime DLLs)
3. Runs **real inference test** instead of just `--version`:
   - **LLM**: Generates 1 token with GPU layers forced (`-ngl 1`)
   - **Diffusion**: Generates 64x64 image with 1 step
4. Parses output for GPU errors:
   - "CUDA error"
   - "failed to allocate"
   - "out of memory"
   - "Vulkan error"
   - etc.
5. If test fails: Logs warning, tries next variant
6. If test succeeds: Caches variant for fast subsequent starts

**When no model is available:**
- Falls back to basic `--version`/`--help` test
- Less reliable but ensures binary at least loads

### Why This Matters

**Problem Solved:**
- CUDA binaries can pass `--version` test even with missing/broken runtime DLLs
- Binary gets cached as "working" but fails during actual inference
- System never tries Vulkan fallback

**With Real Functionality Testing:**
- Detects broken CUDA during first `start()` call
- Automatically falls back to Vulkan if CUDA is broken
- Prevents caching non-functional variants

### Testing Manually

If you need to manually test a binary variant with real functionality:

**For llama-server:**
```bash
cd /path/to/binaries
./llama-server -m /path/to/model.gguf -p "Hi" -n 1 --ctx-size 512 -ngl 1
# Check stderr for "CUDA error" or other GPU errors
```

**For stable-diffusion.cpp:**
```bash
cd /path/to/binaries
./sd -m /path/to/model.safetensors -p "test" -o test.png --width 64 --height 64 --steps 1
# Check stderr for "CUDA error" or "Vulkan error"
```

### Implementation Details

- **Location**: `src/managers/BinaryManager.ts` - `runRealFunctionalityTest()` method
- **Timeout**: 30 seconds (prevents hanging on broken binaries)
- **Error Patterns**: See `errorPatterns` array in `runRealFunctionalityTest()`
- **Automatic**: No configuration needed, happens transparently during `start()`

## Related Files

- **Binary configuration**: `src/config/defaults.ts`
- **Download logic**: `src/managers/BinaryManager.ts` (ensureBinary, downloadDependencies methods)
- **Archive extraction**: `src/utils/archive-utils.ts` (supports both .zip and .tar.gz)
- **Checksum verification**: `src/managers/BinaryManager.ts` (downloadAndTestVariant method)
- **CUDA detection**: `src/system/gpu-detect.ts`

## References

- llama.cpp releases: https://github.com/ggml-org/llama.cpp/releases
- stable-diffusion.cpp releases: https://github.com/leejet/stable-diffusion.cpp/releases
- Binary variant docs: See DESIGN.md Phase 1 section
- CUDA runtime dependencies: Issue 5 in PROGRESS.md
