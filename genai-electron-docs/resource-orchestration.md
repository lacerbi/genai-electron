# Resource Orchestration

Automatically manage system resources when running both LLM and image generation servers simultaneously. ResourceOrchestrator handles temporary LLM offload/reload when memory is constrained.

## Navigation

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Automatic vs Manual Usage](#automatic-vs-manual-usage)
- [API Reference](#api-reference)
- [Example Scenarios](#example-scenarios)

---

## Overview

`ResourceOrchestrator` provides automatic resource management between LLM and image generation servers. When system resources (RAM or VRAM) are constrained, it automatically:
1. Detects if offload is needed
2. Saves LLM server state and stops it (frees memory)
3. Generates the image
4. Restarts LLM server with saved configuration

**Note**: When using the singleton `diffusionServer`, orchestration happens automatically - you typically don't need to use `ResourceOrchestrator` directly. This class is primarily for advanced use cases like custom orchestrator instances or programmatic resource status checking.

**When to use:**
- Running both llama-server and diffusion server on limited RAM/VRAM
- Want automatic LLM offload/reload during image generation
- Need to ensure enough memory for image generation without manual management

**When NOT needed:**
- System has ample resources (>= 24GB VRAM or >= 32GB RAM)
- Only running one server at a time
- Using separate machines for LLM and diffusion

---

## How It Works

### Bottleneck Detection

**GPU Systems:** Uses VRAM as bottleneck if GPU is available
**CPU-Only Systems:** Uses RAM as bottleneck

### Resource Estimation

**LLM Usage:**
- **GPU mode:** `VRAM = model_size * (gpu_layers / total_layers) * 1.2`
- **CPU mode:** `RAM = model_size * 1.2`

**Diffusion Usage:**
- `RAM/VRAM = model_size * 1.2`

### Offload Decision

- **Combined usage > 75% of available resource** → Offload LLM, generate image, reload LLM
- **Combined usage ≤ 75% of available resource** → Generate directly without offload

### Offload/Reload Cycle

1. Check if LLM server is running
2. If running, save configuration (modelId, port, threads, gpuLayers, etc.)
3. Stop LLM server gracefully (frees memory)
4. Generate image
5. Restart LLM server with exact same configuration
6. Clear saved state

---

## Automatic vs Manual Usage

### Automatic (Built into Singleton)

The singleton `diffusionServer` has built-in orchestration - no additional code needed:

```typescript
import { llamaServer, diffusionServer } from 'genai-electron';

// Start both servers
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
await diffusionServer.start({ modelId: 'sdxl-turbo', port: 8081 });

// Generate image - automatic resource management included
const result = await diffusionServer.generateImage({
  prompt: 'A beautiful sunset over mountains',
  width: 1024,
  height: 1024,
  steps: 30
});

// LLM server automatically offloaded if needed, then reloaded
console.log('Image generated, LLM still running');
```

**Important:** Batch generation (count > 1) currently bypasses orchestration. Planned for Phase 3.

---

## API Reference

### Constructor

```typescript
new ResourceOrchestrator(
  systemInfo?: SystemInfo,
  llamaServer: LlamaServerManager,
  diffusionServer: DiffusionServerManager,
  modelManager?: ModelManager
)
```

**Parameters:**
- `systemInfo?: SystemInfo` - Optional, defaults to singleton
- `llamaServer: LlamaServerManager` - **Required**
- `diffusionServer: DiffusionServerManager` - **Required**
- `modelManager?: ModelManager` - Optional, defaults to singleton

### orchestrateImageGeneration(config)

Generates an image with automatic resource management.

**Parameters:** `ImageGenerationConfig` - Same as `DiffusionServerManager.generateImage()`

**Returns:** `Promise<ImageGenerationResult>`

**Behavior:**
- If resources ample: Generates directly without offload
- If resources constrained: Offloads LLM → generates → reloads LLM
- Uses 75% availability threshold

### wouldNeedOffload()

Checks if generating an image would require offloading the LLM server.

**Returns:** `Promise<boolean>`

**Example:**
```typescript
const needsOffload = await orchestrator.wouldNeedOffload();

if (needsOffload) {
  console.log('⚠️  Image generation will temporarily stop LLM');
  console.log('LLM will be automatically reloaded after generation');
} else {
  console.log('✅ Enough resources - both servers can run simultaneously');
}

// Proceed with generation
const result = await orchestrator.orchestrateImageGeneration({
  prompt: 'A landscape painting',
  steps: 30
});
```

**Use cases:**
- Warn users about temporary LLM unavailability
- Decide whether to defer image generation
- Display resource status in UI

### getSavedState()

Gets the saved LLM state if the server was offloaded.

**Returns:** `SavedLLMState | undefined`

**SavedLLMState Interface:**
```typescript
interface SavedLLMState {
  config: ServerConfig;   // Original LLM configuration
  wasRunning: boolean;    // Whether LLM was running before offload
  savedAt: Date;          // When state was saved
}
```

**Example:**
```typescript
const savedState = orchestrator.getSavedState();

if (savedState) {
  console.log('LLM was offloaded at:', savedState.savedAt);
  console.log('Original model:', savedState.config.modelId);
  console.log('Original port:', savedState.config.port);
  console.log('GPU layers:', savedState.config.gpuLayers);
  console.log('Was running:', savedState.wasRunning);
} else {
  console.log('No LLM state saved (not offloaded)');
}
```

### clearSavedState()

Clears any saved LLM state. Use if you don't want LLM to be automatically reloaded.

**Returns:** `void`

**Example:**
```typescript
// Generate image with offload
await orchestrator.orchestrateImageGeneration({
  prompt: 'A mountain landscape',
  steps: 30
});

// Prevent automatic LLM reload for next generation
orchestrator.clearSavedState();

// Next generation won't reload LLM
await orchestrator.orchestrateImageGeneration({
  prompt: 'A city skyline',
  steps: 30
});
```

---

## Example Scenarios

**1. GPU System with 8GB VRAM (Offload Needed)**:
   - LLM: 4.2GB VRAM, Diffusion: 8.3GB VRAM
   - Combined: 12.5GB > 8GB × 0.75 (6GB) → **Offload** ✅
   - Stops LLM, generates image, restarts LLM

**2. GPU System with 24GB VRAM (No Offload)**:
   - LLM: 4.2GB VRAM, Diffusion: 8.3GB VRAM
   - Combined: 12.5GB < 24GB × 0.75 (18GB) → **No offload** ✅
   - Generates directly without stopping LLM

**3. CPU-Only System with 16GB RAM (Offload Needed)**:
   - LLM: 4.2GB RAM, Diffusion: 8.3GB RAM
   - Combined: 12.5GB > 16GB × 0.75 (12GB) → **Offload** ✅
   - Stops LLM, generates image, restarts LLM

---

## See Also

- [Image Generation](image-generation.md) - DiffusionServerManager API
- [LLM Server](llm-server.md) - LlamaServerManager API
- [System Detection](system-detection.md) - Hardware capability detection
- [Model Management](model-management.md) - Model size information
