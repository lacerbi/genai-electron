# Phase 2 Implementation Plan: electron-control-panel

> **Target**: Add Image Generation and Resource Monitoring capabilities
> **Status**: Phase 1 Complete → Phase 2 Planning
> **Version**: 0.2.0
> **Last Updated**: 2025-10-19

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Architecture Overview](#architecture-overview)
4. [Implementation Steps](#implementation-steps)
5. [API Reference](#api-reference)
6. [Testing Guide](#testing-guide)
7. [Troubleshooting](#troubleshooting)
8. [Future Work](#future-work)

---

## Overview

### What is Phase 2?

Phase 2 adds **image generation** and **resource monitoring** capabilities to the electron-control-panel example app. This phase demonstrates genai-electron's ability to:

- Manage stable-diffusion.cpp server lifecycle
- Generate images locally via HTTP API
- Automatically orchestrate resources between LLM and image generation
- Visualize resource usage and offload/reload events in real-time

### What Phase 2 Adds

**Two New Tabs:**

1. **Diffusion Server Tab**: Start/stop diffusion server, generate images, view progress
2. **Resource Monitor Tab**: Real-time resource usage, automatic offload/reload visualization

**Key Features:**
- ✅ Start/stop HTTP wrapper for stable-diffusion.cpp
- ✅ Generate images with progress tracking
- ✅ Automatic LLM offload when resources are constrained
- ✅ Automatic LLM reload after image generation completes
- ✅ Real-time memory usage visualization (RAM and VRAM)
- ✅ Event timeline showing resource transitions

### Important: Direct HTTP Calls (Not genai-lite)

**For Phase 2 initial implementation**, we will use **direct HTTP calls** to communicate with the diffusion server's HTTP wrapper. This is because:

- ✅ genai-lite does **not yet have** an image generation API
- ✅ The HTTP API is simple and well-defined
- ✅ Future integration with genai-lite will be straightforward (swap fetch() calls)

**We will integrate genai-lite's image API in a future phase** when it becomes available.

### Phase 1 Recap (Already Complete)

Before starting Phase 2, verify Phase 1 is working:

- ✅ **System Info Tab**: Shows CPU, RAM, GPU, VRAM detection
- ✅ **Models Tab**: Download/delete LLM models, disk usage tracking
- ✅ **LLM Server Tab**: Start/stop llama-server, test chat, view logs

---

## Prerequisites

### Required Knowledge

- TypeScript and React basics
- Electron IPC communication (main ↔ renderer)
- Async/await patterns
- HTTP fetch API
- CSS styling

### Verify Phase 1 is Complete

```bash
# From examples/electron-control-panel directory
npm start

# Verify all 3 tabs load without errors:
# 1. System Info tab shows hardware detection
# 2. Models tab can list models
# 3. LLM Server tab can start/stop server
```

### Library Version Check

Ensure you're using genai-electron **v0.2.0** or later (Phase 2 complete):

```bash
# In examples/electron-control-panel
cat ../../package.json | grep '"version"'
# Should show: "version": "0.2.0" or higher
```

### Development Environment

- Node.js 22.x or later
- npm 10.x or later
- Electron 34.x or later (installed via package.json)

---

## Architecture Overview

### Component Hierarchy

```
App.tsx
├── SystemInfo (Phase 1)
├── ModelManager (Phase 1)
├── LlamaServerControl (Phase 1)
├── DiffusionServerControl (NEW - Phase 2)
│   ├── ServerStatusSection
│   ├── ImageGenerationForm
│   └── ImageDisplay
└── ResourceMonitor (NEW - Phase 2)
    ├── MemoryUsageSection
    ├── ResourceTimelineChart
    └── EventLogSection
```

### IPC Communication Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Renderer Process                         │
│  ┌──────────────────┐        ┌──────────────────┐          │
│  │ DiffusionServer  │        │ ResourceMonitor  │          │
│  │    Control       │        │                  │          │
│  └────────┬─────────┘        └────────┬─────────┘          │
│           │                           │                     │
│           │ IPC Calls                 │ IPC Calls          │
│           ▼                           ▼                     │
└───────────┼───────────────────────────┼─────────────────────┘
            │                           │
            │ window.api.diffusion.*    │ window.api.resources.*
            │                           │
┌───────────▼───────────────────────────▼─────────────────────┐
│                    Main Process                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              ipc-handlers.ts                         │  │
│  │  • diffusion:start                                   │  │
│  │  • diffusion:stop                                    │  │
│  │  • diffusion:generate (HTTP fetch to wrapper)        │  │
│  │  • diffusion:status                                  │  │
│  │  • resources:getUsage                                │  │
│  │  • resources:orchestrateGeneration                   │  │
│  └────────────┬─────────────────────────────────────────┘  │
│               │                                             │
│               ▼                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         genai-electron library                       │  │
│  │  • diffusionServer.start()                           │  │
│  │  • diffusionServer.stop()                            │  │
│  │  • ResourceOrchestrator.orchestrateImageGeneration() │  │
│  │  • systemInfo.getMemoryInfo()                        │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### genai-electron Phase 2 APIs

**DiffusionServerManager** (singleton: `diffusionServer`):

```typescript
import { diffusionServer } from 'genai-electron';

// Start HTTP wrapper server
await diffusionServer.start({
  modelId: string,      // Required: Model ID from modelManager.listModels('diffusion')
  port?: number,        // Optional: Default 8081
  threads?: number,     // Optional: CPU threads (auto-detected if omitted)
  gpuLayers?: number    // Optional: GPU layers to offload (auto-detected if omitted)
});

// Stop server
await diffusionServer.stop();

// Get server info
const info = diffusionServer.getInfo(); // Returns DiffusionServerInfo

// Check health
const healthy = await diffusionServer.isHealthy();

// Get logs
const logs = await diffusionServer.getLogs(100); // Last 100 lines

// Clear logs
await diffusionServer.clearLogs();

// Generate image (direct method call OR via HTTP)
const result = await diffusionServer.generateImage({
  prompt: string,
  negativePrompt?: string,
  width?: number,        // Default: 512
  height?: number,       // Default: 512
  steps?: number,        // Default: 20
  cfgScale?: number,     // Default: 7.5
  seed?: number,         // Default: -1 (random)
  sampler?: ImageSampler, // Default: 'euler_a'
  onProgress?: (currentStep: number, totalSteps: number) => void
});
```

**ResourceOrchestrator**:

```typescript
import { ResourceOrchestrator, systemInfo, llamaServer, diffusionServer, modelManager } from 'genai-electron';

// Create orchestrator
const orchestrator = new ResourceOrchestrator(
  systemInfo,      // SystemInfo instance
  llamaServer,     // LlamaServerManager instance
  diffusionServer, // DiffusionServerManager instance
  modelManager     // ModelManager instance (optional, defaults to singleton)
);

// Generate image with automatic resource management
// If resources are constrained, LLM will be offloaded automatically
const result = await orchestrator.orchestrateImageGeneration({
  prompt: string,
  width?: number,
  height?: number,
  steps?: number,
  cfgScale?: number,
  seed?: number,
  sampler?: ImageSampler,
  onProgress?: (step: number, total: number) => void
});

// Check if offload would be needed
const needsOffload = await orchestrator.wouldNeedOffload();

// Get saved LLM state (if offloaded)
const savedState = orchestrator.getSavedState(); // Returns SavedLLMState | undefined

// Clear saved state
orchestrator.clearSavedState();
```

### HTTP API Endpoints (Diffusion Server Wrapper)

The `diffusionServer.start()` creates an HTTP wrapper server on the specified port (default: 8081). This server exposes two endpoints:

#### `GET /health`

**Purpose**: Check server status and availability

**Response**:
```json
{
  "status": "ok",
  "busy": false
}
```

#### `POST /v1/images/generations`

**Purpose**: Generate an image

**Request Body**:
```json
{
  "prompt": "A serene mountain landscape at sunset",
  "negativePrompt": "blurry, low quality",
  "width": 1024,
  "height": 1024,
  "steps": 30,
  "cfgScale": 7.5,
  "seed": 12345,
  "sampler": "euler_a"
}
```

**Response**:
```json
{
  "image": "base64-encoded-png-data...",
  "format": "png",
  "timeTaken": 45678,
  "seed": 12345,
  "width": 1024,
  "height": 1024
}
```

**Error Response**:
```json
{
  "error": "Server is busy generating another image"
}
```

### TypeScript Types Reference

```typescript
// Image generation configuration
interface ImageGenerationConfig {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: number;
  sampler?: ImageSampler;
  onProgress?: (currentStep: number, totalSteps: number) => void;
}

// Image generation result
interface ImageGenerationResult {
  image: Buffer;        // Raw image data
  format: 'png';
  timeTaken: number;    // Milliseconds
  seed: number;
  width: number;
  height: number;
}

// Diffusion server status
interface DiffusionServerInfo {
  status: ServerStatus; // 'running' | 'stopped' | 'starting' | 'stopping' | 'crashed'
  health: HealthStatus; // 'ok' | 'error' | 'unknown'
  pid?: number;
  port: number;
  modelId: string;
  startedAt?: string;   // ISO timestamp
  error?: string;
  busy?: boolean;       // True if currently generating
}

// Resource orchestrator saved state
// Note: The library returns Date, but IPC serializes it to ISO string
interface SavedLLMState {
  config: ServerConfig;
  wasRunning: boolean;
  savedAt: Date;  // Library returns Date; serialize to string for IPC transport
}

// Available samplers
type ImageSampler =
  | 'euler_a'
  | 'euler'
  | 'heun'
  | 'dpm2'
  | 'dpm++2s_a'
  | 'dpm++2m'
  | 'dpm++2mv2'
  | 'lcm';
```

---

## Implementation Steps

### Step 1: Add IPC Handlers (Main Process)

**File**: `examples/electron-control-panel/main/ipc-handlers.ts`

Add the following handlers after the existing server handlers:

```typescript
// ========================================
// Diffusion Server Handlers (Phase 2)
// ========================================

import { diffusionServer } from './genai-api.js';

ipcMain.handle('diffusion:start', async (_event, config) => {
  try {
    await diffusionServer.start(config);
  } catch (error) {
    throw new Error(`Failed to start diffusion server: ${(error as Error).message}`);
  }
});

ipcMain.handle('diffusion:stop', async () => {
  try {
    await diffusionServer.stop();
  } catch (error) {
    throw new Error(`Failed to stop diffusion server: ${(error as Error).message}`);
  }
});

ipcMain.handle('diffusion:status', () => {
  try {
    return diffusionServer.getInfo();
  } catch (error) {
    throw new Error(`Failed to get diffusion server status: ${(error as Error).message}`);
  }
});

ipcMain.handle('diffusion:health', async () => {
  try {
    return await diffusionServer.isHealthy();
  } catch (error) {
    throw new Error(`Failed to check diffusion server health: ${(error as Error).message}`);
  }
});

ipcMain.handle('diffusion:logs', async (_event, limit: number) => {
  try {
    const logStrings = await diffusionServer.getLogs(limit);

    // Parse log strings into LogEntry objects
    return logStrings.map((logLine) => {
      const parsed = LogManager.parseEntry(logLine);

      if (!parsed) {
        return {
          timestamp: new Date().toISOString(),
          level: 'info',
          message: logLine,
        };
      }

      return parsed;
    });
  } catch (error) {
    throw new Error(`Failed to get diffusion server logs: ${(error as Error).message}`);
  }
});

ipcMain.handle('diffusion:clearLogs', async () => {
  try {
    await diffusionServer.clearLogs();
  } catch (error) {
    throw new Error(`Failed to clear diffusion logs: ${(error as Error).message}`);
  }
});

// Generate image via HTTP (not using diffusionServer.generateImage directly)
// This demonstrates the HTTP API pattern for when genai-lite integration happens
ipcMain.handle('diffusion:generate', async (_event, config, port: number = 8081) => {
  try {
    // Make HTTP request to diffusion server wrapper
    const response = await fetch(`http://localhost:${port}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: config.prompt,
        negativePrompt: config.negativePrompt,
        width: config.width || 512,
        height: config.height || 512,
        steps: config.steps || 20,
        cfgScale: config.cfgScale || 7.5,
        seed: config.seed || -1,
        sampler: config.sampler || 'euler_a',
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Image generation failed');
    }

    const result = await response.json();

    // Convert base64 image to data URL for renderer
    return {
      imageDataUrl: `data:image/png;base64,${result.image}`,
      timeTaken: result.timeTaken,
      seed: result.seed,
      width: result.width,
      height: result.height,
    };
  } catch (error) {
    throw new Error(`Failed to generate image: ${(error as Error).message}`);
  }
});

// ========================================
// Resource Orchestrator Handlers (Phase 2)
// ========================================

import { ResourceOrchestrator } from 'genai-electron';

// Create orchestrator instance (initialize once)
let orchestrator: ResourceOrchestrator | null = null;

function getOrchestrator(): ResourceOrchestrator {
  if (!orchestrator) {
    orchestrator = new ResourceOrchestrator(
      systemInfo,
      llamaServer,
      diffusionServer,
      modelManager
    );
  }
  return orchestrator;
}

ipcMain.handle('resources:orchestrateGeneration', async (_event, config) => {
  try {
    const orch = getOrchestrator();
    const result = await orch.orchestrateImageGeneration(config);

    // Convert Buffer to base64 data URL
    return {
      imageDataUrl: `data:image/png;base64,${result.image.toString('base64')}`,
      timeTaken: result.timeTaken,
      seed: result.seed,
      width: result.width,
      height: result.height,
    };
  } catch (error) {
    throw new Error(`Failed to orchestrate image generation: ${(error as Error).message}`);
  }
});

ipcMain.handle('resources:wouldNeedOffload', async () => {
  try {
    const orch = getOrchestrator();
    return await orch.wouldNeedOffload();
  } catch (error) {
    throw new Error(`Failed to check offload requirement: ${(error as Error).message}`);
  }
});

ipcMain.handle('resources:getSavedState', () => {
  try {
    const orch = getOrchestrator();
    const state = orch.getSavedState();

    // Serialize Date to ISO string for IPC transport
    if (state) {
      return {
        ...state,
        savedAt: state.savedAt.toISOString()
      };
    }
    return null;
  } catch (error) {
    throw new Error(`Failed to get saved state: ${(error as Error).message}`);
  }
});

ipcMain.handle('resources:clearSavedState', () => {
  try {
    const orch = getOrchestrator();
    orch.clearSavedState();
  } catch (error) {
    throw new Error(`Failed to clear saved state: ${(error as Error).message}`);
  }
});

ipcMain.handle('resources:getUsage', () => {
  try {
    const memoryInfo = systemInfo.getMemoryInfo();
    const llamaInfo = llamaServer.getInfo();
    const diffusionInfo = diffusionServer.getInfo();

    return {
      memory: memoryInfo,
      llamaServer: llamaInfo,
      diffusionServer: diffusionInfo,
    };
  } catch (error) {
    throw new Error(`Failed to get resource usage: ${(error as Error).message}`);
  }
});
```

**File**: `examples/electron-control-panel/main/genai-api.ts`

Add diffusionServer export:

```typescript
// Add to existing exports
import { diffusionServer as _diffusionServer } from 'genai-electron';

export const diffusionServer = _diffusionServer;

// Also add event forwarding for diffusion server
export function setupServerEventForwarding(): void {
  // ... existing llama server event forwarding ...

  // Diffusion server event forwarding
  diffusionServer.on('started', () => {
    if (mainWindow) {
      mainWindow.webContents.send('diffusion:event', { type: 'started' });
    }
  });

  diffusionServer.on('stopped', () => {
    if (mainWindow) {
      mainWindow.webContents.send('diffusion:event', { type: 'stopped' });
    }
  });

  diffusionServer.on('crashed', (error: Error) => {
    if (mainWindow) {
      mainWindow.webContents.send('diffusion:event', {
        type: 'crashed',
        error: error.message,
      });
    }
  });
}
```

**File**: `examples/electron-control-panel/main/preload.ts`

Add diffusion and resources APIs:

```typescript
// Add to existing contextBridge.exposeInMainWorld('api', { ... })

// Inside the api object:
diffusion: {
  start: (config: any) => ipcRenderer.invoke('diffusion:start', config),
  stop: () => ipcRenderer.invoke('diffusion:stop'),
  getStatus: () => ipcRenderer.invoke('diffusion:status'),
  isHealthy: () => ipcRenderer.invoke('diffusion:health'),
  getLogs: (limit: number) => ipcRenderer.invoke('diffusion:logs', limit),
  clearLogs: () => ipcRenderer.invoke('diffusion:clearLogs'),
  generateImage: (config: any, port?: number) =>
    ipcRenderer.invoke('diffusion:generate', config, port),

  // Event listener with cleanup support
  onEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('diffusion:event', handler);
    // Return cleanup function for useEffect teardown
    return () => ipcRenderer.removeListener('diffusion:event', handler);
  },
},

resources: {
  orchestrateGeneration: (config: any) =>
    ipcRenderer.invoke('resources:orchestrateGeneration', config),
  wouldNeedOffload: () => ipcRenderer.invoke('resources:wouldNeedOffload'),
  getSavedState: () => ipcRenderer.invoke('resources:getSavedState'),
  clearSavedState: () => ipcRenderer.invoke('resources:clearSavedState'),
  getUsage: () => ipcRenderer.invoke('resources:getUsage'),
},
```

**Important: Event Listener Cleanup Pattern**

The `onEvent` methods above now return cleanup functions. Update the components to use them:

```typescript
// In DiffusionServerControl.tsx:
useEffect(() => {
  // ... other setup ...
  const cleanupDiffusionEvents = window.api.diffusion.onEvent(eventHandler);

  return () => {
    clearInterval(interval);
    cleanupDiffusionEvents(); // Cleanup listener on unmount
  };
}, []);

// In ResourceMonitor.tsx:
useEffect(() => {
  // ... other setup ...
  const cleanupLlamaEvents = window.api.server.onEvent(llamaEventHandler);
  const cleanupDiffusionEvents = window.api.diffusion.onEvent(diffusionEventHandler);

  return () => {
    clearInterval(interval);
    cleanupLlamaEvents();      // Cleanup listeners on unmount
    cleanupDiffusionEvents();
  };
}, []);
```

This pattern prevents memory leaks by properly removing event listeners when components unmount.

### Step 2: Add TypeScript Types (Renderer)

**File**: `examples/electron-control-panel/renderer/types/index.ts`

Add Phase 2 types:

```typescript
// Add to existing types

// ========================================
// Phase 2: Image Generation Types
// ========================================

export type ImageSampler =
  | 'euler_a'
  | 'euler'
  | 'heun'
  | 'dpm2'
  | 'dpm++2s_a'
  | 'dpm++2m'
  | 'dpm++2mv2'
  | 'lcm';

export interface ImageGenerationConfig {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: number;
  sampler?: ImageSampler;
}

export interface ImageGenerationResult {
  imageDataUrl: string;  // data:image/png;base64,...
  timeTaken: number;
  seed: number;
  width: number;
  height: number;
}

export interface DiffusionServerInfo {
  status: ServerStatus;
  health: HealthStatus;
  pid?: number;
  port: number;
  modelId: string;
  startedAt?: string;
  error?: string;
  busy?: boolean;
}

export interface SavedLLMState {
  config: any;  // ServerConfig
  wasRunning: boolean;
  savedAt: string;  // ISO timestamp (Date serialized from main process)
}

export interface ResourceUsage {
  memory: {
    total: number;
    available: number;
    used: number;
  };
  llamaServer: {
    status: ServerStatus;
    pid?: number;
    port: number;
  };
  diffusionServer: {
    status: ServerStatus;
    pid?: number;
    port: number;
    busy?: boolean;
  };
}

// Update global window.api interface
declare global {
  interface Window {
    api: {
      // ... existing Phase 1 APIs ...

      // Phase 2: Diffusion Server
      diffusion: {
        start: (config: { modelId: string; port?: number; threads?: number; gpuLayers?: number }) => Promise<void>;
        stop: () => Promise<void>;
        getStatus: () => Promise<DiffusionServerInfo>;
        isHealthy: () => Promise<boolean>;
        getLogs: (limit: number) => Promise<LogEntry[]>;
        clearLogs: () => Promise<void>;
        generateImage: (config: ImageGenerationConfig, port?: number) => Promise<ImageGenerationResult>;
        onEvent: (callback: (event: { type: string; error?: string }) => void) => void;
      };

      // Phase 2: Resources
      resources: {
        orchestrateGeneration: (config: ImageGenerationConfig) => Promise<ImageGenerationResult>;
        wouldNeedOffload: () => Promise<boolean>;
        getSavedState: () => Promise<SavedLLMState | null>;
        clearSavedState: () => Promise<void>;
        getUsage: () => Promise<ResourceUsage>;
      };
    };
  }
}
```

### Step 3: Create Diffusion Server Tab Components

**File**: `examples/electron-control-panel/renderer/components/DiffusionServerControl.tsx`

```typescript
import React, { useState, useEffect } from 'react';
import StatusIndicator from './common/StatusIndicator';
import ActionButton from './common/ActionButton';
import Card from './common/Card';
import Spinner from './common/Spinner';
import type {
  DiffusionServerInfo,
  ModelInfo,
  ImageGenerationConfig,
  ImageGenerationResult
} from '../types';

const DiffusionServerControl: React.FC = () => {
  const [serverInfo, setServerInfo] = useState<DiffusionServerInfo | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  // Image generation state
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [width, setWidth] = useState(512);
  const [height, setHeight] = useState(512);
  const [steps, setSteps] = useState(20);
  const [cfgScale, setCfgScale] = useState(7.5);
  const [sampler, setSampler] = useState<string>('euler_a');
  const [generating, setGenerating] = useState(false);
  const [generatedImage, setGeneratedImage] = useState<ImageGenerationResult | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  // Load models on mount
  useEffect(() => {
    loadModels();
    refreshStatus();

    // Set up event listener with proper cleanup
    // The onEvent method returns a cleanup function for useEffect teardown
    const eventHandler = (event: { type: string; error?: string }) => {
      if (event.type === 'started' || event.type === 'stopped' || event.type === 'crashed') {
        refreshStatus();
      }
    };

    const cleanupDiffusionEvents = window.api.diffusion.onEvent(eventHandler);

    // Poll status every 3 seconds
    const interval = setInterval(refreshStatus, 3000);

    // Cleanup function - prevents memory leaks
    return () => {
      clearInterval(interval);
      cleanupDiffusionEvents(); // Remove event listener on unmount
    };
  }, []);

  const loadModels = async () => {
    try {
      const diffusionModels = await window.api.models.list('diffusion');
      setModels(diffusionModels);
      if (diffusionModels.length > 0 && !selectedModel) {
        setSelectedModel(diffusionModels[0].id);
      }
    } catch (err) {
      console.error('Failed to load models:', err);
    }
  };

  const refreshStatus = async () => {
    try {
      const info = await window.api.diffusion.getStatus();
      setServerInfo(info);
    } catch (err) {
      console.error('Failed to get server status:', err);
    }
  };

  const handleStart = async () => {
    if (!selectedModel) {
      setError('Please select a model');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await window.api.diffusion.start({
        modelId: selectedModel,
        port: 8081,
      });
      await refreshStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    setError('');

    try {
      await window.api.diffusion.stop();
      await refreshStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError('Please enter a prompt');
      return;
    }

    setGenerating(true);
    setError('');
    setProgress({ current: 0, total: steps });

    const config: ImageGenerationConfig = {
      prompt,
      negativePrompt: negativePrompt || undefined,
      width,
      height,
      steps,
      cfgScale,
      sampler: sampler as any,
    };

    try {
      // NOTE: Using HTTP fetch means we only get the result after completion.
      // Progress updates (step-by-step) are not shown in this approach.
      // The UI will show a busy spinner with static "Generating... (0/20)" text.
      //
      // For real-time step updates, you would need to:
      // 1. Call diffusionServer.generateImage() from main process with onProgress callback
      // 2. Stream progress updates via IPC events to renderer
      // 3. Update progress state in response to events
      //
      // Current approach: Simple but no incremental progress feedback
      const result = await window.api.diffusion.generateImage(config, serverInfo?.port);
      setGeneratedImage(result);
      setProgress({ current: steps, total: steps });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const isRunning = serverInfo?.status === 'running';
  const isBusy = serverInfo?.busy || generating;

  return (
    <div className="diffusion-server-control">
      <h2>Diffusion Server Control</h2>

      {/* Server Status */}
      <Card title="Server Status">
        <div className="status-grid">
          <div>
            <label>Status:</label>
            <StatusIndicator
              status={serverInfo?.status || 'stopped'}
              label={serverInfo?.status || 'Stopped'}
            />
          </div>
          <div>
            <label>Health:</label>
            <StatusIndicator
              status={serverInfo?.health === 'ok' ? 'running' : 'stopped'}
              label={serverInfo?.health || 'unknown'}
            />
          </div>
          {serverInfo?.pid && (
            <div>
              <label>PID:</label>
              <span>{serverInfo.pid}</span>
            </div>
          )}
          <div>
            <label>Port:</label>
            <span>{serverInfo?.port || 8081}</span>
          </div>
          {serverInfo?.modelId && (
            <div>
              <label>Model:</label>
              <span>{serverInfo.modelId}</span>
            </div>
          )}
          {serverInfo?.busy && (
            <div>
              <label>Status:</label>
              <span className="busy-indicator">⚙️ Generating...</span>
            </div>
          )}
        </div>

        {error && <div className="error-message">{error}</div>}
      </Card>

      {/* Server Controls */}
      <Card title="Server Configuration">
        <div className="form-group">
          <label htmlFor="diffusion-model">Model:</label>
          <select
            id="diffusion-model"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={isRunning || loading}
          >
            <option value="">Select a model...</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} ({(model.size / 1024 / 1024 / 1024).toFixed(2)} GB)
              </option>
            ))}
          </select>
        </div>

        {models.length === 0 && (
          <p className="info-message">
            No diffusion models found. Download a model in the Models tab first.
          </p>
        )}

        <div className="button-group">
          {!isRunning ? (
            <ActionButton
              onClick={handleStart}
              disabled={loading || !selectedModel}
              variant="primary"
            >
              {loading ? <Spinner size="small" /> : 'Start Server'}
            </ActionButton>
          ) : (
            <ActionButton onClick={handleStop} disabled={loading || isBusy} variant="danger">
              {loading ? <Spinner size="small" /> : 'Stop Server'}
            </ActionButton>
          )}
        </div>
      </Card>

      {/* Image Generation */}
      {isRunning && (
        <Card title="Generate Image">
          <div className="form-group">
            <label htmlFor="prompt">Prompt:</label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="A serene mountain landscape at sunset, 4k, detailed"
              rows={3}
              disabled={generating}
            />
          </div>

          <div className="form-group">
            <label htmlFor="negative-prompt">Negative Prompt (optional):</label>
            <textarea
              id="negative-prompt"
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              placeholder="blurry, low quality, distorted"
              rows={2}
              disabled={generating}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="width">Width:</label>
              <input
                id="width"
                type="number"
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
                min={256}
                max={2048}
                step={64}
                disabled={generating}
              />
            </div>

            <div className="form-group">
              <label htmlFor="height">Height:</label>
              <input
                id="height"
                type="number"
                value={height}
                onChange={(e) => setHeight(Number(e.target.value))}
                min={256}
                max={2048}
                step={64}
                disabled={generating}
              />
            </div>

            <div className="form-group">
              <label htmlFor="steps">Steps:</label>
              <input
                id="steps"
                type="number"
                value={steps}
                onChange={(e) => setSteps(Number(e.target.value))}
                min={1}
                max={150}
                disabled={generating}
              />
            </div>

            <div className="form-group">
              <label htmlFor="cfg-scale">CFG Scale:</label>
              <input
                id="cfg-scale"
                type="number"
                value={cfgScale}
                onChange={(e) => setCfgScale(Number(e.target.value))}
                min={1}
                max={20}
                step={0.5}
                disabled={generating}
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="sampler">Sampler:</label>
            <select
              id="sampler"
              value={sampler}
              onChange={(e) => setSampler(e.target.value)}
              disabled={generating}
            >
              <option value="euler_a">Euler A</option>
              <option value="euler">Euler</option>
              <option value="heun">Heun</option>
              <option value="dpm2">DPM2</option>
              <option value="dpm++2s_a">DPM++ 2S A</option>
              <option value="dpm++2m">DPM++ 2M</option>
              <option value="dpm++2mv2">DPM++ 2Mv2</option>
              <option value="lcm">LCM</option>
            </select>
          </div>

          <ActionButton
            onClick={handleGenerate}
            disabled={generating || !prompt.trim()}
            variant="primary"
          >
            {generating ? (
              <>
                <Spinner size="small" />
                Generating... ({progress.current}/{progress.total} steps)
              </>
            ) : (
              'Generate Image'
            )}
          </ActionButton>
        </Card>
      )}

      {/* Generated Image Display */}
      {generatedImage && (
        <Card title="Generated Image">
          <div className="generated-image-container">
            <img
              src={generatedImage.imageDataUrl}
              alt="Generated"
              className="generated-image"
            />
            <div className="image-metadata">
              <p>
                <strong>Dimensions:</strong> {generatedImage.width}x{generatedImage.height}
              </p>
              <p>
                <strong>Time Taken:</strong> {(generatedImage.timeTaken / 1000).toFixed(2)}s
              </p>
              <p>
                <strong>Seed:</strong> {generatedImage.seed}
              </p>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
};

export default DiffusionServerControl;
```

**Important Note: Downloading Diffusion Models**

The component above calls `window.api.models.list('diffusion')` to load diffusion models, but the existing ModelDownloadForm (in the Models tab) is currently hardcoded to download only LLM models (`type: 'llm'`).

**Required Update: ModelDownloadForm Enhancement**

Update the ModelDownloadForm component to support both model types:
- Add a model type selector (radio buttons or dropdown: "LLM" vs "Diffusion")
- Pass the selected type to the download API call
- Update form validation to handle diffusion model URLs
- This provides centralized model management in a single tab

### Step 4: Create Resource Monitor Tab

**File**: `examples/electron-control-panel/renderer/components/ResourceMonitor.tsx`

```typescript
import React, { useState, useEffect } from 'react';
import Card from './common/Card';
import StatusIndicator from './common/StatusIndicator';
import type { ResourceUsage, SavedLLMState } from '../types';

const ResourceMonitor: React.FC = () => {
  const [usage, setUsage] = useState<ResourceUsage | null>(null);
  const [savedState, setSavedState] = useState<SavedLLMState | null>(null);
  const [wouldOffload, setWouldOffload] = useState(false);
  const [events, setEvents] = useState<Array<{ time: string; message: string }>>([]);

  useEffect(() => {
    // Initial load
    refreshUsage();
    checkOffloadStatus();
    checkSavedState();

    // Poll every 2 seconds
    const interval = setInterval(() => {
      refreshUsage();
      checkOffloadStatus();
      checkSavedState();
    }, 2000);

    // Wire up event listeners for LLM and diffusion servers
    // This populates the event log with server lifecycle events
    const llamaEventHandler = (event: { type: string; error?: string }) => {
      switch (event.type) {
        case 'started':
          addEvent('LLM Server started');
          break;
        case 'stopped':
          addEvent('LLM Server stopped');
          break;
        case 'crashed':
          addEvent(`LLM Server crashed: ${event.error || 'Unknown error'}`);
          break;
      }
    };

    const diffusionEventHandler = (event: { type: string; error?: string }) => {
      switch (event.type) {
        case 'started':
          addEvent('Diffusion Server started');
          break;
        case 'stopped':
          addEvent('Diffusion Server stopped');
          break;
        case 'crashed':
          addEvent(`Diffusion Server crashed: ${event.error || 'Unknown error'}`);
          break;
      }
    };

    // Subscribe to events - returns cleanup functions
    const cleanupLlamaEvents = window.api.server.onEvent(llamaEventHandler);
    const cleanupDiffusionEvents = window.api.diffusion.onEvent(diffusionEventHandler);

    // Cleanup function - prevents memory leaks
    return () => {
      clearInterval(interval);
      cleanupLlamaEvents();      // Remove LLM server listener
      cleanupDiffusionEvents();  // Remove diffusion server listener
    };
  }, []);

  const refreshUsage = async () => {
    try {
      const data = await window.api.resources.getUsage();
      setUsage(data);
    } catch (err) {
      console.error('Failed to get resource usage:', err);
    }
  };

  const checkOffloadStatus = async () => {
    try {
      const needsOffload = await window.api.resources.wouldNeedOffload();
      setWouldOffload(needsOffload);
    } catch (err) {
      console.error('Failed to check offload status:', err);
    }
  };

  const checkSavedState = async () => {
    try {
      const state = await window.api.resources.getSavedState();
      setSavedState(state);
    } catch (err) {
      console.error('Failed to get saved state:', err);
    }
  };

  const addEvent = (message: string) => {
    const time = new Date().toLocaleTimeString();
    setEvents((prev) => [{ time, message }, ...prev].slice(0, 20));
  };

  const formatBytes = (bytes: number): string => {
    const gb = bytes / 1024 / 1024 / 1024;
    return `${gb.toFixed(2)} GB`;
  };

  const formatPercentage = (used: number, total: number): string => {
    return ((used / total) * 100).toFixed(1);
  };

  if (!usage) {
    return <div>Loading resource data...</div>;
  }

  const memUsedGB = (usage.memory.total - usage.memory.available) / 1024 / 1024 / 1024;
  const memTotalGB = usage.memory.total / 1024 / 1024 / 1024;
  const memUsedPercent = ((memUsedGB / memTotalGB) * 100).toFixed(1);

  const llamaRunning = usage.llamaServer.status === 'running';
  const diffusionRunning = usage.diffusionServer.status === 'running';

  return (
    <div className="resource-monitor">
      <h2>Resource Monitor</h2>

      {/* Memory Usage */}
      <Card title="System Memory Usage">
        <div className="memory-usage">
          <div className="memory-bar">
            <div
              className="memory-bar-fill"
              style={{ width: `${memUsedPercent}%` }}
            >
              {memUsedPercent}%
            </div>
          </div>
          <div className="memory-stats">
            <div>
              <strong>Total:</strong> {formatBytes(usage.memory.total)}
            </div>
            <div>
              <strong>Used:</strong> {formatBytes(usage.memory.total - usage.memory.available)}
            </div>
            <div>
              <strong>Available:</strong> {formatBytes(usage.memory.available)}
            </div>
          </div>
        </div>
      </Card>

      {/* Server Status */}
      <Card title="Server Status">
        <div className="server-status-grid">
          <div className="server-status-item">
            <StatusIndicator
              status={llamaRunning ? 'running' : 'stopped'}
              label="LLM Server"
            />
            {llamaRunning && (
              <div className="server-details">
                <p>Port: {usage.llamaServer.port}</p>
                <p>PID: {usage.llamaServer.pid}</p>
              </div>
            )}
          </div>

          <div className="server-status-item">
            <StatusIndicator
              status={diffusionRunning ? 'running' : 'stopped'}
              label="Diffusion Server"
            />
            {diffusionRunning && (
              <div className="server-details">
                <p>Port: {usage.diffusionServer.port}</p>
                <p>PID: {usage.diffusionServer.pid}</p>
                {usage.diffusionServer.busy && (
                  <p className="busy-indicator">⚙️ Generating image...</p>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Resource Orchestration Status */}
      <Card title="Resource Orchestration">
        <div className="orchestration-status">
          <div className="orchestration-item">
            <label>Would Need Offload:</label>
            <span className={wouldOffload ? 'warning' : 'ok'}>
              {wouldOffload ? '⚠️ Yes' : '✅ No'}
            </span>
          </div>

          {savedState && (
            <div className="saved-state">
              <h4>LLM State Saved (Offloaded)</h4>
              <p>
                <strong>Model:</strong> {savedState.config.modelId}
              </p>
              <p>
                <strong>Was Running:</strong> {savedState.wasRunning ? 'Yes' : 'No'}
              </p>
              <p>
                <strong>Saved At:</strong>{' '}
                {new Date(savedState.savedAt).toLocaleString()}
              </p>
              <p className="info-message">
                LLM server will be automatically reloaded after image generation completes.
              </p>
            </div>
          )}

          {!savedState && wouldOffload && (
            <p className="info-message">
              If you generate an image now, the LLM server will be automatically offloaded
              to free up resources, then reloaded after completion.
            </p>
          )}
        </div>
      </Card>

      {/* Event Log */}
      <Card title="Recent Events">
        <div className="event-log">
          {events.length === 0 ? (
            <p className="no-events">No events yet. Start/stop servers or generate images to see events.</p>
          ) : (
            <ul className="event-list">
              {events.map((event, index) => (
                <li key={index}>
                  <span className="event-time">[{event.time}]</span> {event.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
};

export default ResourceMonitor;
```

**Enhancements Needed for Full DESIGN-EXAMPLE-APP.md Compliance:**

The basic ResourceMonitor component above provides core functionality, but DESIGN-EXAMPLE-APP.md specifies additional features:

**1. GPU/VRAM Monitoring:**
- Add GPU detection state from `systemInfo.detect()`
- Display VRAM usage bar (similar to RAM bar)
- Show VRAM allocation per server (LLM vs Diffusion)
- Add IPC handler: `system:getCapabilities` that calls `systemInfo.detect()`

**2. Resource Timeline Visualization:**
- Add state for historical resource data points
- Store snapshots every 2 seconds (last 5 minutes)
- Render ASCII-art or canvas-based timeline chart
- Show memory/VRAM usage over time
- Visualize server start/stop events on timeline

**3. Manual Test Controls:**
- Add "Test Automatic Offload" button
- Triggers image generation while LLM is running
- Demonstrates automatic offload/reload behavior
- Shows real-time resource transitions

**4. Event Logging Integration:**
- Wire up `addEvent()` to actual server events (see Fix #3 below)
- Subscribe to LLM and diffusion server events
- Log resource orchestration events (offload triggered, reload complete)
- Clean up event listeners in useEffect teardown

**Example Enhancement Snippet (GPU/VRAM Display):**

```typescript
// Add to ResourceMonitor component

const [gpuInfo, setGpuInfo] = useState<any>(null);

useEffect(() => {
  // Fetch GPU capabilities once on mount
  window.api.system.getCapabilities().then(caps => {
    setGpuInfo(caps.gpu);
  });
}, []);

// In render:
{gpuInfo && gpuInfo.available && (
  <Card title="GPU Memory Usage (VRAM)">
    <div className="memory-usage">
      <div className="memory-bar">
        <div className="memory-bar-fill" style={{ width: `${vramUsedPercent}%` }}>
          {vramUsedPercent}%
        </div>
      </div>
      <div className="memory-stats">
        <div><strong>Total:</strong> {formatBytes(gpuInfo.vram)}</div>
        <div><strong>Used:</strong> {formatBytes(vramUsed)}</div>
        <div><strong>Available:</strong> {formatBytes(gpuInfo.vram - vramUsed)}</div>
      </div>
    </div>
  </Card>
)}
```

These enhancements are **optional for Phase 2 MVP** but recommended for a complete demonstration of genai-electron's resource management capabilities.

### Step 5: Update App.tsx

**File**: `examples/electron-control-panel/renderer/App.tsx`

Update to include Phase 2 tabs:

```typescript
import React, { useState } from 'react';
import SystemInfo from './components/SystemInfo';
import ModelManager from './components/ModelManager';
import LlamaServerControl from './components/LlamaServerControl';
import DiffusionServerControl from './components/DiffusionServerControl';
import ResourceMonitor from './components/ResourceMonitor';

type TabName = 'system' | 'models' | 'server' | 'diffusion' | 'resources';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabName>('system');

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <h1>genai-electron Control Panel</h1>
        <p className="subtitle">Developer tool for local AI infrastructure management</p>
      </header>

      {/* Tab Navigation */}
      <nav className="tab-nav">
        <button
          className={`tab-button ${activeTab === 'system' ? 'active' : ''}`}
          onClick={() => setActiveTab('system')}
        >
          System Info
        </button>
        <button
          className={`tab-button ${activeTab === 'models' ? 'active' : ''}`}
          onClick={() => setActiveTab('models')}
        >
          Models
        </button>
        <button
          className={`tab-button ${activeTab === 'server' ? 'active' : ''}`}
          onClick={() => setActiveTab('server')}
        >
          LLM Server
        </button>
        <button
          className={`tab-button ${activeTab === 'diffusion' ? 'active' : ''}`}
          onClick={() => setActiveTab('diffusion')}
        >
          Diffusion Server
        </button>
        <button
          className={`tab-button ${activeTab === 'resources' ? 'active' : ''}`}
          onClick={() => setActiveTab('resources')}
        >
          Resources
        </button>
      </nav>

      {/* Tab Content */}
      <main className="tab-content">
        {activeTab === 'system' && <SystemInfo />}
        {activeTab === 'models' && <ModelManager />}
        {activeTab === 'server' && <LlamaServerControl />}
        {activeTab === 'diffusion' && <DiffusionServerControl />}
        {activeTab === 'resources' && <ResourceMonitor />}
      </main>
    </div>
  );
};

export default App;
```

### Step 6: Add Styling

**File**: `examples/electron-control-panel/renderer/styles/global.css`

Add Phase 2 styles at the end of the file:

```css
/* ========================================
   Phase 2: Diffusion Server & Resources
   ======================================== */

/* Diffusion Server Control */
.diffusion-server-control {
  padding: 20px;
}

.generated-image-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
}

.generated-image {
  max-width: 100%;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.image-metadata {
  width: 100%;
  background: var(--bg-secondary);
  padding: 15px;
  border-radius: 8px;
}

.image-metadata p {
  margin: 5px 0;
}

.busy-indicator {
  color: var(--warning);
  font-weight: 600;
}

/* Resource Monitor */
.resource-monitor {
  padding: 20px;
}

.memory-usage {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.memory-bar {
  width: 100%;
  height: 30px;
  background: var(--bg-secondary);
  border-radius: 15px;
  overflow: hidden;
  position: relative;
}

.memory-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary), var(--primary-dark));
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 600;
  font-size: 14px;
  transition: width 0.3s ease;
}

.memory-stats {
  display: flex;
  justify-content: space-between;
  gap: 20px;
}

.memory-stats > div {
  flex: 1;
  padding: 10px;
  background: var(--bg-secondary);
  border-radius: 6px;
  text-align: center;
}

.server-status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 20px;
}

.server-status-item {
  padding: 15px;
  background: var(--bg-secondary);
  border-radius: 8px;
}

.server-details {
  margin-top: 10px;
  font-size: 14px;
  color: var(--text-secondary);
}

.server-details p {
  margin: 5px 0;
}

.orchestration-status {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.orchestration-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background: var(--bg-secondary);
  border-radius: 6px;
}

.orchestration-item .warning {
  color: var(--warning);
  font-weight: 600;
}

.orchestration-item .ok {
  color: var(--success);
  font-weight: 600;
}

.saved-state {
  padding: 15px;
  background: var(--bg-secondary);
  border-radius: 8px;
  border-left: 4px solid var(--warning);
}

.saved-state h4 {
  margin-top: 0;
  color: var(--warning);
}

.saved-state p {
  margin: 8px 0;
}

.event-log {
  max-height: 400px;
  overflow-y: auto;
}

.no-events {
  color: var(--text-secondary);
  font-style: italic;
  text-align: center;
  padding: 20px;
}

.event-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.event-list li {
  padding: 10px;
  border-bottom: 1px solid var(--border);
  font-family: 'Courier New', monospace;
  font-size: 13px;
}

.event-list li:last-child {
  border-bottom: none;
}

.event-time {
  color: var(--text-secondary);
  margin-right: 10px;
}

/* Form Enhancements for Phase 2 */
.form-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 15px;
  margin-bottom: 15px;
}

textarea {
  width: 100%;
  padding: 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
  resize: vertical;
}

textarea:focus {
  outline: none;
  border-color: var(--primary);
}

textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Info and Warning Messages */
.info-message {
  padding: 12px;
  background: rgba(52, 152, 219, 0.1);
  border-left: 4px solid var(--primary);
  border-radius: 6px;
  color: var(--text);
  margin: 10px 0;
}

.warning-message {
  padding: 12px;
  background: rgba(241, 196, 15, 0.1);
  border-left: 4px solid var(--warning);
  border-radius: 6px;
  color: var(--text);
  margin: 10px 0;
}
```

---

## API Reference

### DiffusionServerManager API

**Import**:
```typescript
import { diffusionServer } from 'genai-electron';
```

#### `start(config: DiffusionServerConfig): Promise<void>`

Starts the diffusion HTTP wrapper server.

**Parameters**:
```typescript
{
  modelId: string,        // Required: Model ID from modelManager.listModels('diffusion')
  port?: number,          // Optional: Default 8081
  threads?: number,       // Optional: CPU threads (auto-detected if omitted)
  gpuLayers?: number,     // Optional: GPU layers to offload (auto-detected if omitted)
  vramBudget?: number     // Optional: VRAM budget in MB
}
```

**Example**:
```typescript
await diffusionServer.start({
  modelId: 'sdxl-turbo-q4',
  port: 8081
});
```

#### `stop(): Promise<void>`

Stops the diffusion server and cancels any ongoing generation.

#### `getInfo(): DiffusionServerInfo`

Returns current server information including busy status.

#### `isHealthy(): Promise<boolean>`

Checks if server is running and healthy.

#### `getLogs(lines?: number): Promise<string[]>`

Gets recent server logs (default: 100 lines).

#### `clearLogs(): Promise<void>`

Clears all server logs.

#### `generateImage(config: ImageGenerationConfig): Promise<ImageGenerationResult>`

Generates an image (note: prefer HTTP API for UI integration).

### ResourceOrchestrator API

**Import**:
```typescript
import { ResourceOrchestrator } from 'genai-electron';
```

#### Constructor

```typescript
new ResourceOrchestrator(
  systemInfo: SystemInfo,
  llamaServer: LlamaServerManager,
  diffusionServer: DiffusionServerManager,
  modelManager?: ModelManager
)
```

#### `orchestrateImageGeneration(config: ImageGenerationConfig): Promise<ImageGenerationResult>`

Generates an image with automatic resource management. If resources are constrained:
1. Saves LLM state
2. Stops LLM server
3. Generates image
4. Restarts LLM server with saved config

#### `wouldNeedOffload(): Promise<boolean>`

Checks if image generation would require LLM offload.

#### `getSavedState(): SavedLLMState | undefined`

Returns saved LLM state if currently offloaded.

#### `clearSavedState(): void`

Clears saved LLM state.

### HTTP API Endpoints

#### Health Check: `GET http://localhost:8081/health`

**Response**:
```json
{
  "status": "ok",
  "busy": false
}
```

#### Image Generation: `POST http://localhost:8081/v1/images/generations`

**Request Body**:
```json
{
  "prompt": "A serene mountain landscape at sunset",
  "negativePrompt": "blurry, low quality",
  "width": 1024,
  "height": 1024,
  "steps": 30,
  "cfgScale": 7.5,
  "seed": 12345,
  "sampler": "euler_a"
}
```

**Success Response** (200):
```json
{
  "image": "iVBORw0KGgoAAAANSUhEUgAA...",  // base64 encoded PNG
  "format": "png",
  "timeTaken": 45678,
  "seed": 12345,
  "width": 1024,
  "height": 1024
}
```

**Error Response** (400/500):
```json
{
  "error": "Server is busy generating another image"
}
```

---

## Testing Guide

### Manual Testing Checklist

#### Diffusion Server Tab

1. **Start Server**
   - [ ] Download a diffusion model in Models tab first
   - [ ] Select model from dropdown
   - [ ] Click "Start Server"
   - [ ] Verify status changes to "Running (Healthy)"
   - [ ] Check PID is displayed
   - [ ] Port shows 8081

2. **Generate Image**
   - [ ] Enter prompt: "A serene mountain landscape at sunset"
   - [ ] Enter negative prompt: "blurry, low quality"
   - [ ] Set width/height: 512x512
   - [ ] Set steps: 20
   - [ ] Click "Generate Image"
   - [ ] Verify progress indicator updates
   - [ ] Wait for completion (~30-60 seconds)
   - [ ] Image displays correctly
   - [ ] Metadata shows (time, seed, dimensions)

3. **Error Handling**
   - [ ] Try generating without prompt → shows error
   - [ ] Try starting without selecting model → shows error
   - [ ] Try generating while server stopped → shows error

4. **Stop Server**
   - [ ] Click "Stop Server"
   - [ ] Verify status changes to "Stopped"
   - [ ] PID clears

#### Resource Monitor Tab

1. **Memory Display**
   - [ ] Memory bar shows usage percentage
   - [ ] Total/Used/Available values are accurate
   - [ ] Updates every ~2 seconds

2. **Server Status**
   - [ ] Shows LLM server status correctly
   - [ ] Shows Diffusion server status correctly
   - [ ] PID and port displayed when running
   - [ ] Busy indicator shows during generation

3. **Orchestration Status**
   - [ ] "Would Need Offload" shows correct value
   - [ ] When LLM offloaded, shows saved state
   - [ ] Saved state includes model ID, timestamp

#### Resource Orchestration Testing

**Scenario 1: Sufficient Resources (No Offload)**

1. Start LLM server with small model (7B)
2. Start diffusion server
3. Check Resources tab: "Would Need Offload" = No
4. Generate image
5. Verify LLM server stays running throughout
6. Image generation completes successfully

**Scenario 2: Constrained Resources (Automatic Offload)**

1. Start LLM server with large model or multiple GPU layers
2. Start diffusion server
3. Check Resources tab: "Would Need Offload" = Yes
4. Generate image
5. Verify saved LLM state appears in Resources tab
6. LLM server stops automatically
7. Image generation completes
8. LLM server restarts automatically
9. Saved state clears

### Common Test Scenarios

1. **Download → Start → Generate** (Happy Path)
2. **Start without model** (Error handling)
3. **Generate without server** (Error handling)
4. **Concurrent generation attempts** (Busy handling)
5. **Stop during generation** (Cancellation)
6. **Resource monitor updates** (Polling)

---

## Troubleshooting

### Common Issues

**1. "Failed to start diffusion server: Model not found"**
- **Cause**: No diffusion model downloaded
- **Solution**: Go to Models tab, download a diffusion model first
- **Verify**: Check `models.list('diffusion')` returns at least one model

**2. "Image generation failed: Connection refused"**
- **Cause**: Server not started or crashed
- **Solution**: Check server status, restart if needed
- **Verify**: `diffusionServer.getInfo().status === 'running'`

**3. Generated image doesn't display**
- **Cause**: base64 encoding issue or CORS
- **Solution**: Verify data URL format: `data:image/png;base64,...`
- **Debug**: Check browser console for image load errors

**4. Server shows "busy" but no generation happening**
- **Cause**: Previous generation didn't clean up properly
- **Solution**: Restart server
- **Prevention**: Ensure proper error handling in generateImage

**5. Resource monitor shows incorrect memory usage**
- **Cause**: Stale cache or polling stopped
- **Solution**: Refresh page, check polling interval is active
- **Verify**: Console should show no errors from `resources.getUsage()`

**6. Automatic offload doesn't trigger**
- **Cause**: Resources sufficient or orchestrator not initialized
- **Solution**: Check `wouldNeedOffload()` returns true
- **Debug**: Verify orchestrator instance created correctly

### Debug Tips

**Enable Verbose Logging**:
```typescript
// In main/ipc-handlers.ts
console.log('Diffusion server info:', await diffusionServer.getInfo());
console.log('Would need offload:', await orchestrator.wouldNeedOffload());
```

**Check HTTP Endpoint Manually**:
```bash
# Health check
curl http://localhost:8081/health

# Generate image (from command line)
curl -X POST http://localhost:8081/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"prompt":"test","width":512,"height":512,"steps":10}'
```

**Monitor Resource Usage**:
- Open DevTools Console
- Watch for IPC errors
- Check Network tab for HTTP calls
- Verify memory usage in Task Manager

### Performance Considerations

1. **Image Generation Speed**:
   - 512x512, 20 steps: ~30-60 seconds (CPU)
   - 512x512, 20 steps: ~10-20 seconds (GPU)
   - 1024x1024, 30 steps: ~2-5 minutes (CPU)

2. **Memory Requirements**:
   - Minimum RAM: 8GB (CPU mode)
   - Minimum VRAM: 4GB (GPU mode)
   - Recommended: 16GB+ RAM or 8GB+ VRAM

3. **Polling Intervals**:
   - Server status: 3 seconds
   - Resource usage: 2 seconds
   - Adjust if UI feels sluggish

---

## Future Work

### Phase 3 Integration Plans

**When genai-lite adds image API**:
1. Replace direct HTTP calls with genai-lite API
2. Update IPC handlers to use `ImageService` from genai-lite
3. Remove manual fetch() calls in `diffusion:generate` handler
4. Add multi-provider image generation support

**Example (Future)**:
```typescript
// In main/ipc-handlers.ts (Phase 3+)
import { ImageService } from 'genai-lite';

const imageService = new ImageService(async () => 'not-needed');

ipcMain.handle('diffusion:generate', async (_event, config) => {
  const response = await imageService.generateImage({
    providerId: 'local',
    modelId: 'sdxl-turbo',
    ...config
  });

  if (response.object === 'image.generation') {
    return response.data;
  } else {
    throw new Error(response.error.message);
  }
});
```

### Advanced Features (Phase 4+)

1. **Image History**:
   - Save generated images
   - Browse previous generations
   - Regenerate with same seed

2. **Batch Generation**:
   - Queue multiple prompts
   - Generate variations (different seeds)
   - Export all images

3. **Advanced Resource Monitoring**:
   - Historical charts (memory over time)
   - CPU/GPU utilization graphs
   - Thermal monitoring

4. **Request Queuing**:
   - Queue LLM requests during image generation
   - Display queue status and length
   - Cancel queued requests
   - Timeout configuration

5. **Model Management Enhancements**:
   - One-click model downloads (preset list)
   - Model compatibility checker
   - Automatic optimal settings per model

---

## Conclusion

This plan provides a complete roadmap for implementing Phase 2 of the electron-control-panel example app. Follow the steps sequentially, test thoroughly, and refer to the API reference and troubleshooting sections as needed.

**Success Criteria**:
- ✅ Diffusion Server tab can start/stop server
- ✅ Image generation works with progress tracking
- ✅ Resource Monitor shows real-time usage
- ✅ Automatic offload/reload works when resources constrained
- ✅ All error cases handled gracefully

**Next Steps After Phase 2**:
1. Integrate genai-lite image API when available
2. Add advanced features from Future Work section
3. Polish UI/UX based on user feedback
4. Write automated tests for Phase 2 components

---

**Document Version**: 1.0
**Last Updated**: 2025-10-19
**Status**: Ready for Implementation
