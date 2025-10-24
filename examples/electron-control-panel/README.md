# electron-control-panel

> Developer control panel for testing and demonstrating genai-electron runtime management

## Overview

This Electron application showcases genai-electron's Phase 1 & 2 capabilities: system detection, model management, LLM server lifecycle, image generation, and automatic resource orchestration. It serves as both a testing tool during development and a reference implementation for developers building with genai-electron.

**Purpose:** This is a developer/admin tool focused on infrastructure management, not a consumer application. Think "system monitor" rather than "chat app."

## Features

- **System Info Tab** - Hardware detection and capability assessment
  - CPU, RAM, GPU, VRAM detection
  - Status indicators and recommendations
  - Model compatibility checking
  - Auto-refreshes every 5 seconds and on server start/stop events

- **Model Management Tab** - Download and manage models
  - List installed models with metadata (both LLM and Diffusion)
  - Model type selector (LLM / Diffusion)
  - Download from HuggingFace or direct URLs
  - Real-time download progress
  - Delete models with confirmation
  - Disk usage statistics
  - **📊 GGUF Metadata Viewer** - Complete model information modal
    - Auto-fetches metadata for models without GGUF data
    - Essential fields: Architecture, Layer Count, Context Length, File Type
    - Advanced fields (collapsible): All technical metadata fields
    - Raw JSON viewer with smart truncation (handles 50k+ item arrays!)
    - Refresh Metadata and Copy to Clipboard buttons

- **LLM Server Tab** - llama-server lifecycle management
  - Start/stop/restart server with visual status
  - Auto-configuration mode (recommended settings)
  - Manual configuration mode (advanced users)
  - Real-time log viewer
  - Simple test chat to verify server works
  - Health check monitoring

- **Diffusion Server Tab** (Phase 2) - Image generation server management
  - Start/stop diffusion server with model selection
  - Generate images with full parameter control:
    - Prompt and negative prompt (multiline textareas)
    - Dimensions (width/height, 256-2048px)
    - Steps (1-150), CFG Scale (1-20)
    - 8 sampler options (euler_a, euler, heun, dpm2, dpm++2s_a, dpm++2m, dpm++2mv2, lcm)
    - Random or fixed seed
  - Real-time generation progress indicator
  - Generated image display with metadata (dimensions, time taken, seed)
  - Busy indicator while generating
  - Health check monitoring

- **Resource Monitor Tab** (Phase 2) - Real-time resource tracking
  - System memory usage (total, used, available) with progress bar
    - Polls every 2 seconds for real-time updates
  - GPU/VRAM usage (conditional, when GPU available)
    - Updates on server start/stop events
  - Server status grid (LLM + Diffusion servers side-by-side)
  - Resource orchestration status:
    - Offload detection (warns if VRAM constrained)
    - Saved LLM state display (shows if LLM was offloaded)
  - Event log (last 20 events with timestamps)
    - Tracks server start/stop/crash events
    - Color-coded by type (info/warning/error)
    - Clear events button
  - Debug tools (diagnostic buttons)
    - Print LLM config, system capabilities, optimal config, resource estimates
    - Output appears in terminal console

## Prerequisites

- **Node.js** 22.x or later (for native fetch and modern features)
- **Platform-specific requirements:**
  - macOS: 11+ (Intel or Apple Silicon)
  - Windows: 10+ (64-bit)
  - Linux: Ubuntu 20.04+, Debian 11+, or Fedora 35+
- **GPU drivers** (optional, for hardware acceleration):
  - NVIDIA: Latest GPU drivers for CUDA support
  - AMD: ROCm drivers (Linux only, experimental)
  - Apple: Metal support built into macOS

## Installation

```bash
cd examples/electron-control-panel
npm install
```

## Running in Development

```bash
npm run dev
```

This will:

1. Build the main process TypeScript
2. Start Vite dev server for the renderer (available at `http://localhost:3100`)
3. Launch Electron with hot reload

## Building for Production

```bash
# Build the application
npm run build

# Package for distribution
npm run package

# Create platform-specific installers
npm run make
```

## First-Run Walkthrough

### Step 1: Explore System Info

1. Launch the app
2. The **System Info** tab opens by default
3. Review detected hardware: CPU cores, RAM, GPU, VRAM
4. Check the recommendations for model sizes and configurations

### Step 2: Download a Model

1. Navigate to the **Models** tab
2. Choose a download source (URL or HuggingFace)
3. For HuggingFace, try:
   - Repo: `bartowski/Meta-Llama-3.1-8B-Instruct-GGUF`
   - File: `Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf`
4. Enter a display name (e.g., "Llama 3.1 8B")
5. Click **Download** and watch the progress
6. Model appears in the installed models list when complete

### Step 3: Start the LLM Server

1. Navigate to the **LLM Server** tab
2. Select your downloaded model from the dropdown
3. Leave **Auto-configure** checked (recommended)
4. Click **Start Server**
5. Watch the status change to "Running"
6. Health indicator turns green when ready

### Step 4: Test the Server

1. In the **Test Chat** section (same tab)
2. Enter a simple test message (e.g., "Hello, how are you?")
3. Click **Send**
4. Verify you receive a response from the model

### Step 5: View Logs

1. Scroll to the **Server Logs** section
2. Watch real-time output from llama-server
3. Use **Clear** button to reset the log viewer

### Step 6: Stop the Server

1. Click **Stop Server** button
2. Status changes to "Stopped"
3. Logs stop updating

## Troubleshooting

### Server won't start

- **Check model selection:** Ensure a model is selected in the dropdown
- **Check available RAM:** System Info tab shows if you have enough memory
- **Check logs:** Look for error messages in the Server Logs section

### Download fails

- **Network connection:** Verify internet connectivity
- **Disk space:** Check if you have enough free space
- **URL validity:** For direct URLs, ensure the link is accessible

### GPU not detected

- **macOS:** Metal support is automatic on modern Macs (2016+)
- **Windows/Linux NVIDIA:** Install latest NVIDIA drivers
- **Linux AMD:** Install ROCm drivers (experimental support)

### Port already in use

- **Port 3100 (UI):** Another application may be using this port for the dev server
- **Port 8080 (llama-server):** Another application may be using this port
- **Solution:** Stop the conflicting application or change the port in manual configuration mode

## Development

```bash
# Lint code
npm run lint

# Format code
npm run format
```

## Architecture

### Main Process (`main/`)

- `index.ts` - Window creation, app lifecycle
- `preload.ts` - Context bridge for secure IPC
- `ipc-handlers.ts` - IPC handler registration
- `genai-api.ts` - Wrapper for genai-electron calls

**API Integration:**

- Uses genai-lite's `LLMService` and `ImageService` for all AI operations
- genai-electron handles infrastructure (servers, binaries, resources)
- Demonstrates recommended pattern: genai-lite for API, genai-electron for runtime

### Renderer Process (`renderer/`)

- `index.tsx` - React entry point
- `App.tsx` - Root component with tab navigation
- `components/` - React components organized by feature
- `hooks/` - Custom React hooks for data fetching
- `types/` - TypeScript type definitions
- `styles/` - CSS files

### IPC Communication

The app uses Electron's IPC for secure communication between processes:

- **Main → Renderer:** `ipcMain.handle()` with `contextBridge.exposeInMainWorld()`
- **Renderer → Main:** `window.api.*` methods exposed via preload
- **Events:** `webContents.send()` for progress updates and server events

## Relationship to genai-lite's chat-demo

These example apps have different focuses:

| Aspect                   | genai-lite chat-demo                           | genai-electron control-panel                   |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------- |
| **Focus**                | API features (templates, providers, reasoning) | Infrastructure (downloads, servers, resources) |
| **Use case**             | Chat interface showcase                        | Developer/admin control panel                  |
| **genai-lite usage**     | Heavy (main focus)                             | Medium (LLM + Image APIs)                      |
| **genai-electron usage** | None                                           | Heavy (main focus)                             |

The control-panel's test chat is intentionally minimal—it verifies the server works. For advanced chat features, see genai-lite's chat-demo.

## Current Implementation Status

**Phase 1 & 2: Complete** - All core functionality implemented:

- ✅ LLM server management
- ✅ Image generation (Diffusion server)
- ✅ Resource monitoring and orchestration
- ✅ Event logging

**Future phases** (from main library roadmap):

- **Phase 3:** Enhanced download features (pause/resume)
- **Phase 4:** Storage configuration, advanced monitoring

See the main [DESIGN.md](../../DESIGN.md) for complete roadmap.

## License

MIT License - same as genai-electron parent project
