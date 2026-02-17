# Example: Control Panel

Reference implementation demonstrating genai-electron integration patterns for infrastructure management.

## Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Key Patterns](#key-patterns)
- [Multi-Component & Preset Patterns](#multi-component--preset-patterns)
- [Advanced Patterns](#advanced-patterns)
- [Running the Example](#running-the-example)
- [Using for Testing](#using-for-testing)

---

## Overview

**Location**: `examples/electron-control-panel/`

**Purpose**: Reference implementation for developers building with genai-electron. Think "system monitor" not "chat app."

**Not a Tutorial**: This document shows patterns to study in the code, not step-by-step instructions.

**Demonstrates**:
- System detection, model management, server lifecycle
- Real-time resource monitoring, event-driven UI updates
- IPC communication, integration with genai-lite

---

## Features

**System Info**: Hardware detection (CPU/RAM/GPU), auto-refreshes every 5s, updates on server events

**Model Management**: Download (HuggingFace/URL), list/delete models, **GGUF Metadata Viewer** with auto-fetch and smart truncation for 50k+ item arrays, **Preset Downloads** (Flux 2 Klein, SDXL Lightning) with per-component progress, multi-component badge in model list

**LLM Server**: Start/stop/restart with auto-config or manual mode, real-time logs, test chat, health monitoring

**Diffusion Server**: Start/stop, generate images with full parameter control (prompt, dimensions, steps, samplers), real-time progress, metadata display, preset-matched recommended settings with one-click apply

**Resource Monitor**: Memory polling (2s), GPU/VRAM tracking, server status grid, resource orchestration status, event log (20 events), debug tools

---

## Architecture

**Tech Stack**: Electron + React + TypeScript + Vite

**Structure**: `main/` (Node.js: window, IPC handlers, genai wrappers) + `renderer/` (Browser: React components, custom hooks, types, data)

**IPC**: Main ↔ Renderer via `ipcMain.handle()` + `contextBridge.exposeInMainWorld()`, events via `webContents.send()`

---

## Key Patterns

Patterns to study in the actual code (file locations provided):

### Pattern: Custom Hooks for Separation of Concerns

**Challenge**: Keep components clean by extracting data fetching and state management.

**Solution** (`renderer/components/hooks/`):
```typescript
// Six custom hooks, each managing a specific domain:
// - useSystemInfo.ts: System detection + 5s polling + event listeners
// - useModels.ts: Model list management
// - useServerStatus.ts: Server status tracking
// - useServerLogs.ts: Log streaming
// - useDiffusionServer.ts: Image generation state
// - useResourceMonitor.ts: Resource usage + 2s polling
```

**Key insight**: Hooks co-locate related logic (fetching + polling + event listeners) away from UI code.

---

### Pattern: System Info Polling + Event-Driven Updates

**Challenge**: Keep system info current without constant polling overhead.

**Solution** (`renderer/components/hooks/useSystemInfo.ts:59-93`):
```typescript
// Poll every 5 seconds
useEffect(() => {
  fetchSystemInfo();
  const interval = setInterval(fetchSystemInfo, 5000);
  return () => clearInterval(interval);
}, []);

// ALSO listen to server events for immediate updates (memory changes)
useEffect(() => {
  const handleServerEvent = () => fetchSystemInfo();

  window.api.on('server:started', handleServerEvent);
  window.api.on('server:stopped', handleServerEvent);
  window.api.on('diffusion:started', handleServerEvent);
  window.api.on('diffusion:stopped', handleServerEvent);

  return () => {
    window.api.off('server:started');
    // ... cleanup other listeners
  };
}, []);
```

**Key insight**: Hybrid approach - regular polling for baseline + events for immediate feedback when servers change memory usage.

---

### Pattern: Server Event Forwarding

**Challenge**: Forward EventEmitter events from main process to renderer for reactive UI.

**Solution** (`main/genai-api.ts:27-94`):
```typescript
export function setupServerEventForwarding(): void {
  // LLM server events
  llamaServer.on('started', () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('server:started');
    }
  });

  llamaServer.on('stopped', () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('server:stopped');
    }
  });

  llamaServer.on('crashed', (data: { code: number | null; signal: string | null }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('server:crashed', {
        message: `Server crashed with exit code ${data.code}`,
        code: data.code,
        signal: data.signal,
      });
    }
  });

  // Same pattern for diffusionServer events...
}
```

**Key insight**: Gets window dynamically on each event to avoid timing issues if forwarding setup runs before window creation.

---

### Pattern: Model Download Progress Streaming

**Challenge**: Show real-time download progress from main process in renderer UI.

**Solution** (`main/ipc-handlers.ts:80-100`):
```typescript
ipcMain.handle('models:download', async (_event, config) => {
  const modelName = config.name || 'Unknown Model';

  await modelManager.downloadModel({
    ...config,
    onProgress: (downloaded: number, total: number) => {
      sendDownloadProgress(downloaded, total, modelName);
    },
  });

  sendDownloadComplete(config.name, modelName);
});

// Helper function (genai-api.ts:99-109)
export function sendDownloadProgress(downloaded: number, total: number, modelName: string): void {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (mainWindow) {
    mainWindow.webContents.send('download:progress', {
      downloaded,
      total,
      modelName,
      percentage: total > 0 ? (downloaded / total) * 100 : 0,
    });
  }
}
```

**Key insight**: IPC handler wraps async operation and forwards progress via separate IPC events, not return values.

**Multi-component models**: For per-component progress tracking (which component is currently downloading), see [Per-Component Download Progress](#pattern-per-component-download-progress-ipc-flow) below.

---

### Pattern: Smart JSON Truncation for Large Arrays

**Challenge**: GGUF metadata can contain 50k+ item arrays that crash JSON viewers.

**Solution** (`renderer/components/GGUFInfoModal.tsx:20-49`):
```typescript
function truncateLargeValues(value: unknown, maxArrayItems = 20, maxStringLength = 500): unknown {
  // Handle arrays
  if (Array.isArray(value)) {
    if (value.length > maxArrayItems) {
      const truncated = value.slice(0, maxArrayItems);
      const remaining = value.length - maxArrayItems;
      return [...truncated, `... (${remaining.toLocaleString()} more items)`];
    }
    return value.map((item) => truncateLargeValues(item, maxArrayItems, maxStringLength));
  }

  // Handle objects - recurse
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = truncateLargeValues(val, maxArrayItems, maxStringLength);
    }
    return result;
  }

  // Handle strings
  if (typeof value === 'string' && value.length > maxStringLength) {
    const remaining = value.length - maxStringLength;
    return value.substring(0, maxStringLength) + `... (${remaining.toLocaleString()} more chars)`;
  }

  return value;
}
```

**Key insight**: Recursive truncation preserves structure while preventing UI freeze. Shows "... (49,980 more items)" indicator.

---

### Pattern: Structured Log Parsing for UI

**Challenge**: Display server logs with filtering by level and formatted timestamps.

**Solution** (`renderer/components/common/LogViewer.tsx:38-60`):
```typescript
// Map log levels to CSS classes
const getLevelClass = (level: string | undefined): string => {
  if (!level) return 'log-info';
  const lowerLevel = level.toLowerCase();
  if (lowerLevel === 'debug') return 'log-debug';
  if (lowerLevel === 'info') return 'log-info';
  if (lowerLevel === 'warn') return 'log-warn';
  if (lowerLevel === 'error') return 'log-error';
  return 'log-info';
};

// Filter logs based on debug toggle
const visibleLogs = logs.filter((log) => {
  if (log.level?.toLowerCase() === 'debug' && !showDebug) {
    return false;
  }
  return true;
});
```

**Key insight**: Uses `getStructuredLogs()` API (returns `{timestamp, level, message}` objects) instead of raw strings for easy filtering and formatting.

---

## Multi-Component & Preset Patterns

Patterns for multi-component diffusion model downloads, presets, and settings hints:

### Pattern: Preset Data Separation

**Challenge**: Support one-click downloads for multi-component models without hardcoding UI logic.

**Solution** (`renderer/data/model-presets.ts`):
```typescript
export interface ModelPreset {
  id: string;
  name: string;
  description: string;
  type: 'llm' | 'diffusion';
  primary: {
    source: 'huggingface' | 'url';
    repo?: string;
    variants: PresetVariant[];
  };
  components: PresetComponent[];     // Additional files (text encoder, VAE, etc.)
  recommendedSettings?: PresetRecommendedSettings;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'flux-2-klein',
    name: 'Flux 2 Klein',
    description: 'Fast Flux 2 image generation with Qwen3-4B text encoder. 3 components.',
    type: 'diffusion',
    primary: {
      source: 'huggingface',
      repo: 'leejet/FLUX.2-klein-4B-GGUF',
      variants: [
        { label: 'Q8_0 (~4.3 GB)', file: 'flux-2-klein-4b-Q8_0.gguf', sizeGB: 4.3 },
        { label: 'Q4_0 (~2.5 GB)', file: 'flux-2-klein-4b-Q4_0.gguf', sizeGB: 2.5 },
      ],
    },
    components: [
      { role: 'llm', label: 'Text Encoder (Qwen3-4B base)', source: 'huggingface', /* ... */ },
      { role: 'vae', label: 'VAE (Flux 2, 32ch)', source: 'url', fixedUrl: '...', fixedSizeGB: 0.34 },
    ],
    recommendedSettings: { steps: 4, cfgScale: 1, sampler: 'euler', width: 768, height: 768 },
  },
  // ... additional presets (SDXL Lightning, etc.)
];
```

**Key insight**: Adding a new preset requires only a data entry — no UI code changes.

---

### Pattern: Preset-to-DownloadConfig Translation

**Challenge**: Convert user-selected preset + variant choices into a library `DownloadConfig`.

**Solution** (`renderer/components/ModelDownloadForm.tsx:64-104`):
```typescript
const handlePresetDownload = async () => {
  if (!selectedPreset) return;

  const primaryVariant = selectedPreset.primary.variants[getVariantIndex('primary')];
  if (!primaryVariant) return;

  // Include variant tag in name so each quant gets a distinct model entry
  const variantTag = primaryVariant.label.split(' ')[0]; // "Q8_0" from "Q8_0 (~4.3 GB)"
  const config: DownloadConfig = {
    source: selectedPreset.primary.source,
    repo: selectedPreset.primary.repo,
    file: primaryVariant.file,
    name: `${selectedPreset.name} ${variantTag}`,
    type: selectedPreset.type,
    modelDirectory: selectedPreset.id, // Share directory across variants
  };

  // Build components array for multi-component presets
  if (selectedPreset.components.length > 0) {
    config.components = selectedPreset.components.map((comp) => {
      if (comp.variants) {
        const variant = comp.variants[getVariantIndex(comp.role)];
        return { role: comp.role, source: comp.source, repo: comp.repo, file: variant?.file };
      }
      return { role: comp.role, source: comp.source, url: comp.fixedUrl };
    });
  }

  await onDownload(config);
};
```

**Key insight**: `modelDirectory: preset.id` enables shared storage across quant variants; variant tag in the name gives each quant its own model entry.

---

### Pattern: Per-Component Download Progress (IPC Flow)

**Challenge**: Show which component is downloading during multi-file downloads.

**Solution**: Full IPC flow from library callback to renderer display.

1. **IPC handler** registers `onComponentStart` callback (`main/ipc-handlers.ts:92-99`):
```typescript
await modelManager.downloadModel({
  ...config,
  onProgress: (downloaded: number, total: number) => {
    sendDownloadProgress(downloaded, total, modelName);
  },
  onComponentStart: (info: { role: string; filename: string; index: number; total: number }) => {
    sendComponentStart(info.role, info.filename, info.index, info.total, modelName);
  },
});
```

2. **Main → Renderer** helper sends IPC event (`main/genai-api.ts:139-156`):
```typescript
export function sendComponentStart(
  role: string, filename: string, index: number, total: number, modelName: string
): void {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (mainWindow) {
    mainWindow.webContents.send('download:component-start', {
      role, filename, index, total, modelName,
    });
  }
}
```

3. **Renderer display** (`renderer/components/ModelDownloadForm.tsx:244-249`):
```typescript
{componentProgress && componentProgress.total > 1 && (
  <p className="component-status">
    Component {componentProgress.index}/{componentProgress.total}: {componentProgress.filename}
  </p>
)}
```

**Key insight**: `componentProgress` state lives in the parent `ModelManager.tsx` to avoid the preload `removeAllListeners` collision — same reason download progress is centralized there (see next pattern).

---

### Pattern: Centralized Download State Management

**Challenge**: Multiple hooks registering for the same IPC channel causes silent listener destruction (preload calls `removeAllListeners` before each `on()`).

**Solution** (`renderer/components/ModelManager.tsx:16-42`):
```typescript
// Download state — centralized here (not in individual hooks) to avoid
// the preload removeAllListeners collision when two hooks register for
// the same IPC channels.
const [downloading, setDownloading] = useState(false);
const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
const [componentProgress, setComponentProgress] = useState<ComponentProgress | null>(null);

// Single IPC listener registration for download progress events
useEffect(() => {
  if (!window.api || !window.api.on) return;

  window.api.on('download:progress', (progress: DownloadProgress) => {
    setDownloadProgress(progress);
  });

  window.api.on('download:component-start', (data: ComponentProgress) => {
    setComponentProgress(data);
  });

  return () => {
    if (window.api && window.api.off) {
      window.api.off('download:progress');
      window.api.off('download:component-start');
    }
  };
}, []);
```

**Key insight**: This is a general Electron IPC pattern — when the preload uses `removeAllListeners` before adding a listener, only one component can register per channel. Centralize all listeners in a shared parent.

---

### Pattern: Multi-Component Badge in Model List

**Challenge**: Visually distinguish multi-component models from single-file models in the list.

**Solution** (`renderer/components/ModelList.tsx:82-93`):
```typescript
<td>
  <span className={`model-type-badge model-type-${model.type}`}>
    {model.type === 'llm' ? 'LLM' : 'Diffusion'}
  </span>
  {model.components && (
    <span
      className="model-type-badge model-type-components"
      title={Object.keys(model.components).join(', ')}
    >
      {Object.keys(model.components).length} components
    </span>
  )}
</td>
```

**Key insight**: `Object.keys(model.components).length` gives the component count; tooltip shows role names (e.g., "llm, vae").

---

### Pattern: Preset-Matched Settings Hint

**Challenge**: When a model from a preset is selected, suggest optimal generation parameters.

**Solution** (`renderer/components/DiffusionServerControl.tsx:193-324`):
```typescript
// Match selected model to a preset for recommended settings
const matchedPreset = MODEL_PRESETS.find((p) => selectedModel.startsWith(p.id));

const applyPresetSettings = (settings: PresetRecommendedSettings) => {
  setSteps(settings.steps);
  setStepsPreset(String(settings.steps));
  setCfgScale(settings.cfgScale);
  // Integer-to-float formatting for CFG scale dropdowns (1 → "1.0")
  setCfgPreset(settings.cfgScale % 1 === 0 ? `${settings.cfgScale}.0` : String(settings.cfgScale));
  setSampler(settings.sampler as ImageSampler);
  if (settings.width && settings.height) {
    setWidth(settings.width);
    setHeight(settings.height);
    setDimensionPreset(`${settings.width}\u00d7${settings.height}`);
  }
};

// Hint banner in JSX:
{matchedPreset?.recommendedSettings && (
  <div className="settings-hint">
    <span>
      {matchedPreset.name} recommended: Steps {matchedPreset.recommendedSettings.steps},
      CFG {matchedPreset.recommendedSettings.cfgScale},
      {matchedPreset.recommendedSettings.sampler} sampler
      {matchedPreset.recommendedSettings.width && matchedPreset.recommendedSettings.height &&
        `, ${matchedPreset.recommendedSettings.width}\u00d7${matchedPreset.recommendedSettings.height}`}
    </span>
    <button type="button" className="apply-preset-btn"
      onClick={() => applyPresetSettings(matchedPreset.recommendedSettings!)}>
      Apply
    </button>
  </div>
)}
```

**Key insight**: `applyPresetSettings` updates both actual values AND preset selector states (bidirectional sync), including integer-to-float formatting for CFG scale dropdowns.

---

## Advanced Patterns

Critical patterns for production Electron apps with AI integration:

### Pattern: Type-Safe IPC Bridge with Security

**Challenge**: Expose main process APIs to renderer securely with full type safety.

**Solution** (`main/preload.ts:1-157`):
```typescript
// Expose APIs via context bridge
contextBridge.exposeInMainWorld('api', {
  // Group by domain for clarity
  system: {
    detect: () => ipcRenderer.invoke('system:detect'),
    getMemory: () => ipcRenderer.invoke('system:getMemory'),
    getGPU: () => ipcRenderer.invoke('system:getGPU'),
  },

  models: {
    list: (type: string) => ipcRenderer.invoke('models:list', type),
    download: (config: unknown) => ipcRenderer.invoke('models:download', config),
  },

  // Event listeners with channel whitelisting
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const validChannels = [
      'download:progress', 'download:complete', 'download:error',
      'download:component-start',
      'server:started', 'server:stopped', 'server:crashed', 'server:binary-log',
      'diffusion:started', 'diffusion:stopped', 'diffusion:crashed',
      'diffusion:binary-log', 'diffusion:progress',
    ];

    if (validChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel); // Prevent duplicates!
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    } else {
      console.error(`Invalid channel: ${channel}`);
    }
  },

  off: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});

// Export TypeScript types for renderer
export type WindowAPI = {
  system: { detect: () => Promise<unknown>; /* ... */ };
  models: { list: (type: string) => Promise<unknown[]>; /* ... */ };
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  off: (channel: string) => void;
};
```

**Key insights**:
- **Channel whitelisting** prevents arbitrary IPC calls (security best practice)
- **`removeAllListeners()` before adding** prevents duplicate listeners on hot reload
- **Grouped API structure** mirrors domain separation (system, models, server, etc.)
- **Type exports** enable full TypeScript safety in renderer (`window.api.models.list()` is typed)

---

### Pattern: genai-lite Integration (LLM)

**Challenge**: Use genai-lite's LLMService with genai-electron-managed llama-server.

**Solution** (`main/ipc-handlers.ts:202-231`):
```typescript
ipcMain.handle('server:testMessage', async (_event, message: string, settings?: unknown) => {
  // Create LLMService instance (llamacpp doesn't need API keys)
  const llmService = new LLMService(async () => 'not-needed');

  // Check server is running
  const serverInfo = llamaServer.getInfo();
  if (serverInfo.status !== 'running' || !serverInfo.port) {
    throw new Error('Server is not running');
  }

  // Use genai-lite API with llamacpp provider
  const response = await llmService.sendMessage({
    providerId: 'llamacpp',
    modelId: serverInfo.modelId || 'unknown-model',
    messages: [{ role: 'user', content: message }],
    settings: settings || {},
  });

  return response; // Returns chat.completion object
});
```

**Key insights**:
- genai-electron manages server (start/stop/health), genai-lite provides API
- `llamacpp` provider connects to locally-running server (port from genai-electron)
- No API key needed (`async () => 'not-needed'` callback)
- Response format is OpenAI-compatible (`chat.completion` object)

---

### Pattern: genai-lite Integration (Image Generation)

**Challenge**: Use genai-lite's ImageService with genai-electron-managed diffusion server, forward progress updates to renderer.

**Solution** (`main/ipc-handlers.ts:287-327`):
```typescript
ipcMain.handle('diffusion:generate', async (_event, config) => {
  // Create ImageService instance
  const imageService = new ImageService(async () => 'not-needed');

  // Check diffusion server is running
  const serverInfo = diffusionServer.getInfo();
  if (serverInfo.status !== 'running') {
    throw new Error('Diffusion server is not running');
  }

  // Generate image using genai-lite
  const result = await imageService.generateImage({
    providerId: 'genai-electron-images', // Special provider for local generation
    modelId: 'stable-diffusion',
    prompt: config.prompt,
    settings: {
      width: config.width || 512,
      height: config.height || 512,
      diffusion: {
        negativePrompt: config.negativePrompt,
        steps: config.steps || 20,
        cfgScale: config.cfgScale || 7.5,
        seed: config.seed || -1,
        sampler: config.sampler || 'euler_a',

        // Forward progress to renderer via IPC events
        onProgress: (progress) => {
          sendImageProgress(
            progress.currentStep,
            progress.totalSteps,
            progress.stage,
            progress.percentage
          );
        },
      },
    },
  });

  return result; // Contains base64 image data
});
```

**Key insights**:
- `genai-electron-images` is special provider (not cloud service)
- Progress callback forwards updates via `webContents.send()` to renderer
- Same ImageService API works for both cloud (DALL-E, etc.) and local generation
- Automatic resource orchestration (LLM offload) happens transparently

---

### Pattern: Reasoning Extraction

**Challenge**: Display reasoning content separately from response, handle empty responses from thinking models.

**Solution** (`renderer/components/TestChat.tsx:52-72`):
```typescript
const result = await window.api.server.testMessage(message, { maxTokens, temperature });

if (result.object === 'chat.completion') {
  const choice = result.choices[0];

  // Extract reasoning if present (thinking models)
  if (choice.reasoning) {
    setReasoning(choice.reasoning);
  }

  const content = choice.message?.content || '';

  // Thinking models may return empty content if max_tokens too low
  if (!content || content.trim().length === 0) {
    setError(
      `Model returned empty response. This often happens with thinking models when ` +
      `max_tokens is too low. Try increasing max_tokens to ${maxTokens + 500} or higher.`
    );
    setResponse('');
  } else {
    setResponse(content);
  }
}
```

**Key insights**:
- `choice.reasoning` contains thinking process (separate from final answer)
- Empty content common with reasoning models + low max_tokens
- Provide actionable error messages with specific suggestions
- Display reasoning separately in UI (collapsible section)

---

### Pattern: Preset UI with Custom Fallback

**Challenge**: User-friendly presets for common parameter values + flexibility for custom inputs.

**Solution** (`renderer/components/DiffusionServerControl.tsx:94-131`):
```typescript
// State for preset selector and actual values
const [dimensionPreset, setDimensionPreset] = useState('512×512');
const [width, setWidth] = useState(512);
const [height, setHeight] = useState(512);

const handleDimensionPresetChange = (value: string) => {
  setDimensionPreset(value);
  if (value !== 'Custom') {
    // Parse preset (e.g., "512×512" or "1024×1024")
    const [w, h] = value.split('×').map(Number);
    setWidth(w);
    setHeight(h);
  }
  // If 'Custom', keep current width/height values
};

// In UI:
// <select> with options: ['512×512', '768×768', '1024×1024', 'Custom']
// When Custom selected: show manual width/height number inputs
```

**Key insights**:
- Bidirectional sync: preset changes → update values, manual changes → switch to "Custom"
- Same pattern for steps (1/2/4/8/20/30), cfgScale (1.0/2.0/7.5/10.0/15.0), seed (Random/-1, Fixed values)
- Reduces cognitive load for common cases while allowing full control

---

### Pattern: Binary Log Capture During Startup

**Challenge**: Show startup diagnostics for debugging failures without cluttering running logs.

**Solution** (`renderer/components/DiffusionServerControl.tsx:61-92`):
```typescript
const [binaryLogs, setBinaryLogs] = useState<Array<BinaryLogEvent & { timestamp: Date }>>([]);

// Capture binary logs during startup
useEffect(() => {
  const handleBinaryLog = (data: BinaryLogEvent) => {
    setBinaryLogs((prev) => [...prev, { ...data, timestamp: new Date() }]);
  };

  window.api.on('diffusion:binary-log', handleBinaryLog);
  return () => window.api.off('diffusion:binary-log');
}, []);

// Clear logs when server reaches running state
useEffect(() => {
  if (serverInfo.status === 'running') {
    setBinaryLogs([]); // Startup complete, clear diagnostic logs
  }
}, [serverInfo.status]);
```

**Key insights**:
- Binary logs show model loading, tensor initialization, CUDA setup
- Useful for debugging "server won't start" issues
- Clear when running to avoid confusion between startup and runtime logs
- Same pattern works for LLM server (`server:binary-log` event)

---

### Pattern: Electron + ESM Gotcha

**Challenge**: Electron requires CommonJS for main/preload, but `"type": "module"` in package.json makes all `.js` files ESM.

**Solution** (`vite.main.config.ts` + `vite.preload.config.ts`):
```typescript
// vite.main.config.ts
export default {
  build: {
    lib: {
      formats: ['cjs'], // Force CommonJS output
      fileName: () => 'main.cjs', // Must use .cjs extension!
    },
    rollupOptions: {
      output: { format: 'cjs' }, // Ensure CommonJS
    },
  },
};

// vite.preload.config.ts (same pattern)
export default {
  build: {
    lib: {
      formats: ['cjs'],
      fileName: () => 'preload.cjs', // Not .js!
    },
    rollupOptions: {
      output: { format: 'cjs' },
    },
  },
};

// package.json
{
  "type": "module", // Makes .js → ESM
  "main": ".vite/build/main.cjs" // Must reference .cjs file
}

// main/index.ts
const preloadPath = join(__dirname, 'preload.cjs'); // Not 'preload.js'!
```

**Key insights**:
- Without `.cjs` extension: "Unable to load preload script" or "exports is not defined" errors
- Renderer process can use ESM (runs in browser context)
- Only affects apps with `"type": "module"` in package.json
- Documented in CLAUDE.md for reference

---

## Running the Example

**Prerequisites**: Node.js 22.x, platform requirements (see [Installation and Setup](installation-and-setup.md))

```bash
cd examples/electron-control-panel
npm install
npm run dev  # Development mode with hot reload (UI on http://localhost:3100)
```

**Production**: `npm run build && npm run package`

---

## Using for Testing

Test genai-electron changes interactively:

1. Make changes to genai-electron source
2. Rebuild: `cd /path/to/genai-electron && npm run build`
3. Restart control panel
4. Test via UI (visual feedback, DevTools debugging)

---

## Integration with genai-lite

**genai-electron**: Manages infrastructure (servers, binaries, resources via `modelManager`, `llamaServer`, `diffusionServer`, `systemInfo`)

**genai-lite**: Provides unified API (`LLMService`, `ImageService`) for actual AI calls

Control panel's test chat is minimal (verifies server works). For advanced chat features, see genai-lite's chat-demo.

---

## See Also

- **App README**: `examples/electron-control-panel/README.md` (complete setup details)
- [Integration Guide](integration-guide.md) - IPC patterns and best practices
- [Model Management](model-management.md), [LLM Server](llm-server.md), [Image Generation](image-generation.md), [Resource Orchestration](resource-orchestration.md)
