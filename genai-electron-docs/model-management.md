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
  - [Advanced: GGUF Parsing Utilities](#advanced-gguf-parsing-utilities)
- [Reasoning Model Detection](#reasoning-model-detection)
- [Error Handling](#error-handling)
- [Examples](#examples)

---

## Overview

`ModelManager` handles model downloads, storage, and metadata extraction in Electron's `userData` directory. Downloads GGUF models from direct URLs or HuggingFace with automatic metadata extraction (layer count, context length, architecture) before download. Supports checksum verification, progress tracking, and automatic reasoning model detection.

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

```typescript
listModels(type?: ModelType): Promise<ModelInfo[]>
```

**Parameters**:
- `type?: ModelType` - Optional filter: `'llm'` or `'diffusion'`

**Returns**: `Promise<ModelInfo[]>` - Array of installed models

**Example**:
```typescript
const allModels = await modelManager.listModels();
console.log('Total models:', allModels.length);

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

```typescript
downloadModel(config: DownloadConfig): Promise<ModelInfo>
```

**DownloadConfig**: Supports direct URLs (`source: 'url'`, `url`) or HuggingFace (`source: 'huggingface'`, `repo`, `file`). Both require `name`, `type` ('llm' | 'diffusion'). Optional: `checksum` (SHA256), `onProgress` callback.

**Example**:
```typescript
const model = await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'TheBloke/Llama-2-7B-GGUF',
  file: 'llama-2-7b.Q4_K_M.gguf',
  name: 'Llama 2 7B Q4',
  type: 'llm',
  onProgress: (downloaded, total) => {
    console.log(`${((downloaded / total) * 100).toFixed(1)}%`);
  }
});
```

**Note**: GGUF metadata is automatically extracted before downloading to validate the file.

---

### getModelInfo()

Gets detailed information about a specific model.

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

```typescript
deleteModel(id: string): Promise<void>
```

**Parameters**:
- `id: string` - Model ID to delete

**Returns**: `Promise<void>`

**Example**:
```typescript
const models = await modelManager.listModels();
const modelToDelete = models[0];
await modelManager.deleteModel(modelToDelete.id);
console.log(`Deleted: ${modelToDelete.name}`);

const updated = await modelManager.listModels();
console.log('Remaining models:', updated.length);
```

**Throws**: `ModelNotFoundError` if model doesn't exist

---

### verifyModel()

Verifies model file integrity using stored checksum.

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

```typescript
cancelDownload(): void
```

**Example**:
```typescript
const downloadPromise = modelManager.downloadModel({
  source: 'url',
  url: 'https://example.com/large-model.gguf',
  name: 'Large Model',
  type: 'llm',
  onProgress: (downloaded, total) => {
    console.log(`Progress: ${((downloaded / total) * 100).toFixed(1)}%`);
  }
});

setTimeout(() => {
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

```typescript
isDownloading(): boolean
```

**Returns**: `boolean` - `true` if a download is in progress, `false` otherwise

**Example**:
```typescript
modelManager.downloadModel({
  source: 'url',
  url: 'https://example.com/model.gguf',
  name: 'My Model',
  type: 'llm'
}).catch(console.error);

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

GGUF metadata is automatically extracted before downloading, providing accurate model information (block_count, context_length, architecture, attention_head_count, embedding_length, and more). For models downloaded before GGUF integration, `ggufMetadata` field may be `undefined`. Use `updateModelMetadata(id)` to add metadata without re-downloading.

**Example**:
```typescript
const model = await modelManager.getModelInfo('llama-2-7b');
if (model.ggufMetadata) {
  console.log('Layers:', model.ggufMetadata.block_count);
  console.log('Context:', model.ggufMetadata.context_length);
} else {
  await modelManager.updateModelMetadata('llama-2-7b');
}
```

---

### updateModelMetadata()

Updates GGUF metadata for an existing model without re-downloading. Useful for models downloaded before GGUF integration or to refresh metadata.

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

**Example**:
```typescript
const updated = await modelManager.updateModelMetadata('llama-2-7b');
console.log('Layers:', updated.ggufMetadata?.block_count);
console.log('Context:', updated.ggufMetadata?.context_length);

const fresh = await modelManager.updateModelMetadata('llama-2-7b', {
  source: 'remote-only'
});
```

**Throws**:
- `ModelNotFoundError` if model doesn't exist
- `DownloadError` if metadata fetch fails (strategy-dependent)

---

### Convenience Methods

#### getModelLayerCount()

Gets the actual layer count for a model. Uses GGUF metadata if available, falls back to estimation for older models.

```typescript
getModelLayerCount(id: string): Promise<number>
```

**Example**:
```typescript
const layers = await modelManager.getModelLayerCount('llama-2-7b');
console.log(`Model has ${layers} layers`);

const gpuLayers = 24;
const gpuRatio = gpuLayers / layers;
console.log(`Offloading ${(gpuRatio * 100).toFixed(1)}% to GPU`);

if (gpuLayers > layers) {
  console.warn(`Cannot offload ${gpuLayers} layers - model only has ${layers}`);
}
```

#### getModelContextLength()

Gets the actual context length for a model. Uses GGUF metadata if available, falls back to default for older models.

```typescript
getModelContextLength(id: string): Promise<number>
```

**Example**:
```typescript
const contextLen = await modelManager.getModelContextLength('llama-2-7b');
console.log(`Context window: ${contextLen} tokens`);

const config = {
  modelId: 'llama-2-7b',
  contextSize: Math.min(contextLen, 8192),
  port: 8080
};

await llamaServer.start(config);
```

#### getModelArchitecture()

Gets the architecture type for a model. Uses GGUF metadata if available, falls back to 'llama' for LLM models.

```typescript
getModelArchitecture(id: string): Promise<string>
```

**Example**:
```typescript
const arch = await modelManager.getModelArchitecture('llama-2-7b');
console.log(`Architecture: ${arch}`);

if (arch !== 'llama') {
  console.warn(`⚠️  This model may not work with llama-server (got: ${arch})`);
}
```

**Supported Architectures**: Uses generic extraction supporting any GGUF architecture (llama, gemma, qwen, mistral, phi, mamba, gpt2, etc.).

---

### Advanced: GGUF Parsing Utilities

For advanced use cases, genai-electron exports low-level utilities for working with GGUF metadata:

```typescript
import {
  fetchGGUFMetadata,      // Fetch metadata from remote URL
  fetchLocalGGUFMetadata, // Read metadata from local file
  getArchField            // Extract architecture-specific fields
} from 'genai-electron';

// Fetch metadata before downloading (useful for validation)
const metadata = await fetchGGUFMetadata('https://huggingface.co/.../model.gguf');
console.log('Layers:', metadata.block_count);
console.log('Architecture:', metadata.architecture);

// Read metadata from local file
const localMetadata = await fetchLocalGGUFMetadata('/path/to/model.gguf');

// Extract architecture-specific fields from raw metadata
const blockCount = getArchField(metadata.raw, 'block_count');
```

**Note**: Most users don't need these - `ModelManager.downloadModel()` automatically extracts and stores GGUF metadata. Use these for custom workflows or validation before downloading.

---

## Reasoning Model Detection

genai-electron automatically detects and configures reasoning-capable models that use `<think>...</think>` tags for chain-of-thought reasoning.

**Supported Models**:
- **Qwen3**: All sizes (0.6B, 1.7B, 4B, 8B, 14B, 30B)
- **DeepSeek-R1**: All variants including distilled models
- **GPT-OSS**: OpenAI's open-source reasoning model

```typescript
import { detectReasoningSupport } from 'genai-electron';

const supportsReasoning = detectReasoningSupport('Qwen3-8B-Instruct-Q4_K_M.gguf');
console.log('Supports reasoning:', supportsReasoning);
```

**How it works**: ModelManager detects reasoning support from filename during download, stores `supportsReasoning: true` in metadata, and LlamaServerManager automatically adds `--jinja --reasoning-format deepseek` flags when starting the server.

---

## Error Handling

```typescript
try {
  await modelManager.downloadModel(config);
} catch (error) {
  if (error instanceof ModelNotFoundError) {
    console.error('Model not found:', error.message);
  } else if (error instanceof DownloadError) {
    console.error('Download failed:', error.message);
  } else if (error instanceof InsufficientResourcesError) {
    console.error('Not enough disk space:', error.message);
    console.log('Suggestion:', error.details.suggestion);
  } else if (error instanceof ChecksumError) {
    console.error('File corrupted:', error.message);
  }
}
```

---

## Examples

### Complete Download Workflow

```typescript
import { modelManager, systemInfo } from 'genai-electron';

try {
  const model = await modelManager.downloadModel({
    source: 'huggingface',
    repo: 'TheBloke/Llama-2-7B-GGUF',
    file: 'llama-2-7b.Q4_K_M.gguf',
    name: 'Llama 2 7B Q4',
    type: 'llm',
    onProgress: (downloaded, total) => {
      console.log(`${((downloaded / total) * 100).toFixed(1)}%`);
    }
  });

  console.log('Layers:', model.ggufMetadata?.block_count);
  console.log('Context:', model.ggufMetadata?.context_length);
  console.log('Supports reasoning:', model.supportsReasoning);

  const canRun = await systemInfo.canRunModel(model);
  if (!canRun.possible) {
    console.warn('Model may not run:', canRun.reason);
  }
} catch (error) {
  if (error instanceof InsufficientResourcesError) {
    console.error('Not enough disk space');
  } else if (error instanceof DownloadError) {
    console.error('Download failed:', error.message);
  }
}
```

---

## What's Next?

- **[LLM Server](llm-server.md)** - Use downloaded models to run LLMs
- **[System Detection](system-detection.md)** - Check model compatibility with your system
