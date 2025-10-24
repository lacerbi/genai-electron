# Example: Control Panel

Reference implementation demonstrating genai-electron integration patterns for infrastructure management.

## Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Key Patterns](#key-patterns)
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

**Model Management**: Download (HuggingFace/URL), list/delete models, **GGUF Metadata Viewer** with auto-fetch and smart truncation for 50k+ item arrays

**LLM Server**: Start/stop/restart with auto-config or manual mode, real-time logs, test chat, health monitoring

**Diffusion Server**: Start/stop, generate images with full parameter control (prompt, dimensions, steps, samplers), real-time progress, metadata display

**Resource Monitor**: Memory polling (2s), GPU/VRAM tracking, server status grid, resource orchestration status, event log (20 events), debug tools

---

## Architecture

**Tech Stack**: Electron + React + TypeScript + Vite

**Structure**: `main/` (Node.js: window, IPC handlers, genai wrappers) + `renderer/` (Browser: React components, custom hooks, types)

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
    window.api.off('server:started', handleServerEvent);
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

  llamaServer.on('crashed', (error: Error) => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      mainWindow.webContents.send('server:crashed', {
        message: error.message,
        stack: error.stack,
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
      'server:started', 'server:stopped', 'server:crashed',
      'diffusion:started', 'diffusion:stopped', 'diffusion:progress',
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
- Same pattern for steps (20/30/50), cfgScale (5.0/7.5/10.0), seed (Random/-1, Fixed values)
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
