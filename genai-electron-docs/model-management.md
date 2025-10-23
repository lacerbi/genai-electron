# Model Management

The `ModelManager` class handles model downloading, storage, and management for both LLM and diffusion models.

---

## Table of Contents

- [Overview](#overview)
- [Import](#import)
- [Core Operations](#core-operations)
  - [listModels()](#listmodels)
  - [downloadModel()](#downloadmodel)
  - [getModelInfo()](#getmodelinfo)
  - [deleteModel()](#deletemodel)
  - [verifyModel()](#verifymodel)
- [Download Management](#download-management)
  - [cancelDownload()](#canceldownload)
  - [isDownloading()](#isdownloading)
- [GGUF Metadata](#gguf-metadata)
  - [Automatic Extraction](#automatic-extraction)
  - [updateModelMetadata()](#updatemodelmetadata)
  - [Convenience Methods](#convenience-methods)
- [Reasoning Model Detection](#reasoning-model-detection)
- [Error Handling](#error-handling)
- [Examples](#examples)

---

## Overview

`ModelManager` provides organized model storage in Electron's `userData` directory with support for:
- GGUF model downloads from direct URLs or HuggingFace
- Automatic GGUF metadata extraction (layer count, context length, architecture)
- Model verification via SHA256 checksums
- Progress tracking for downloads
- Reasoning model detection (Qwen3, DeepSeek-R1, GPT-OSS)
- Download cancellation and status checking

**Storage Location**: `app.getPath('userData')/models/`
- LLM models: `models/llm/`
- Diffusion models: `models/diffusion/`

---

## Import

```typescript
import { modelManager } from 'genai-electron';

// Or for advanced usage:
import { ModelManager } from 'genai-electron';
const customModelManager = ModelManager.getInstance();
```

---

## Core Operations

### listModels()

Lists all installed models, optionally filtered by type.

**Signature**:
```typescript
listModels(type?: ModelType): Promise<ModelInfo[]>
```

**Parameters**:
- `type?: ModelType` - Optional filter: `'llm'` or `'diffusion'`

**Returns**: `Promise<ModelInfo[]>` - Array of installed models

**Example**:
```typescript
// List all models
const allModels = await modelManager.listModels();
console.log('Total models:', allModels.length);

// List only LLM models
const llmModels = await modelManager.listModels('llm');
console.log('LLM models:', llmModels.length);

llmModels.forEach(model => {
  console.log('Model:', model.name);
  console.log('  ID:', model.id);
  console.log('  Size:', (model.size / 1024 / 1024 / 1024).toFixed(2), 'GB');
  console.log('  Type:', model.type);
  console.log('  Downloaded:', model.downloadedAt);
  console.log('  Source:', model.source.type);
});
```

---

### downloadModel()

Downloads a model from a URL or HuggingFace repository.

**Signature**:
```typescript
downloadModel(config: DownloadConfig): Promise<ModelInfo>
```

**DownloadConfig Options**:

**Direct URL**:
- `source: 'url'`
- `url: string` - Direct download URL
- `name: string` - Display name for the model
- `type: ModelType` - `'llm'` or `'diffusion'`
- `checksum?: string` - Optional SHA256 checksum (format: `'sha256:...'`)
- `onProgress?: (downloaded: number, total: number) => void` - Progress callback

**HuggingFace**:
- `source: 'huggingface'`
- `repo: string` - Repository path (e.g., `'TheBloke/Llama-2-7B-GGUF'`)
- `file: string` - File name (e.g., `'llama-2-7b.Q4_K_M.gguf'`)
- `name: string` - Display name
- `type: ModelType` - Model type
- `checksum?: string` - Optional checksum
- `onProgress?: (downloaded: number, total: number) => void` - Progress callback

**Returns**: `Promise<ModelInfo>` - Information about the downloaded model

**Example (Direct URL)**:
```typescript
const model = await modelManager.downloadModel({
  source: 'url',
  url: 'https://example.com/my-model.gguf',
  name: 'My Custom Model',
  type: 'llm',
  checksum: 'sha256:abc123...', // Recommended for integrity verification
  onProgress: (downloaded, total) => {
    const percent = ((downloaded / total) * 100).toFixed(1);
    console.log(`Downloading: ${percent}% (${downloaded}/${total} bytes)`);
  }
});

console.log('Download complete!');
console.log('Model ID:', model.id);
console.log('Model path:', model.path);
```

**Example (HuggingFace)**:
```typescript
const model = await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'TheBloke/Llama-2-7B-GGUF',
  file: 'llama-2-7b.Q4_K_M.gguf',
  name: 'Llama 2 7B Q4',
  type: 'llm',
  onProgress: (downloaded, total) => {
    const mb = (downloaded / 1024 / 1024).toFixed(1);
    const totalMb = (total / 1024 / 1024).toFixed(1);
    console.log(`Progress: ${mb}MB / ${totalMb}MB`);
  }
});

console.log('Successfully downloaded:', model.name);
```

**GGUF Metadata Extraction**:

GGUF metadata is automatically extracted from the model file **before** downloading:
- ✅ **Pre-download validation** - Confirms file is a valid GGUF
- ✅ **Accurate information** - Layer count, context length, architecture
- ✅ **No guessing** - Real values from model file
- ✅ **Fast failure** - Fails immediately if not a valid GGUF (saves bandwidth)

The metadata is stored with the model and accessible via `model.ggufMetadata`.

---

### getModelInfo()

Gets detailed information about a specific model.

**Signature**:
```typescript
getModelInfo(id: string): Promise<ModelInfo>
```

**Parameters**:
- `id: string` - Model ID

**Returns**: `Promise<ModelInfo>` - Model information

**Example**:
```typescript
const info = await modelManager.getModelInfo('llama-2-7b');

console.log('Model Information:');
console.log('Name:', info.name);
console.log('Type:', info.type);
console.log('Size:', (info.size / 1024 / 1024 / 1024).toFixed(2), 'GB');
console.log('Path:', info.path);
console.log('Downloaded:', new Date(info.downloadedAt).toLocaleString());
console.log('Source:', info.source.type);
if (info.source.type === 'huggingface') {
  console.log('Repository:', info.source.repo);
  console.log('File:', info.source.file);
}
if (info.checksum) {
  console.log('Checksum:', info.checksum);
}
```

**Throws**: `ModelNotFoundError` if model doesn't exist

---

### deleteModel()

Deletes a model and its metadata.

**Signature**:
```typescript
deleteModel(id: string): Promise<void>
```

**Parameters**:
- `id: string` - Model ID to delete

**Returns**: `Promise<void>`

**Example**:
```typescript
// List models first
const models = await modelManager.listModels();
console.log('Available models:');
models.forEach((m, i) => console.log(`${i + 1}. ${m.name} (${m.id})`));

// Delete a specific model
const modelToDelete = models[0];
await modelManager.deleteModel(modelToDelete.id);
console.log(`Deleted: ${modelToDelete.name}`);

// Verify deletion
const updated = await modelManager.listModels();
console.log('Remaining models:', updated.length);
```

**Throws**: `ModelNotFoundError` if model doesn't exist

---

### verifyModel()

Verifies model file integrity using stored checksum.

**Signature**:
```typescript
verifyModel(id: string): Promise<boolean>
```

**Parameters**:
- `id: string` - Model ID to verify

**Returns**: `Promise<boolean>` - `true` if valid, `false` if checksum doesn't match

**Example**:
```typescript
const isValid = await modelManager.verifyModel('llama-2-7b');

if (isValid) {
  console.log('✅ Model file is valid');
} else {
  console.log('❌ Model file is corrupted or tampered with');
  console.log('Consider re-downloading the model');
}
```

**Note**: Only works if checksum was provided during download. Returns `false` if no checksum stored (cannot verify integrity without checksum).

**Throws**: `ModelNotFoundError` if model doesn't exist

---

## Download Management

### cancelDownload()

Cancels any ongoing download operation.

**Signature**:
```typescript
cancelDownload(): void
```

**Example**:
```typescript
// Start download
const downloadPromise = modelManager.downloadModel({
  source: 'url',
  url: 'https://example.com/large-model.gguf',
  name: 'Large Model',
  type: 'llm',
  onProgress: (downloaded, total) => {
    console.log(`Progress: ${((downloaded / total) * 100).toFixed(1)}%`);
  }
});

// Cancel after 5 seconds
setTimeout(() => {
  console.log('Cancelling download...');
  modelManager.cancelDownload();
}, 5000);

try {
  await downloadPromise;
} catch (error) {
  if (error instanceof DownloadError) {
    console.log('Download was cancelled');
  }
}
```

---

### isDownloading()

Check if a download is currently in progress.

**Signature**:
```typescript
isDownloading(): boolean
```

**Returns**: `boolean` - `true` if a download is in progress, `false` otherwise

**Example**:
```typescript
// Start download
modelManager.downloadModel({
  source: 'url',
  url: 'https://example.com/model.gguf',
  name: 'My Model',
  type: 'llm'
}).catch(console.error);

// Check download status
if (modelManager.isDownloading()) {
  console.log('Download in progress...');
} else {
  console.log('No active download');
}
```

**Use Case**:
- Prevent starting multiple simultaneous downloads
- Display download status in UI
- Implement download queue management

---

## GGUF Metadata

### Automatic Extraction

GGUF metadata is automatically extracted during model download, providing accurate model information:

**What's included**:
- `block_count` - Actual number of layers (no estimation!)
- `context_length` - Maximum sequence length the model supports
- `architecture` - Model architecture ('llama', 'mamba', 'gpt2', etc.)
- `attention_head_count` - Number of attention heads
- `embedding_length` - Embedding dimension
- Plus 10+ additional fields and complete raw metadata

**Example**:
```typescript
const model = await modelManager.getModelInfo('llama-2-7b');
if (model.ggufMetadata) {
  console.log('✅ Accurate metadata available');
  console.log('Layers:', model.ggufMetadata.block_count);
  console.log('Context:', model.ggufMetadata.context_length);
  console.log('Architecture:', model.ggufMetadata.architecture);
} else {
  console.log('⚠️  Using estimated values (model downloaded before GGUF integration)');
  // Update metadata: await modelManager.updateModelMetadata('llama-2-7b');
}
```

For models downloaded before GGUF integration, this field may be `undefined`. Use `modelManager.updateModelMetadata(id)` to add metadata without re-downloading.

---

### updateModelMetadata()

Updates GGUF metadata for an existing model without re-downloading.

Useful for models downloaded before GGUF integration or to refresh metadata.

**Signature**:
```typescript
updateModelMetadata(
  id: string,
  options?: { source?: MetadataFetchStrategy }
): Promise<ModelInfo>
```

**Parameters**:
- `id: string` - Model ID
- `options?: { source?: MetadataFetchStrategy }` - Optional configuration
  - `source?: MetadataFetchStrategy` - Where to fetch metadata from (default: `'local-remote'`)
    - `'local-remote'` - Try local first, fallback to remote if local fails (default)
    - `'local-only'` - Read from local file only (fastest, offline-capable)
    - `'remote-only'` - Fetch from remote URL only (requires network)
    - `'remote-local'` - Try remote first, fallback to local if remote fails

**Returns**: `Promise<ModelInfo>` - Updated model information with GGUF metadata

**Example (Default - Local + Remote Fallback)**:
```typescript
// Update metadata from local file first, fallback to remote if needed (default)
const updated = await modelManager.updateModelMetadata('llama-2-7b');

console.log('Updated model information:');
console.log('Layer count:', updated.ggufMetadata?.block_count);
console.log('Context length:', updated.ggufMetadata?.context_length);
console.log('Architecture:', updated.ggufMetadata?.architecture);
```

**Example (Remote Only - Force Fresh from Source)**:
```typescript
// Force fetch from original URL (useful if local file suspected corrupted)
const fresh = await modelManager.updateModelMetadata('llama-2-7b', {
  source: 'remote-only'
});

console.log('Fresh metadata from source:', fresh.ggufMetadata?.block_count);
```

**Strategy Use Cases**:

| Strategy | Speed | Offline | Use When |
|----------|-------|---------|----------|
| `local-remote` (default) | Fast | ✅ Partial | Want speed + resilience (recommended) |
| `local-only` | Fastest | ✅ Yes | Certain local file is good |
| `remote-only` | Slowest | ❌ No | Verify against source, suspect local corruption |
| `remote-local` | Slow | ✅ Partial | Want authoritative + offline fallback |

**Throws**:
- `ModelNotFoundError` if model doesn't exist
- `DownloadError` if metadata fetch fails (strategy-dependent)

---

### Convenience Methods

#### getModelLayerCount()

Gets the actual layer count for a model. Uses GGUF metadata if available, falls back to estimation for older models.

**Signature**:
```typescript
getModelLayerCount(id: string): Promise<number>
```

**Example**:
```typescript
const layers = await modelManager.getModelLayerCount('llama-2-7b');
console.log(`Model has ${layers} layers`);

// Use for GPU offloading calculations
const gpuLayers = 24; // Want to offload 24 layers to GPU
const gpuRatio = gpuLayers / layers;
console.log(`Offloading ${(gpuRatio * 100).toFixed(1)}% to GPU`);

// Check if offloading request is valid
if (gpuLayers > layers) {
  console.warn(`Cannot offload ${gpuLayers} layers - model only has ${layers}`);
}
```

#### getModelContextLength()

Gets the actual context length for a model. Uses GGUF metadata if available, falls back to default for older models.

**Signature**:
```typescript
getModelContextLength(id: string): Promise<number>
```

**Example**:
```typescript
const contextLen = await modelManager.getModelContextLength('llama-2-7b');
console.log(`Context window: ${contextLen} tokens`);

// Use for appropriate context size configuration
const config = {
  modelId: 'llama-2-7b',
  contextSize: Math.min(contextLen, 8192), // Don't exceed model's capacity
  port: 8080
};

await llamaServer.start(config);
console.log(`Started with context size: ${config.contextSize}`);
```

#### getModelArchitecture()

Gets the architecture type for a model. Uses GGUF metadata if available, falls back to 'llama' for LLM models.

**Signature**:
```typescript
getModelArchitecture(id: string): Promise<string>
```

**Example**:
```typescript
const arch = await modelManager.getModelArchitecture('llama-2-7b');
console.log(`Architecture: ${arch}`);

// Verify architecture matches expected type
if (arch !== 'llama') {
  console.warn('⚠️  This model may not work with llama-server');
  console.warn(`Expected: llama, Got: ${arch}`);
} else {
  console.log('✅ Model architecture verified');
}
```

**Supported Architectures**:
The library uses generic architecture field extraction, supporting ANY model architecture dynamically:
- **Llama family**: llama, llama2, llama3
- **Gemma family**: gemma, gemma2, gemma3
- **Qwen family**: qwen, qwen2, qwen3
- **Other**: mistral, phi, mamba, gpt2, gpt-neox, falcon, and any future architectures

---

## Reasoning Model Detection

genai-electron automatically detects and configures reasoning-capable models that use `<think>...</think>` tags for chain-of-thought reasoning.

**Supported Models**:
- **Qwen3**: All sizes (0.6B, 1.7B, 4B, 8B, 14B, 30B)
- **DeepSeek-R1**: All variants including distilled models
- **GPT-OSS**: OpenAI's open-source reasoning model

**Detection Function**:
```typescript
import { detectReasoningSupport, REASONING_MODEL_PATTERNS } from 'genai-electron';

// Check if a model supports reasoning based on filename
const supportsReasoning = detectReasoningSupport('Qwen3-8B-Instruct-Q4_K_M.gguf');
console.log('Supports reasoning:', supportsReasoning); // true

// View known patterns
console.log('Known patterns:', REASONING_MODEL_PATTERNS);
// ['qwen3', 'deepseek-r1', 'gpt-oss']
```

**How it works**:
1. ModelManager detects reasoning support from GGUF filename during download
2. Stores `supportsReasoning: true` in model metadata
3. LlamaServerManager automatically adds `--jinja --reasoning-format deepseek` flags when starting the server
4. Use with genai-lite to access reasoning traces via the `reasoning` field in responses

**Example**:
```typescript
const modelInfo = await modelManager.getModelInfo('qwen3-8b');

if (modelInfo.supportsReasoning) {
  console.log('✅ Model supports reasoning (automatic flag injection enabled)');
  console.log('llama-server will use: --jinja --reasoning-format deepseek');
}
```

---

## Error Handling

```typescript
try {
  await modelManager.downloadModel(config);
} catch (error) {
  if (error instanceof DownloadError) {
    console.error('Download failed:', error.message);
    // Network error, server error, etc.
  } else if (error instanceof InsufficientResourcesError) {
    console.error('Not enough disk space:', error.message);
    console.log('Suggestion:', error.details.suggestion);
  } else if (error instanceof ChecksumError) {
    console.error('File corrupted:', error.message);
  } else if (error instanceof ModelNotFoundError) {
    console.error('Model not found:', error.message);
  }
}
```

**Error Types**:
- `ModelNotFoundError` - Model doesn't exist
- `DownloadError` - Network or server error during download
- `InsufficientResourcesError` - Not enough disk space
- `ChecksumError` - Checksum verification failed (file corrupted)

---

## Examples

### Complete Download Workflow

```typescript
import { modelManager, systemInfo } from 'genai-electron';

async function downloadModelSafely() {
  // 1. Check system capabilities
  const capabilities = await systemInfo.detect();
  console.log('Recommended max model size:', capabilities.recommendations.maxModelSize);

  // 2. Download model with progress tracking
  try {
    const model = await modelManager.downloadModel({
      source: 'huggingface',
      repo: 'TheBloke/Llama-2-7B-GGUF',
      file: 'llama-2-7b.Q4_K_M.gguf',
      name: 'Llama 2 7B Q4',
      type: 'llm',
      onProgress: (downloaded, total) => {
        const percent = ((downloaded / total) * 100).toFixed(1);
        const downloadedMB = (downloaded / 1024 / 1024).toFixed(1);
        const totalMB = (total / 1024 / 1024).toFixed(1);
        console.log(`Progress: ${percent}% (${downloadedMB}MB / ${totalMB}MB)`);
      }
    });

    console.log('✅ Download complete!');
    console.log('Model ID:', model.id);
    console.log('Supports reasoning:', model.supportsReasoning);

    // 3. Check GGUF metadata
    if (model.ggufMetadata) {
      console.log('GGUF Metadata:');
      console.log('  Layers:', model.ggufMetadata.block_count);
      console.log('  Context:', model.ggufMetadata.context_length);
      console.log('  Architecture:', model.ggufMetadata.architecture);
    }

    // 4. Verify model can run
    const canRun = await systemInfo.canRunModel(model);
    if (!canRun.possible) {
      console.warn('⚠️  Model may not run:', canRun.reason);
    }

  } catch (error) {
    if (error instanceof InsufficientResourcesError) {
      console.error('Not enough disk space');
    } else if (error instanceof DownloadError) {
      console.error('Download failed:', error.message);
    }
  }
}
```

---

## What's Next?

- **[LLM Server](llm-server.md)** - Use downloaded models to run LLMs
- **[Image Generation](image-generation.md)** - Use diffusion models for image generation
- **[System Detection](system-detection.md)** - Check if models are compatible with your system
- **[TypeScript Reference](typescript-reference.md)** - ModelInfo, DownloadConfig, and related types
