# Model Management

The `ModelManager` class handles model downloading, storage, and management for both LLM and diffusion models.

---

## Table of Contents

- [Overview](#overview)
- [Import](#import)
- [Core Operations](#core-operations)
  - [listModels()](#listmodels)
  - [downloadModel()](#downloadmodel)
  - [Multi-Component Model Downloads](#multi-component-model-downloads)
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

**Note**: GGUF metadata is automatically extracted before downloading. For single-file downloads, metadata extraction failure is fatal (throws `DownloadError`). For multi-component downloads, metadata extraction is optional — failure is silently ignored since the primary file may not be a GGUF file.

---

### Multi-Component Model Downloads

Some diffusion models require multiple files to work together (e.g., diffusion model + text encoder + VAE). ModelManager supports downloading multi-component models by providing a `components` array in the download config.

**How it works**:
- The top-level `source`/`repo`/`file` (or `url`) describes the primary diffusion model
- Each entry in `components` describes an additional component with its own source
- Components have a `role` field (e.g., `'llm'`, `'vae'`, `'clip'`) identifying their purpose
- All files are stored in a per-model subdirectory under the diffusion models folder
- Progress reporting aggregates across all components (smooth 0→100%)
- If any component download fails, all downloaded files are cleaned up automatically

**Component Roles** (`DiffusionComponentRole`):
- `'diffusion_model'` - Main UNet/DiT (`--diffusion-model`)
- `'clip_l'` - CLIP-L text encoder (`--clip_l`)
- `'clip_g'` - CLIP-G text encoder, SDXL (`--clip_g`)
- `'t5xxl'` - T5-XXL text encoder, SD3/Flux 1 (`--t5xxl`)
- `'llm'` - LLM text encoder, Flux 2 (`--llm`)
- `'llm_vision'` - LLM vision encoder, Qwen Image (`--llm_vision`)
- `'vae'` - VAE decoder (`--vae`)

**Example: Downloading Flux 2 Klein**:

```typescript
const modelInfo = await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'leejet/FLUX.2-klein-4B-GGUF',
  file: 'flux-2-klein-4b-Q8_0.gguf',
  name: 'Flux 2 Klein',
  type: 'diffusion',
  components: [
    {
      role: 'llm',
      source: 'huggingface',
      repo: 'unsloth/Qwen3-4B-GGUF',
      file: 'Qwen3-4B-Q4_0.gguf',
    },
    {
      role: 'vae',
      source: 'url',
      url: 'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors',
    },
  ],
  onProgress: (downloaded, total) => {
    console.log(`${((downloaded / total) * 100).toFixed(1)}%`);
  },
});

console.log('Total size:', (modelInfo.size / 1024 / 1024 / 1024).toFixed(2), 'GB');
console.log('Components:', Object.keys(modelInfo.components || {}));
// Output: Components: ['diffusion_model', 'llm', 'vae']
```

**Storage Layout**:

Multi-component models are stored in a per-model subdirectory:

```
userData/models/diffusion/
  sdxl-turbo.json              # metadata (monolithic model)
  sdxl-turbo.safetensors       # model file (monolithic model)
  flux-2-klein/                # per-model directory (multi-component)
    flux-2-klein-4b-Q8_0.gguf # primary diffusion model
    Qwen3-4B-Q4_0.gguf        # LLM text encoder component
    flux2-vae.safetensors      # VAE component
  flux-2-klein.json            # metadata with components map
```

**Metadata Structure**:

For multi-component models, `ModelInfo.components` contains a map of component roles to component metadata:

```typescript
// ModelInfo with DiffusionModelComponents (Partial<Record<DiffusionComponentRole, DiffusionComponentInfo>>)
{
  id: 'flux-2-klein',
  name: 'Flux 2 Klein',
  type: 'diffusion',
  size: 7600000000,  // aggregate size across all components
  path: '/path/to/userData/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf',
  components: {
    diffusion_model: {
      path: '/path/to/userData/models/diffusion/flux-2-klein/flux-2-klein-4b-Q8_0.gguf',
      size: 4300000000,
      checksum: 'sha256:abc123...',
    },
    llm: {
      path: '/path/to/userData/models/diffusion/flux-2-klein/Qwen3-4B-Q4_0.gguf',
      size: 2500000000,
      checksum: 'sha256:def456...',
    },
    vae: {
      path: '/path/to/userData/models/diffusion/flux-2-klein/flux2-vae.safetensors',
      size: 335000000,
    }
  }
}
```

**GGUF Metadata Extraction**:
- GGUF metadata is only extracted for the primary diffusion model if it's a `.gguf` file
- Non-GGUF primary models (`.safetensors`) skip metadata extraction entirely
- Component files do not have GGUF metadata extracted (only the primary model)

**Checksum Verification**:

Each component can have its own checksum for integrity verification:

```typescript
const modelInfo = await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'leejet/FLUX.2-klein-4B-GGUF',
  file: 'flux-2-klein-4b-Q8_0.gguf',
  name: 'Flux 2 Klein',
  type: 'diffusion',
  checksum: 'abc123...',  // checksum for primary model
  components: [
    {
      role: 'llm',
      source: 'huggingface',
      repo: 'unsloth/Qwen3-4B-GGUF',
      file: 'Qwen3-4B-Q4_0.gguf',
      checksum: 'def456...',  // checksum for LLM component
    },
    {
      role: 'vae',
      source: 'url',
      url: 'https://...',
      checksum: 'ghi789...',  // checksum for VAE component
    },
  ],
});
```

**Error Handling and Cleanup**:

If any component download fails, all already-downloaded files are automatically cleaned up to prevent partial installations:

```typescript
try {
  const model = await modelManager.downloadModel({
    // ... multi-component config
  });
} catch (error) {
  if (error instanceof DownloadError) {
    console.error('Component download failed:', error.message);
    // All partial files have been cleaned up automatically
  }
}
```

**Shared Variant Downloads**:

Multiple quant variants of the same model can share a directory and reuse identical component files (e.g., the LLM encoder and VAE). Use `modelDirectory` to specify a shared subdirectory name independent of the model ID:

```typescript
// Download Q8_0 variant
await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'leejet/FLUX.2-klein-4B-GGUF',
  file: 'flux-2-klein-4b-Q8_0.gguf',
  name: 'Flux 2 Klein Q8_0',           // Variant-specific name → distinct model ID
  type: 'diffusion',
  modelDirectory: 'flux-2-klein',       // Shared directory for all variants
  components: [
    { role: 'llm', source: 'huggingface', repo: 'unsloth/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_0.gguf' },
    { role: 'vae', source: 'url', url: 'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors' },
  ],
});

// Download Q4_0 variant — shared LLM and VAE are automatically reused (not re-downloaded)
await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'leejet/FLUX.2-klein-4B-GGUF',
  file: 'flux-2-klein-4b-Q4_0.gguf',
  name: 'Flux 2 Klein Q4_0',
  type: 'diffusion',
  modelDirectory: 'flux-2-klein',       // Same shared directory
  components: [
    { role: 'llm', source: 'huggingface', repo: 'unsloth/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_0.gguf' },
    { role: 'vae', source: 'url', url: 'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors' },
  ],
});
```

When a component file already exists on disk, it is skipped (with checksum verification if a checksum is provided — mismatched files are deleted and re-downloaded). Deleting one variant preserves shared component files that are still referenced by other variants.

**Per-Component Progress Tracking**:

Use the `onComponentStart` callback to show which component is currently downloading:

```typescript
await modelManager.downloadModel({
  // ... config
  onComponentStart: ({ role, filename, index, total }) => {
    console.log(`Downloading component ${index}/${total}: ${filename} (${role})`);
  },
  onProgress: (downloaded, total) => {
    console.log(`${((downloaded / total) * 100).toFixed(1)}%`);
  },
});
```

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

**Multi-component models**: When deleting a multi-component model that shares a directory with other variants (via `modelDirectory`), only component files unique to the deleted model are removed. Shared component files still referenced by other models are preserved.

---

### verifyModel()

Verifies model file integrity using stored checksum.

```typescript
verifyModel(id: string): Promise<boolean>
```

**Parameters**:
- `id: string` - Model ID to verify

**Returns**: `Promise<boolean>` - `true` if checksum matches, `false` if no checksum was stored (cannot verify)

**Throws**:
- `ModelNotFoundError` if model doesn't exist
- `ChecksumError` if checksum doesn't match (file corrupted or tampered)
- `FileSystemError` if a multi-component model has missing component files

**Example**:
```typescript
try {
  const isValid = await modelManager.verifyModel('llama-2-7b');

  if (isValid) {
    console.log('✅ Model file is valid');
  } else {
    console.log('⚠️ No checksum stored — cannot verify integrity');
  }
} catch (error) {
  if (error instanceof ChecksumError) {
    console.log('❌ Model file is corrupted or tampered with');
    console.log('Consider re-downloading the model');
  } else if (error instanceof FileSystemError) {
    console.log('❌ Missing component file in multi-component model');
  }
}
```

**Multi-component models**: Each component's checksum is verified individually. Throws `FileSystemError` if any component file is missing from disk. Throws `ChecksumError` on the first component mismatch.

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
const parsed = await fetchGGUFMetadata('https://huggingface.co/.../model.gguf');
// parsed.metadata is a Record<string, unknown> of all GGUF key-value pairs

// Read metadata from local file
const localParsed = await fetchLocalGGUFMetadata('/path/to/model.gguf');

// Extract architecture-specific fields from parsed metadata
const blockCount = getArchField(parsed.metadata, 'block_count');
const contextLength = getArchField(parsed.metadata, 'context_length');
const arch = parsed.metadata['general.architecture'];
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
    // error.details is typed as `unknown` — narrow before accessing properties
    const details = error.details as { suggestion?: string } | undefined;
    if (details?.suggestion) {
      console.log('Suggestion:', details.suggestion);
    }
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
