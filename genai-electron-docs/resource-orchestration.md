# Resource Orchestration

Automatically manage system resources when running both LLM and image generation servers simultaneously. ResourceOrchestrator handles temporary LLM offload/reload when memory is constrained.

## Navigation

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Automatic vs Manual Usage](#automatic-vs-manual-usage)
- [API Reference](#api-reference)
- [Resource Estimation](#resource-estimation)
- [Example Scenarios](#example-scenarios)

---

## Overview

`ResourceOrchestrator` provides automatic resource management between LLM and image generation servers. When system resources (RAM or VRAM) are constrained, it automatically:
1. Detects if offload is needed
2. Saves LLM server state and stops it (frees memory)
3. Generates the image
4. Restarts LLM server with saved configuration

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

### Manual (Custom Instances)

For custom `ResourceOrchestrator` instances or advanced control:

```typescript
import { ResourceOrchestrator } from 'genai-electron';
import { systemInfo, llamaServer, diffusionServer, modelManager } from 'genai-electron';

const orchestrator = new ResourceOrchestrator(
  systemInfo,
  llamaServer,
  diffusionServer,
  modelManager
);

// Check if offload would be needed
const needsOffload = await orchestrator.wouldNeedOffload();
if (needsOffload) {
  console.log('⚠️  Image generation will temporarily stop LLM');
}

// Generate with automatic management
const result = await orchestrator.orchestrateImageGeneration({
  prompt: 'A landscape painting',
  width: 1024,
  height: 1024,
  steps: 30
});

console.log('Image generated successfully');
```

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

**Example:**
```typescript
const result = await orchestrator.orchestrateImageGeneration({
  prompt: 'A futuristic city at night',
  negativePrompt: 'blurry, low quality',
  width: 1024,
  height: 1024,
  steps: 50,
  onProgress: (currentStep, totalSteps, stage, percentage) => {
    console.log(`${stage}: ${Math.round(percentage || 0)}%`);
  }
});

await fs.promises.writeFile('city.png', result.image);
```

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

## Resource Estimation

### Estimation Formulas

**LLM Resource Usage:**
- **GPU mode (gpuLayers > 0):**
  ```
  VRAM = model_size * (gpu_layers / total_layers) * 1.2
  ```
- **CPU mode (gpuLayers = 0):**
  ```
  RAM = model_size * 1.2
  ```

**Diffusion Resource Usage:**
```
RAM/VRAM = model_size * 1.2
```

The 1.2 multiplier accounts for:
- Model overhead (attention caches, temporary buffers)
- Operating system overhead
- Safety margin

### Bottleneck Detection

**GPU Systems:**
- Bottleneck: VRAM (GPU memory)
- Check: `(llm_vram + diffusion_vram) > available_vram * 0.75`

**CPU-Only Systems:**
- Bottleneck: RAM (system memory)
- Check: `(llm_ram + diffusion_ram) > available_ram * 0.75`

---

## Example Scenarios

### Scenario 1: 8GB VRAM (Offload Needed)

**System:** NVIDIA RTX 3060 (8GB VRAM)

**LLM:** Llama 2 7B Q4 (3.5GB file)
- GPU mode with 32/32 layers offloaded
- VRAM usage: `3.5GB * (32/32) * 1.2 = 4.2GB`

**Diffusion:** SDXL Turbo (6.9GB file)
- VRAM usage: `6.9GB * 1.2 = 8.3GB`

**Combined:** `4.2GB + 8.3GB = 12.5GB`
**Threshold:** `8GB * 0.75 = 6GB`

**Result:** `12.5GB > 6GB` → **Offload needed** ✅

**Behavior:**
1. Stop LLM (frees 4.2GB VRAM → 3.8GB available)
2. Generate image (needs 8.3GB, but model loads on-demand after offload)
3. Restart LLM with same config

### Scenario 2: 24GB VRAM (No Offload)

**System:** NVIDIA RTX 4090 (24GB VRAM)

**LLM:** Llama 2 7B Q4 (3.5GB file)
- VRAM usage: `4.2GB`

**Diffusion:** SDXL Turbo (6.9GB file)
- VRAM usage: `8.3GB`

**Combined:** `4.2GB + 8.3GB = 12.5GB`
**Threshold:** `24GB * 0.75 = 18GB`

**Result:** `12.5GB < 18GB` → **No offload needed** ✅

**Behavior:** Generate directly without stopping LLM

### Scenario 3: 16GB RAM CPU-Only (Offload Needed)

**System:** CPU-only, 16GB RAM

**LLM:** Llama 2 7B Q4 (3.5GB file)
- CPU mode (gpuLayers = 0)
- RAM usage: `3.5GB * 1.2 = 4.2GB`

**Diffusion:** SDXL Turbo (6.9GB file)
- RAM usage: `6.9GB * 1.2 = 8.3GB`

**Combined:** `4.2GB + 8.3GB = 12.5GB`
**Threshold:** `16GB * 0.75 = 12GB`

**Result:** `12.5GB > 12GB` → **Offload needed** ✅

**Behavior:** Stop LLM (frees 4.2GB) → generate → restart LLM

---

## Limitations

### Batch Generation

**Current:** Batch generation (count > 1 via HTTP API) bypasses orchestration and runs without offload.

**Planned:** Phase 3 will add orchestration support for batch generation.

**Workaround:** For now, use single-image generation (count = 1 or omit) for automatic orchestration.

---

## See Also

- [Image Generation](image-generation.md) - DiffusionServerManager API
- [LLM Server](llm-server.md) - LlamaServerManager API
- [System Detection](system-detection.md) - Hardware capability detection
- [Model Management](model-management.md) - Model size information
