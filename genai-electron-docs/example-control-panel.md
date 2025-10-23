# Example: Control Panel

Reference implementation demonstrating genai-electron integration patterns. Located in `examples/electron-control-panel/`, this is a developer/admin tool for infrastructure management, not a consumer application.

## Navigation

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Key Patterns](#key-patterns)
- [Integration Pattern](#integration-pattern)
- [Running the Example](#running-the-example)
- [Using for Testing](#using-for-testing)

---

## Overview

**Purpose:** Reference implementation for developers building with genai-electron. Think "system monitor" rather than "chat app."

**Location:** `examples/electron-control-panel/`

**Not a Tutorial:** This document describes patterns to study, not step-by-step instructions. The control panel serves as a complete working example of genai-electron integration.

**What it Demonstrates:**
- System capability detection and display
- Model management (download, delete, GGUF metadata)
- Server lifecycle management (LLM and Diffusion)
- Real-time resource monitoring
- Event-driven UI updates
- IPC communication patterns
- Integration with genai-lite

---

## Features

### System Info Tab

Hardware detection and capability assessment:
- CPU, RAM, GPU, VRAM detection with visual indicators
- Status cards with recommendations
- Model compatibility checking
- Auto-refreshes every 5 seconds
- Updates on server start/stop events

### Model Management Tab

Download and manage both LLM and diffusion models:
- Model type selector (LLM / Diffusion)
- List installed models with metadata
- Download from HuggingFace or direct URLs
- Real-time download progress bars
- Delete models with confirmation
- Disk usage statistics
- **GGUF Metadata Viewer:**
  - Complete model information modal
  - Auto-fetches metadata for models without GGUF data
  - Essential fields (Architecture, Layer Count, Context Length)
  - Advanced fields (collapsible sections)
  - Raw JSON viewer with smart truncation (handles 50k+ item arrays!)
  - Refresh Metadata and Copy to Clipboard buttons

### LLM Server Tab

llama-server lifecycle management:
- Start/stop/restart with visual status indicators
- Auto-configuration mode (recommended settings)
- Manual configuration mode (advanced users: threads, gpuLayers, contextSize, etc.)
- Real-time log viewer with auto-scroll
- Simple test chat to verify server works
- Health check monitoring with status badges

### Diffusion Server Tab

Image generation server management:
- Start/stop server with model selection
- Generate images with full parameter control:
  - Prompt and negative prompt (multiline textareas)
  - Dimensions (width/height, 256-2048px)
  - Steps (1-150), CFG Scale (1-20)
  - 8 sampler options (euler_a, dpm++2m, etc.)
  - Random or fixed seed
- Real-time generation progress indicator
- Generated image display with metadata (dimensions, time taken, seed)
- Busy indicator while generating
- Health check monitoring

### Resource Monitor Tab

Real-time resource tracking and diagnostics:
- **System Memory Usage:**
  - Total, used, available RAM with progress bar
  - Polls every 2 seconds for real-time updates
- **GPU/VRAM Usage** (conditional, when GPU available):
  - Updates on server start/stop events
- **Server Status Grid:**
  - LLM + Diffusion servers side-by-side
  - Status badges, health indicators, ports, model names
- **Resource Orchestration Status:**
  - Offload detection warnings (VRAM constrained)
  - Saved LLM state display (shows if LLM was offloaded)
- **Event Log:**
  - Last 20 events with timestamps
  - Color-coded by type (info/warning/error)
  - Clear events button
- **Debug Tools:**
  - Print LLM config, system capabilities, optimal config, resource estimates
  - Output appears in terminal console

---

## Architecture

### Tech Stack

- **Electron** - Desktop framework
- **React** - UI components
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server

### Structure

```
examples/electron-control-panel/
├── main/                    # Main process (Node.js)
│   ├── index.ts            # Window creation, app lifecycle
│   ├── preload.ts          # Context bridge (IPC)
│   ├── ipc-handlers.ts     # IPC handler registration
│   └── genai-api.ts        # genai-electron wrappers
└── renderer/               # Renderer process (Browser)
    ├── index.tsx           # React entry point
    ├── App.tsx             # Root component with tabs
    ├── components/         # React components by feature
    ├── hooks/              # Custom React hooks
    ├── types/              # TypeScript definitions
    └── styles/             # CSS files
```

### IPC Communication

- **Main → Renderer:** `ipcMain.handle()` with `contextBridge.exposeInMainWorld()`
- **Renderer → Main:** `window.api.*` methods exposed via preload
- **Events:** `webContents.send()` for progress updates and server events

---

## Key Patterns

These are patterns to study in the code, not step-by-step instructions:

### System Info Polling

```typescript
// Pattern: Periodic polling + event-driven updates
// Location: renderer/components/SystemInfoTab.tsx

// Poll every 5 seconds
useEffect(() => {
  const interval = setInterval(() => {
    refreshSystemInfo();
  }, 5000);
  return () => clearInterval(interval);
}, []);

// Also update on server events
window.api.onServerStatusChange(() => {
  refreshSystemInfo();
});
```

### Server Lifecycle via IPC

```typescript
// Pattern: IPC handlers for server control
// Location: main/ipc-handlers.ts

ipcMain.handle('llm:start', async (_event, config) => {
  try {
    await llamaServer.start(config);
    return { success: true };
  } catch (error) {
    return { success: false, error: formatErrorForUI(error) };
  }
});
```

### Model Download with Progress

```typescript
// Pattern: Streaming progress updates via IPC
// Location: main/genai-api.ts

export async function downloadModel(config, mainWindow) {
  await modelManager.downloadModel({
    ...config,
    onProgress: (downloaded, total) => {
      mainWindow.webContents.send('download-progress', {
        modelId: config.name,
        downloaded,
        total,
        percentage: (downloaded / total) * 100
      });
    }
  });
}
```

### Health Monitoring

```typescript
// Pattern: Periodic health checks + event-driven updates
// Location: renderer/hooks/useServerHealth.ts

useEffect(() => {
  const checkHealth = async () => {
    const healthy = await window.api.llamaServer.isHealthy();
    setHealth(healthy ? 'ok' : 'error');
  };

  checkHealth();
  const interval = setInterval(checkHealth, 5000);
  return () => clearInterval(interval);
}, []);
```

### GGUF Metadata Viewer

```typescript
// Pattern: Modal with auto-fetch, collapsible sections, smart truncation
// Location: renderer/components/GGUFMetadataModal.tsx

// Auto-fetch if metadata missing
useEffect(() => {
  if (!model.ggufMetadata) {
    fetchMetadata(model.id);
  }
}, [model]);

// Smart JSON truncation for large arrays
function truncateJSON(obj, maxArrayLength = 10) {
  // Handles 50k+ item arrays without crashing UI
}
```

### Resource Monitor Implementation

```typescript
// Pattern: Real-time memory polling, event log with TTL
// Location: renderer/components/ResourceMonitorTab.tsx

// Poll memory every 2 seconds
useEffect(() => {
  const interval = setInterval(async () => {
    const memory = await window.api.systemInfo.getMemoryInfo();
    setMemoryUsage(memory);
  }, 2000);
  return () => clearInterval(interval);
}, []);

// Event log with max 20 items
function addEvent(event) {
  setEvents(prev => [event, ...prev].slice(0, 20));
}
```

### Structured Log Parsing for UI

```typescript
// Pattern: Use getStructuredLogs() for filtering/formatting
// Location: renderer/components/LogViewer.tsx

const logs = await window.api.llamaServer.getStructuredLogs(100);

// Filter by level
const errors = logs.filter(e => e.level === 'error');

// Format for display
const formatted = logs.map(entry => ({
  time: new Date(entry.timestamp).toLocaleTimeString(),
  level: entry.level.toUpperCase(),
  message: entry.message
}));
```

### Event-Driven UI Updates

```typescript
// Pattern: Server events → webContents.send → React state
// Location: main/ipc-handlers.ts + renderer components

// Main process
llamaServer.on('started', () => {
  mainWindow.webContents.send('server-event', {
    type: 'started',
    server: 'llm'
  });
});

// Renderer process
useEffect(() => {
  window.api.onServerEvent((event) => {
    if (event.type === 'started') {
      updateServerStatus('running');
    }
  });
}, []);
```

---

## Integration Pattern

The control panel demonstrates recommended separation of concerns:

**genai-electron** (Main Process):
- Manages infrastructure: servers, binaries, resources
- Handles: `modelManager`, `llamaServer`, `diffusionServer`, `systemInfo`

**genai-lite** (Main Process):
- Provides unified API: `LLMService`, `ImageService`
- Used for actual LLM chat and image generation calls

```
┌──────────────────────────────────────────────────┐
│         electron-control-panel (Main)            │
│                                                  │
│  ┌─────────────┐       ┌──────────────────────┐ │
│  │ genai-lite  │◄──────│  genai-electron      │ │
│  │             │       │                      │ │
│  │ LLMService  │       │ llamaServer.start()  │ │
│  │ ImageService│       │ diffusionServer...   │ │
│  └─────────────┘       └──────────────────────┘ │
│         │                       │                │
│         │                       │                │
└─────────┼───────────────────────┼────────────────┘
          │ HTTP                  │ spawns/manages
          ▼                       ▼
   ┌──────────────┐      ┌──────────────┐
   │ llama-server │      │ HTTP wrapper │
   │ (port 8080)  │      │ (port 8081)  │
   └──────────────┘      └──────────────┘
```

---

## Running the Example

### Prerequisites

- Node.js 22.x or later
- Platform requirements (see installation-and-setup.md)
- Optional: GPU drivers for hardware acceleration

### Installation

```bash
cd examples/electron-control-panel
npm install
```

### Development Mode

```bash
npm run dev
```

This will:
1. Build the main process TypeScript
2. Start Vite dev server for renderer
3. Launch Electron with hot reload

### Building for Production

```bash
# Build the application
npm run build

# Package for distribution
npm run package

# Create platform-specific installers
npm run make
```

---

## Using for Testing

The control panel is ideal for testing genai-electron changes:

**Workflow:**
1. Make changes to genai-electron source code
2. Rebuild library in root directory:
   ```bash
   cd /path/to/genai-electron
   npm run build
   ```
3. Restart control panel app
4. Test changes interactively through UI

**Benefits:**
- Visual feedback for all features
- Easy debugging with DevTools
- Test all managers and APIs
- Verify error handling
- Check progress tracking
- Monitor resource usage

---

## Relationship to genai-lite's chat-demo

Different focuses for different purposes:

| Aspect | genai-lite chat-demo | electron-control-panel |
|--------|---------------------|------------------------|
| **Focus** | API features (templates, providers, reasoning) | Infrastructure (downloads, servers, resources) |
| **Use case** | Chat interface showcase | Developer/admin control panel |
| **genai-lite usage** | Heavy (main focus) | Medium (LLM + Image APIs) |
| **genai-electron usage** | None | Heavy (main focus) |

The control panel's test chat is intentionally minimal—it verifies the server works. For advanced chat features, see genai-lite's chat-demo.

---

## Complete Reference

For complete implementation details, see:
- **App's own README:** `examples/electron-control-panel/README.md`
- **Source code:** `examples/electron-control-panel/main/` and `renderer/`

---

## See Also

- [Installation and Setup](installation-and-setup.md) - Prerequisites
- [Integration Guide](integration-guide.md) - IPC patterns and best practices
- [System Detection](system-detection.md) - SystemInfo usage
- [Model Management](model-management.md) - Download and GGUF patterns
- [LLM Server](llm-server.md) - Server lifecycle
- [Image Generation](image-generation.md) - Diffusion server and progress
- [Resource Orchestration](resource-orchestration.md) - Automatic management
