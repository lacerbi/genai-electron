# genai-electron Control Panel - Design Document

> **Application**: electron-control-panel (example app for genai-electron)
> **Version**: 0.1.0-draft
> **Last Updated**: 2025-10-16
> **Status**: Design Phase

---

## Overview

The **electron-control-panel** is a full-featured Electron application designed to demonstrate and test genai-electron's runtime management capabilities. This document provides complete design specifications, implementation details, UI mockups, and usage instructions.

**Related Documents:**
- [genai-electron Library Design](DESIGN.md) - Main library architecture and design decisions
- genai-lite README - Related project (API abstraction layer)

---

## Purpose and Scope

The genai-electron example app is an Electron application designed to demonstrate and test the library's runtime management capabilities. Unlike genai-lite's example app chat-demo (which showcases API abstraction, templates, and reasoning modes), this app focuses on the infrastructure layer:

**What This App Demonstrates:**
- System capability detection (CPU, RAM, GPU, VRAM)
- Model download management with progress tracking
- Server lifecycle management (start, stop, restart, health monitoring)
- Resource orchestration (automatic offload/reload between LLM and diffusion)
- Configuration options (auto-detected vs. manual settings)
- Error handling and recovery
- Log viewing and monitoring

**What This App Does NOT Do:**
- Replicate chat-demo's features (that's genai-lite's job)
- Provide a polished consumer-facing chat interface
- Implement advanced prompt engineering features
- Focus on multi-provider cloud API integration

**Minimal genai-lite Integration:**
The app uses genai-lite only for simple test requests to verify servers are working correctly (basic chat messages, simple image generation). The focus remains on genai-electron's server management, not genai-lite's API features.

### Key Features by Phase

#### Phase 1: MVP - LLM Support

**System Info Tab:**
- Display detected system capabilities (CPU cores, architecture)
- Show total and available RAM
- Detect GPU type (NVIDIA CUDA, AMD ROCm, Apple Metal, Intel)
- Display total and available VRAM
- Visual indicators (green for good, yellow for marginal, red for insufficient)
- Recommendations for model sizes based on available resources

**Model Management Tab:**
- List all installed LLM models with metadata (size, quantization, download date)
- Download models from HuggingFace or direct URLs
- Real-time download progress (percentage, speed, ETA)
- Pause/resume download capability (Phase 3)
- Delete models with confirmation dialog
- Show disk usage (used space, available space, quota)
- Model verification status (checksum validation)

**LLM Server Tab:**
- Start/stop llama-server with visual status indicator
- Auto-configuration mode (detect optimal settings automatically)
- Manual configuration mode with form inputs:
  - Context size
  - GPU layers to offload
  - Thread count
  - Parallel request slots
  - Flash attention toggle
- Display current server status (running, stopped, crashed, restarting)
- Show server configuration (what settings are being used)
- Health check indicator (green dot when healthy, red when unhealthy)
- View server logs in real-time (with auto-scroll, filter, search)
- Simple test chat interface:
  - Send a test message
  - Receive response
  - Verify server is working correctly
  - NOT a full chat UI (that's chat-demo's purpose)

#### Phase 2: Image Generation

**Diffusion Server Tab:**
- Start/stop HTTP wrapper for stable-diffusion.cpp
- Server status and health indicators
- Configuration options (sampling method, default steps, etc.)
- Simple test image generation interface:
  - Prompt input field
  - Negative prompt input (optional)
  - Basic settings (width, height, steps, CFG scale)
  - Generate button
  - Progress indicator (step X/Y)
  - Display generated image
  - NOT a full image studio (just testing the server works)

**Resource Monitor Tab:**
- Real-time resource usage visualization
- RAM usage: Total, used by LLM server, used by diffusion, available
- VRAM usage: Total, used by LLM, used by diffusion, available (if GPU present)
- Visual timeline showing resource allocation changes
- Status indicators for automatic resource management:
  - "LLM Running" (green)
  - "Diffusion Running" (green)
  - "Offloading LLM for diffusion..." (yellow)
  - "Reloading LLM after diffusion..." (yellow)
- Display current offload/reload state
- Show queue status (pending LLM requests during image generation)
- Manual controls to test resource management:
  - "Test Automatic Offload" button (triggers image gen while LLM running)
  - View real-time resource transition
  - Verify LLM restarts correctly after diffusion completes

#### Phase 3+: Production Features

**Enhanced Download Management:**
- Resume interrupted downloads automatically
- Parallel chunk downloads for faster speeds
- Download queue (download multiple models sequentially)
- SHA256 checksum verification with visual indicator

**Event Monitoring:**
- Event log viewer showing all significant events
- Server crash notifications with error details
- Automatic restart events
- Download completion/failure notifications
- Resource management events (offload triggered, reload complete)

**Storage Configuration:**
- Settings panel for storage mode selection:
  - Isolated (default, per-app storage)
  - Shared (future: shared storage across apps)
  - Custom (future: user-specified path)
- Migration tool for moving from isolated to shared storage

**Advanced Configuration:**
- Expert mode toggle for advanced server settings
- Binary version management (check for updates, manual update)
- Custom binary paths (for testing custom builds)
- Port selection and conflict resolution
- Restart policies configuration (auto-restart, max retries, backoff)

### UI Design

#### Overall Layout

**Developer Tool Aesthetic:**
The app uses a clean, functional interface focused on clarity and information density rather than consumer polish. Think "system monitor" or "admin panel" rather than "chat app".

**Tab-Based Navigation:**
```
┌─────────────────────────────────────────────────────────┐
│  genai-electron Control Panel                          │
├─────────────────────────────────────────────────────────┤
│ [System Info] [Models] [LLM Server] [Diffusion] [Resources] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  (Tab content area)                                     │
│                                                         │
│                                                         │
│                                                         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

#### Component Design Patterns

**Status Indicators:**
- Green dot ● = Healthy/Running/Success
- Yellow dot ● = Warning/In Progress/Degraded
- Red dot ● = Error/Stopped/Failed
- Gray dot ● = Unknown/Not Started

**Action Buttons:**
- Primary actions: Prominent buttons (Start Server, Download Model)
- Destructive actions: Red buttons with confirmation (Delete Model, Force Stop)
- Disabled states: Grayed out when not applicable
- Loading states: Spinner icon + "Starting..." text

**Progress Indicators:**
- Download progress: Progress bar + percentage + speed + ETA
- Operation progress: Spinner + status text ("Starting server...", "Verifying checksum...")
- Indeterminate progress: Spinner (when duration unknown)

**Log Viewers:**
- Monospace font for readability
- Auto-scroll toggle (default on)
- Filter by log level (Debug, Info, Warn, Error)
- Search functionality
- Copy to clipboard button
- Clear logs button

**Forms:**
- Auto-detected values shown as placeholders
- "Auto" checkbox to use detected values
- Manual input fields enabled when unchecked
- Validation with inline error messages
- Helpful tooltips explaining each setting

#### Tab-Specific Layouts

**System Info Tab:**
```
System Capabilities
───────────────────
CPU:  ● 10 cores (arm64)
RAM:  ● 16 GB total, 8 GB available
GPU:  ● Apple M1 Max (Metal)
VRAM: ● 32 GB unified memory

Recommendations
───────────────
Maximum model size: 13B (Q4 quantization)
Optimal GPU layers:  35-40 layers
Recommended models:
  - Llama-2-7B-Q4_K_M  ✓ Supported
  - Llama-2-13B-Q4_K_M ✓ Supported
  - Llama-2-70B-Q4_K_M ⚠ Marginal (needs 48GB RAM)
```

**Model Management Tab:**
```
Installed Models (LLM)
──────────────────────
● llama-2-7b-q4     4.2 GB   Downloaded: 2025-01-15
● mistral-7b-q5     5.1 GB   Downloaded: 2025-01-14

  [Download Model] [Delete Selected]

Disk Usage: 9.3 GB used / 256 GB available
```

**LLM Server Tab:**
```
Server Status: ● Running (Healthy)
Model: llama-2-7b-q4
Port: 8080
PID: 12345

Configuration
─────────────
☑ Auto-configure (recommended)
☐ Manual configuration

  Context Size:    [4096    ] (auto-detected)
  GPU Layers:      [35      ] (auto-detected)
  Threads:         [8       ] (auto-detected)
  Parallel Slots:  [4       ] (auto-detected)

[Stop Server] [Restart Server] [View Logs]

Test Chat
─────────
User: Hello, how are you?
Assistant: I'm doing well, thank you for asking! How can I help you today?

[Send Test Message]
```

**Diffusion Server Tab:**
```
Server Status: ● Stopped
Model: (none selected)
Port: 8081

Configuration
─────────────
☐ Auto-configure
☑ Manual configuration

  Sampling Method:  [Euler A  ▼]
  Default Steps:    [20      ]
  Default CFG:      [7.5     ]

[Download Model] [Start Server]

Test Image Generation
─────────────────────
Prompt:
┌────────────────────────────────────────────┐
│ A serene mountain landscape at sunset     │
└────────────────────────────────────────────┘

Negative Prompt:
┌────────────────────────────────────────────┐
│ blurry, low quality                        │
└────────────────────────────────────────────┘

Size: [512x512 ▼]  Steps: [20]  CFG Scale: [7.5]

[Generate Image]

Generated Image
───────────────
[Image preview area - 512x512]

Status: Ready
```

**Resource Monitor Tab:**
```
System Resource Usage
─────────────────────

RAM Usage (16 GB total)
████████████████░░░░░░░░  10.2 GB used
├─ LLM Server:     6.5 GB  ███████████░░░░░░░░░░░░░
├─ Diffusion:      2.8 GB  █████░░░░░░░░░░░░░░░░░░░
├─ System/Other:   0.9 GB  ██░░░░░░░░░░░░░░░░░░░░░░
└─ Available:      5.8 GB

VRAM Usage (8 GB total - NVIDIA RTX 3070)
█████████████████████░░░  6.2 GB used
├─ LLM Server:     6.0 GB  ██████████████████████░░
├─ Diffusion:      0.0 GB  ░░░░░░░░░░░░░░░░░░░░░░░░
└─ Available:      1.8 GB

Resource Timeline (Last 5 minutes)
──────────────────────────────────
VRAM │ 8GB ┤                    ▄▄▄▄▄
     │     │                ▄▄▄▄▀
     │ 4GB ┤        ▄▄▄▄▄▄▄▀
     │     │    ▄▄▄▀
     │ 0GB └────┴────┴────┴────┴────
            -5m  -4m  -3m  -2m  -1m  now

            Legend: ▄ LLM  ▀ Diffusion

Current Status
──────────────
● LLM Server:    Running (using 6GB VRAM)
○ Diffusion:     Stopped

Recent Events
─────────────
[10:23:45] LLM Server started (6GB VRAM allocated)
[10:24:12] Diffusion requested - insufficient VRAM
[10:24:12] Offload triggered: Stopping LLM Server
[10:24:18] LLM Server stopped (6GB VRAM freed)
[10:24:18] Diffusion Server started (5GB VRAM allocated)
[10:25:03] Image generation completed
[10:25:03] Diffusion Server stopped (5GB VRAM freed)
[10:25:05] Reload triggered: Starting LLM Server
[10:25:11] LLM Server restarted (6GB VRAM allocated)

[Clear Event Log]
```

### Tech Stack

**Electron:**
- Main process: TypeScript, runs genai-electron APIs
- Renderer process: React (matches chat-demo patterns)
- IPC communication: `ipcMain` / `ipcRenderer` for API calls

**Frontend Framework:**
- React with TypeScript
- Simple component-based architecture
- No heavy UI libraries (keep it lightweight)
- CSS modules or styled-components for styling

**State Management:**
- React Context or simple useState/useReducer
- No need for Redux/Zustand (app is simple enough)

**Build Tools:**
- Electron Forge or Electron Builder
- Vite for renderer process bundling (fast, modern)
- TypeScript compilation for main process

### Project Structure

```
examples/electron-control-panel/
├── main/                          # Electron main process
│   ├── index.ts                   # Main entry point
│   ├── genai-electron-api.ts      # Wrapper for genai-electron calls
│   ├── ipc-handlers.ts            # IPC handlers for renderer communication
│   └── preload.ts                 # Preload script (contextBridge)
│
├── renderer/                      # Renderer process (React frontend)
│   ├── index.html                 # HTML entry point
│   ├── index.tsx                  # React entry point
│   ├── App.tsx                    # Root component with tab navigation
│   │
│   ├── components/                # UI components
│   │   ├── SystemInfo.tsx         # System capabilities display
│   │   ├── ModelManager.tsx       # Model list and download
│   │   ├── LlamaServerControl.tsx # LLM server management
│   │   ├── DiffusionServerControl.tsx # Diffusion server (Phase 2)
│   │   ├── ResourceMonitor.tsx    # Resource usage (Phase 2)
│   │   │
│   │   ├── common/                # Reusable components
│   │   │   ├── StatusIndicator.tsx  # Colored dot + label
│   │   │   ├── ProgressBar.tsx      # Progress bar component
│   │   │   ├── LogViewer.tsx        # Log display component
│   │   │   └── ActionButton.tsx     # Styled button
│   │   │
│   │   └── forms/                 # Form components
│   │       ├── LlamaServerConfig.tsx     # LLM server configuration form
│   │       └── ModelDownload.tsx    # Model download form
│   │
│   ├── hooks/                     # React hooks
│   │   ├── useSystemInfo.ts       # System info state
│   │   ├── useModels.ts           # Model management state
│   │   ├── useServerStatus.ts     # Server status polling
│   │   └── useIPC.ts              # IPC communication helper
│   │
│   ├── types/                     # TypeScript types
│   │   └── index.ts               # Type definitions
│   │
│   ├── utils/                     # Utilities
│   │   ├── formatters.ts          # Format bytes, dates, etc.
│   │   └── validators.ts          # Input validation
│   │
│   └── styles/                    # CSS/styling
│       ├── global.css             # Global styles
│       └── variables.css          # CSS variables (colors, spacing)
│
├── package.json                   # Dependencies and scripts
├── tsconfig.json                  # TypeScript config
├── vite.config.ts                 # Vite config (renderer)
├── forge.config.js                # Electron Forge config (packaging)
└── README.md                      # Setup and usage instructions
```

### Comparison with chat-demo

| Aspect | genai-lite chat-demo | genai-electron control-panel |
|--------|---------------------|------------------------------|
| **Primary Focus** | API abstraction features | Runtime management |
| **Key Features** | Templates, providers, reasoning modes, prompt engineering | Model downloads, server lifecycle, resource management |
| **Use Case** | Showcase chat interface and LLM API features | Developer/admin tool for local AI infrastructure |
| **UI Complexity** | Production-ready consumer UI | Developer tool aesthetic (functional, not polished) |
| **genai-lite Usage** | Heavy (main purpose of the app) | Light (only for testing servers work) |
| **genai-electron Usage** | None (doesn't exist yet) | Heavy (main purpose of the app) |
| **Target Audience** | End users and developers evaluating genai-lite | Developers building with genai-electron |
| **Tab Structure** | Chat, Templates, llama.cpp Tools | System Info, Models, LLM Server, Diffusion, Resources |
| **Maintenance** | Kept up-to-date with genai-lite features | Kept up-to-date with genai-electron features |

**Key Takeaway:** The two example apps are complementary, not redundant. chat-demo shows how to **use AI APIs**, while control-panel shows how to **manage AI infrastructure**.

### Usage

#### Installation

```bash
cd examples/electron-control-panel
npm install
```

#### Running in Development

```bash
npm start
# Opens Electron app in development mode with hot reload
```

#### Building for Production

```bash
npm run make
# Creates distributable packages in out/ directory
```

#### First Run Walkthrough

**Step 1: Explore System Info**
- App opens to System Info tab automatically
- Review detected capabilities (CPU, RAM, GPU, VRAM)
- Check recommendations for model sizes
- Verify GPU acceleration is detected (if applicable)

**Step 2: Download a Model**
- Navigate to Models tab
- Click "Download Model" button
- Enter model details:
  - Source: HuggingFace
  - Repo: `TheBloke/Llama-2-7B-GGUF`
  - File: `llama-2-7b.Q4_K_M.gguf`
  - Display Name: `Llama 2 7B (Q4)`
- Click "Download"
- Watch progress bar (percentage, speed, ETA)
- Wait for download to complete (~4.2 GB, ~5-10 minutes depending on connection)
- Model appears in "Installed Models" list

**Step 3: Start LLM Server**
- Navigate to LLM Server tab
- Server status shows "● Stopped"
- Select model from dropdown: `Llama 2 7B (Q4)`
- Keep "Auto-configure" checked (recommended for first run)
- Review auto-detected settings:
  - Context Size: 4096 (based on model)
  - GPU Layers: 35 (based on available VRAM)
  - Threads: 8 (based on CPU cores)
  - Parallel Slots: 4 (reasonable default)
- Click "Start Server"
- Watch status change:
  - "● Starting..." (yellow) → downloading binaries if first run
  - "● Running (Healthy)" (green) after health check passes
- Review server info (port, PID, configuration)

**Step 4: Test the Server**
- Scroll down to "Test Chat" section
- Type a simple message: "Hello, how are you?"
- Click "Send Test Message"
- Verify you receive a coherent response
- This confirms the server is working correctly

**Step 5: View Logs**
- Click "View Logs" button
- Review server startup logs in monospace viewer
- Try filtering by log level (Info, Warn, Error)
- Test search functionality
- Observe real-time log updates (auto-scroll enabled)

**Step 6: Stop the Server**
- Click "Stop Server" button
- Watch status change:
  - "● Stopping..." (yellow) → graceful shutdown
  - "● Stopped" (gray)
- Verify process is cleaned up (PID no longer exists)

**Step 7: (Phase 2) Test Image Generation**
- Navigate to Diffusion tab
- Download a diffusion model first (if not already done)
- Start diffusion server
- Watch Resource Monitor tab:
  - If LLM server is running, it will automatically offload
  - VRAM/RAM usage graphs update in real-time
- Generate a test image:
  - Prompt: "A serene mountain landscape at sunset"
  - Negative Prompt: "blurry, low quality"
  - Size: 512x512
  - Steps: 20
- Watch progress indicator (Step 1/20, 2/20, ...)
- View generated image when complete
- Verify LLM server automatically reloads (if it was running before)

**Step 8: Monitor Resources**
- Navigate to Resource Monitor tab
- Observe real-time resource usage:
  - RAM used by LLM server
  - VRAM used by diffusion (or LLM if GPU-accelerated)
  - Available memory
- Review event timeline showing offload/reload operations

### Development Tips

**IPC Communication Pattern:**
```typescript
// In main/ipc-handlers.ts
ipcMain.handle('system:getInfo', async () => {
  return await systemInfo.detect();
});

ipcMain.handle('models:list', async () => {
  return await modelManager.listModels('llm');
});

// In renderer/hooks/useSystemInfo.ts
const systemInfo = await window.api.system.getInfo();
```

**State Management:**
```typescript
// Simple Context for global state
const AppContext = React.createContext<AppState>(/* ... */);

// Individual hooks for specific features
const useServerStatus = () => {
  const [status, setStatus] = useState<ServerStatus>('stopped');

  useEffect(() => {
    const interval = setInterval(async () => {
      const newStatus = await window.api.server.getStatus();
      setStatus(newStatus);
    }, 5000); // Poll every 5 seconds

    return () => clearInterval(interval);
  }, []);

  return status;
};
```

**Error Handling:**
```typescript
// In renderer components
try {
  await window.api.server.start(config);
} catch (error) {
  if (error instanceof InsufficientResourcesError) {
    showError('Not enough RAM to run this model', error.suggestion);
  } else if (error instanceof PortInUseError) {
    showError('Port already in use', 'Try a different port or stop the conflicting process');
  } else {
    showError('Failed to start server', error.message);
  }
}
```