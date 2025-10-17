# Updating llama.cpp Binaries

This guide explains how to update genai-electron to use a new llama.cpp release.

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
- llama-bXXXX-bin-macos-arm64.zip
- llama-bXXXX-bin-macos-x64.zip
- llama-bXXXX-bin-win-cuda-12.4-x64.zip
- llama-bXXXX-bin-win-vulkan-x64.zip
- llama-bXXXX-bin-win-cpu-x64.zip
- llama-bXXXX-bin-ubuntu-x64.zip
- llama-bXXXX-bin-ubuntu-vulkan-x64.zip

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
  'llama-b6784-bin-macos-arm64.zip',
  'llama-b6784-bin-macos-x64.zip',
  'llama-b6784-bin-win-cuda-12.4-x64.zip',
  'llama-b6784-bin-win-vulkan-x64.zip',
  'llama-b6784-bin-win-cpu-x64.zip',
  'llama-b6784-bin-ubuntu-x64.zip',
  'llama-b6784-bin-ubuntu-vulkan-x64.zip',
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

  const checksum = html.substr(sha256Index + 7, 64);
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

**IMPORTANT**: Some releases may be missing variants!

- Example: b6783 initially appeared to lack `win-vulkan-x64` (but was actually hidden by GitHub's "Show more" truncation)
- Always verify ALL required variants exist before updating

If a critical variant is missing:
- Check the previous release (e.g., b6782)
- Wait for the next release
- Or remove that variant from the fallback chain (not recommended)

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

### Issue: Variant Not Available

**Symptom**: A critical variant (e.g., win-vulkan-x64) doesn't exist in release

**Solutions**:
1. Check previous release (may be available there)
2. Wait for next release
3. Remove from fallback chain (not recommended - reduces compatibility)

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
- [ ] Extract SHA256 checksums for ALL variants
- [ ] Verify all required variants are available (especially win-vulkan-x64)
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

## Related Files

- **Binary configuration**: `src/config/defaults.ts`
- **Download logic**: `src/managers/LlamaServerManager.ts` (ensureBinary method)
- **ZIP extraction**: `src/utils/zip-utils.ts`
- **Checksum verification**: `src/managers/LlamaServerManager.ts` (downloadAndTestVariant method)

## References

- llama.cpp releases: https://github.com/ggml-org/llama.cpp/releases
- Binary variant docs: See DESIGN.md Phase 1 section
