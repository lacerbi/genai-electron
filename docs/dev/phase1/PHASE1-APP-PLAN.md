# Implementation Plan: electron-control-panel (Phase 1)

> **Status**: In Progress
> **Created**: 2025-10-16
> **Phase**: 1 - MVP (LLM Support Only)

---

## Overview

Create a full-featured Electron application demonstrating genai-electron's Phase 1 capabilities: system detection, model management, and LLM server lifecycle. This developer-focused control panel will serve as both a testing tool and reference implementation.

## Design Philosophy

This is a **developer/admin tool**, not a consumer application:

- **Aesthetic**: Think "system monitor" or "admin panel" rather than "chat app"
  - Functional interface focused on clarity and information density
  - Not polished for consumers - built for developers testing genai-electron
- **Focus**: Infrastructure management, not AI conversation
  - Model downloads, server lifecycle, resource monitoring
  - Clear status indicators, detailed logs, configuration options
- **Purpose**: Test and demonstrate genai-electron runtime management
  - Showcase the library's capabilities
  - Serve as reference implementation for developers
- **Relationship to chat-demo**: Different focus areas
  - **chat-demo** (genai-lite): Showcases API features (templates, reasoning, multi-provider)
  - **control-panel** (genai-electron): Showcases infrastructure (downloads, servers, resources)
- **genai-lite usage**: Minimal and intentional
  - Only used in TestChat to verify llama-server works
  - Simple single-message test (NOT a full chat UI - that's chat-demo's purpose)
  - Demonstrates integration but doesn't replicate chat-demo features

## Scope

### Phase 1 Features (Included)

- ✅ **System Info Tab** - Hardware detection and recommendations
  - Display CPU, RAM, GPU, VRAM information
  - Show status indicators (green/yellow/red)
  - Provide model recommendations based on hardware

- ✅ **Model Management Tab** - Download, list, delete models
  - List installed models with metadata
  - Download from HuggingFace or direct URLs
  - Real-time download progress
  - Delete models with confirmation
  - Show disk usage statistics

- ✅ **LLM Server Tab** - Start/stop server, configuration, test chat
  - Start/stop llama-server with visual status
  - Auto-configuration mode (recommended)
  - Manual configuration mode (advanced)
  - Real-time log viewer
  - Simple test chat interface (verify server works)
  - Health check monitoring

### Explicitly Out of Scope

- ❌ **Diffusion/image generation** (Phase 2)
- ❌ **Resource monitoring** (Phase 2)
- ❌ **Advanced download features** (pause/resume in Phase 3)
- ❌ **Event log viewer** (Phase 3)
- ❌ **Storage configuration** (Phase 4)

---

## Implementation Steps

### Step 1: Project Initialization (2-3 hours)

**Create basic project structure:**

```
examples/electron-control-panel/
├── package.json               # Dependencies and scripts
├── tsconfig.json              # TypeScript config for main process
├── tsconfig.renderer.json     # TypeScript config for renderer
├── vite.config.ts             # Vite config
├── forge.config.js            # Electron Forge packaging
├── .gitignore                 # Git ignore
└── README.md                  # Setup and usage docs
```

**Dependencies to install:**

Core:
- `electron` ^35.0.0 (latest stable, Jan 2025)
- `genai-electron` file:../.. (from parent directory)
- `genai-lite` latest (for test chat functionality)

Frontend:
- `react` ^18.3.1 (React 19 available but using 18.3 for stability)
- `react-dom` ^18.3.1

TypeScript:
- `typescript` ^5.7.2 (match library version)
- `@types/react` ^18.3.0
- `@types/react-dom` ^18.3.0
- `@types/node` ^22.10.0

Build tools:
- `vite` ^7.0.0 (requires Node 20.19+/22.12+, matches our Node 22)
- `@vitejs/plugin-react` ^5.0.4
- `concurrently` ^9.2.1 (required for dev script)

Electron Forge (packaging):
- `@electron-forge/cli` ^7.9.0
- `@electron-forge/plugin-vite` ^7.9.0
- `@electron-forge/maker-squirrel` ^7.9.0 (Windows)
- `@electron-forge/maker-zip` ^7.9.0 (macOS)
- `@electron-forge/maker-deb` ^7.9.0 (Linux)

Code Quality:
- `eslint` ^9.17.0 (match main project)
- `typescript-eslint` ^8.18.2
- `eslint-config-prettier` ^9.1.0
- `prettier` ^3.4.2

**package.json scripts:**

```json
{
  "scripts": {
    "dev": "electron-forge start",
    "build": "tsc && vite build",
    "start": "electron-forge start",
    "package": "electron-forge package",
    "make": "electron-forge make",
    "lint": "eslint . --ext .ts,.tsx",
    "format": "prettier --write ."
  }
}
```

### Step 2: Main Process Setup (3-4 hours)

**Files to create:**

```
main/
├── index.ts                   # Main entry, window creation
├── preload.ts                 # Context bridge for IPC
├── ipc-handlers.ts            # IPC handler registration
└── genai-api.ts               # Wrapper for genai-electron calls
```

**Key implementations:**

**1. main/index.ts** - Window creation, app lifecycle
- Create BrowserWindow (1200x800, dev tools in dev mode)
- Load renderer from Vite dev server (dev) or built files (prod)
- Register IPC handlers on app ready
- Cleanup on quit (stop servers gracefully)

**2. main/preload.ts** - Expose safe IPC API to renderer
- Use `contextBridge` to expose `window.api`
- Namespaces: `system`, `models`, `server`, `logs`
- Type-safe `invoke`/`on` patterns
- Example:
  ```typescript
  contextBridge.exposeInMainWorld('api', {
    system: {
      detect: () => ipcRenderer.invoke('system:detect'),
      getMemory: () => ipcRenderer.invoke('system:getMemory')
    },
    // ... more namespaces
  });
  ```

**3. main/ipc-handlers.ts** - Handle all IPC calls
- `system:detect` → `systemInfo.detect()`
- `system:getMemory` → `systemInfo.getMemoryInfo()`
- `system:canRunModel` → `systemInfo.canRunModel(modelInfo)`
- `system:getOptimalConfig` → `systemInfo.getOptimalConfig(modelInfo)`
- `models:list` → `modelManager.listModels(type)`
- `models:download` → `modelManager.downloadModel(config)` with progress events
- `models:delete` → `modelManager.deleteModel(modelId)`
- `models:getInfo` → `modelManager.getModelInfo(modelId)`
- `models:verify` → `modelManager.verifyModel(modelId)`
- `server:start` → `llamaServer.start(config)`
- `server:stop` → `llamaServer.stop()`
- `server:restart` → `llamaServer.restart()`
- `server:status` → `llamaServer.getStatus()`
- `server:health` → `llamaServer.isHealthy()`
- `server:logs` → `llamaServer.getLogs(limit)`

**4. main/genai-api.ts** - Helper functions
- Progress tracking for downloads (emit to renderer via `webContents.send`)
- Event forwarding from `llamaServer` events to renderer
- Error normalization for renderer consumption
- Event types: `download:progress`, `download:complete`, `server:started`, `server:stopped`, `server:crashed`

### Step 3: Renderer Base Setup (2-3 hours)

**Files to create:**

```
renderer/
├── index.html                 # Entry point
├── index.tsx                  # React mount
├── App.tsx                    # Root component with tabs
├── global.css                 # Global styles
└── vite-env.d.ts             # Vite types
```

**Key implementations:**

**1. index.html** - Basic HTML template
```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>genai-electron Control Panel</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/index.tsx"></script>
  </body>
</html>
```

**2. index.tsx** - React entry point
```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './global.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

**3. App.tsx** - Tab navigation skeleton

**Overall App Structure:**
```
┌──────────────────────────────────────────────┐
│  genai-electron Control Panel                │  ← Header with title
├──────────────────────────────────────────────┤
│  [System Info] [Models] [LLM Server]         │  ← Tab navigation
├──────────────────────────────────────────────┤
│                                              │
│  (Active tab content renders here)           │  ← Content area
│                                              │
└──────────────────────────────────────────────┘
```

**Implementation:**
- State for active tab (`'system' | 'models' | 'server'`)
- Tab buttons with active state styling (underline or background highlight)
- Conditional rendering based on active tab
- Layout structure: header, tab bar, scrollable content area

**4. global.css** - CSS variables, reset, dark theme
- CSS custom properties for colors, spacing, fonts
- Basic reset (box-sizing, margins, etc.)
- Dark theme defaults
- Typography setup

### Step 4: Common Components (3-4 hours)

**Files to create:**

```
renderer/components/common/
├── StatusIndicator.tsx        # Colored dot + label
├── ProgressBar.tsx           # Progress visualization
├── ActionButton.tsx          # Styled button variants
├── LogViewer.tsx             # Log display with scroll
├── Card.tsx                  # Container component
└── Spinner.tsx               # Loading spinner
```

**Component specifications:**

**1. StatusIndicator**
```typescript
interface Props {
  status: 'running' | 'stopped' | 'error' | 'loading' | 'healthy' | 'unhealthy';
  label: string;
}
```
- Colored circle (●) before label
- Green: running/healthy, Yellow: loading, Red: error/unhealthy, Gray: stopped

**2. ProgressBar**
```typescript
interface Props {
  current: number;
  total: number;
  showPercentage?: boolean;
  label?: string;
  className?: string;
}
```
- Visual bar showing progress
- Optional percentage text
- Optional label above bar

**3. ActionButton**
```typescript
interface Props {
  variant: 'primary' | 'danger' | 'secondary';
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}
```
- Primary: blue/prominent
- Danger: red (for delete, force stop)
- Secondary: gray/subtle
- Loading state: spinner + disabled
- Disabled state: grayed out

**4. LogViewer**
```typescript
interface Props {
  logs: Array<{ level: string; message: string; timestamp: string }>;
  autoScroll?: boolean;
  onClear?: () => void;
  height?: string;
}
```
- Monospace font
- Auto-scroll to bottom (optional)
- Color-coded by level (Info: white, Warn: yellow, Error: red)
- Clear button
- Fixed height with scrollbar

**5. Card**
```typescript
interface Props {
  title?: string;
  children: React.ReactNode;
  className?: string;
}
```
- Simple wrapper with padding, border, background
- Optional title header

**6. Spinner**
```typescript
interface Props {
  size?: 'small' | 'medium' | 'large';
  inline?: boolean;
}
```
- Rotating circle animation
- Size variants
- Inline or block display

### Step 5: System Info Tab (3-4 hours)

**Files to create:**

```
renderer/components/
├── SystemInfo.tsx             # Main component
└── hooks/
    └── useSystemInfo.ts       # Data fetching hook
```

**SystemInfo.tsx sections:**

**1. Hardware Display**
```typescript
<Card title="System Capabilities">
  <StatusIndicator status="healthy" label={`CPU: ${cores} cores (${arch})`} />
  <MemoryBar total={ramTotal} available={ramAvailable} label="RAM" />
  <StatusIndicator
    status={gpu.available ? 'healthy' : 'stopped'}
    label={`GPU: ${gpu.name || 'None'}`}
  />
  {gpu.available && (
    <MemoryBar total={vramTotal} available={vramAvailable} label="VRAM" />
  )}
  <ActionButton variant="secondary" onClick={refresh}>
    Refresh
  </ActionButton>
</Card>
```

**2. Recommendations**
```typescript
<Card title="Recommendations">
  <p>Maximum model size: {maxModelSize}</p>
  <p>Optimal GPU layers: {gpuLayers}</p>
  <h4>Suggested models:</h4>
  <ul>
    {recommendedModels.map(model => (
      <li key={model.name}>
        {model.name} {model.supported ? '✓ Supported' : '⚠ Marginal'}
      </li>
    ))}
  </ul>
</Card>
```

**3. Refresh functionality**
- Re-fetch system info
- Update display
- Show loading state during fetch

**useSystemInfo.ts hook:**
```typescript
function useSystemInfo() {
  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = async () => {
    setLoading(true);
    try {
      const data = await window.api.system.detect();
      setCapabilities(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetch(); }, []);

  return { capabilities, loading, error, refresh: fetch };
}
```

### Step 6: Model Management Tab (4-5 hours)

**Files to create:**

```
renderer/components/
├── ModelManager.tsx           # Main component
├── ModelList.tsx             # List of installed models
├── ModelDownloadForm.tsx     # Download form
└── hooks/
    └── useModels.ts          # Model state management
```

**ModelManager.tsx layout:**

**1. Installed Models Section**
```typescript
<Card title="Installed Models (LLM)">
  {models.length === 0 ? (
    <p>No models installed. Download one below.</p>
  ) : (
    <ModelList
      models={models}
      onDelete={handleDelete}
      onVerify={handleVerify}
    />
  )}
  <p>Disk Usage: {formatBytes(diskUsed)} / {formatBytes(diskTotal)}</p>
</Card>
```

**2. Download Section**
```typescript
<Card title="Download Model">
  <ModelDownloadForm
    onDownload={handleDownload}
    downloading={downloading}
    progress={downloadProgress}
  />
</Card>
```

**ModelList.tsx:**
- Table with columns: Name, Size, Downloaded, Actions
- Delete button (with confirmation dialog)
- Verify button (shows checksum status)
- Format dates and file sizes nicely

**ModelDownloadForm.tsx:**
- Form fields:
  - Source: Dropdown (URL / HuggingFace)
  - If URL: URL field
  - If HuggingFace: Repo field, File field
  - Name: Display name
  - Checksum (optional): For verification
- Submit button (disabled during download)
- Progress bar (visible during download)
- Status message (downloading, verifying, complete, error)

**useModels.ts hook:**
```typescript
function useModels() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState({ current: 0, total: 0 });

  const fetchModels = async () => {
    const data = await window.api.models.list('llm');
    setModels(data);
  };

  const handleDownload = async (config: DownloadConfig) => {
    setDownloading(true);
    // Listen to progress events
    window.api.on('download:progress', (downloaded, total) => {
      setDownloadProgress({ current: downloaded, total });
    });

    try {
      await window.api.models.download(config);
      await fetchModels(); // Refresh list
    } catch (err) {
      // Handle error
    } finally {
      setDownloading(false);
    }
  };

  const handleDelete = async (modelId: string) => {
    if (confirm('Delete this model?')) {
      await window.api.models.delete(modelId);
      await fetchModels();
    }
  };

  useEffect(() => { fetchModels(); }, []);

  return { models, downloading, downloadProgress, handleDownload, handleDelete };
}
```

### Step 7: LLM Server Control Tab (5-6 hours)

**Files to create:**

```
renderer/components/
├── LlamaServerControl.tsx     # Main component
├── ServerConfig.tsx          # Configuration form
├── TestChat.tsx              # Simple test interface
└── hooks/
    ├── useServerStatus.ts    # Status polling
    └── useServerLogs.ts      # Log fetching
```

**LlamaServerControl.tsx sections:**

**1. Status Display**
```typescript
<Card title="Server Status">
  <StatusIndicator status={status.status} label={status.status} />
  {status.status === 'running' && (
    <>
      <p>Model: {status.modelId}</p>
      <p>Port: {status.port}</p>
      <p>PID: {status.pid}</p>
      <StatusIndicator
        status={isHealthy ? 'healthy' : 'unhealthy'}
        label={isHealthy ? 'Healthy' : 'Unhealthy'}
      />
    </>
  )}
</Card>
```

**2. Configuration Form**
```typescript
<Card title="Configuration">
  <ServerConfig
    models={models}
    config={serverConfig}
    onChange={setServerConfig}
    autoConfig={autoConfig}
    onAutoConfigChange={setAutoConfig}
  />
  <ActionButton
    variant="primary"
    onClick={handleStart}
    disabled={status.status === 'running'}
  >
    Start Server
  </ActionButton>
  <ActionButton
    variant="danger"
    onClick={handleStop}
    disabled={status.status !== 'running'}
  >
    Stop Server
  </ActionButton>
  <ActionButton
    variant="secondary"
    onClick={handleRestart}
    disabled={status.status !== 'running'}
  >
    Restart
  </ActionButton>
</Card>
```

**ServerConfig.tsx:**
- Model dropdown (list of installed models)
- Auto-configure checkbox (default checked)
- Manual fields (disabled when auto-configure is on):
  - Context size (number input)
  - GPU layers (number input, 0 for CPU-only)
  - Thread count (number input)
  - Parallel slots (number input)
  - Flash attention (checkbox)
- Tooltips explaining each setting

**3. Logs Section**
```typescript
<Card title="Server Logs">
  <LogViewer
    logs={logs}
    autoScroll={true}
    onClear={handleClearLogs}
    height="300px"
  />
</Card>
```

**4. Test Chat**
```typescript
<Card title="Test Chat">
  <TestChat
    serverRunning={status.status === 'running'}
    port={status.port}
  />
</Card>
```

**TestChat.tsx:**

**Purpose**: Verify llama-server is working correctly (NOT a full chat UI - that's what genai-lite's chat-demo is for)

**Implementation:**
- Simple single-message interface (no conversation history)
- Input field for test message
- Send button (disabled when server not running)
- Response display area (shows single response, replaced on each test)
- Uses genai-lite's `LLMService` to send message to `localhost:${port}`
- Loading spinner during request
- Clear error display if server not responding
- Example message placeholder: "Hello, how are you?" or "Test: 2+2=?"

**useServerStatus.ts:**
```typescript
function useServerStatus() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [isHealthy, setIsHealthy] = useState(false);

  // Poll status every 3 seconds
  useEffect(() => {
    const fetchStatus = async () => {
      const newStatus = await window.api.server.status();
      setStatus(newStatus);

      if (newStatus.status === 'running') {
        const health = await window.api.server.health();
        setIsHealthy(health);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  const start = async (config: ServerConfig) => {
    await window.api.server.start(config);
  };

  const stop = async () => {
    await window.api.server.stop();
  };

  const restart = async () => {
    await window.api.server.restart();
  };

  // Listen to server events from main process
  useEffect(() => {
    window.api.on('server:started', () => {
      // Refresh status
    });
    window.api.on('server:stopped', () => {
      // Refresh status
    });
    window.api.on('server:crashed', (error) => {
      // Show error notification
    });
  }, []);

  return { status, isHealthy, start, stop, restart };
}
```

**useServerLogs.ts:**
```typescript
function useServerLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    const fetchLogs = async () => {
      const newLogs = await window.api.server.logs(100);
      setLogs(newLogs);
    };

    fetchLogs();
    const interval = setInterval(fetchLogs, 5000); // Every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const clearLogs = () => {
    setLogs([]);
  };

  return { logs, clearLogs };
}
```

### Step 8: Type Definitions (1-2 hours)

**Files to create:**

```
renderer/types/
├── index.ts                   # Main type exports
├── api.ts                    # IPC API types
└── ui.ts                     # UI-specific types
```

**api.ts** - Window API interface:
```typescript
export interface WindowAPI {
  system: {
    detect: () => Promise<SystemCapabilities>;
    getMemory: () => Promise<MemoryInfo>;
    canRunModel: (modelInfo: ModelInfo) => Promise<{ canRun: boolean; reason?: string }>;
    getOptimalConfig: (modelInfo: ModelInfo) => Promise<ServerConfig>;
  };
  models: {
    list: (type: 'llm' | 'diffusion') => Promise<ModelInfo[]>;
    download: (config: DownloadConfig) => Promise<void>;
    delete: (modelId: string) => Promise<void>;
    getInfo: (modelId: string) => Promise<ModelInfo>;
    verify: (modelId: string) => Promise<boolean>;
  };
  server: {
    start: (config: ServerConfig) => Promise<void>;
    stop: () => Promise<void>;
    restart: () => Promise<void>;
    status: () => Promise<ServerStatus>;
    health: () => Promise<boolean>;
    logs: (limit: number) => Promise<LogEntry[]>;
  };
  on: (channel: string, callback: (...args: any[]) => void) => void;
}

declare global {
  interface Window {
    api: WindowAPI;
  }
}
```

**ui.ts** - UI-specific types:
```typescript
export type TabName = 'system' | 'models' | 'server';

export interface ServerConfigForm {
  modelId: string;
  port: number;
  contextSize?: number;
  gpuLayers?: number;
  threads?: number;
  parallelSlots?: number;
  flashAttention?: boolean;
}

export interface DownloadFormData {
  source: 'url' | 'huggingface';
  url?: string;
  repo?: string;
  file?: string;
  name: string;
  checksum?: string;
}
```

### Step 9: Styling (2-3 hours)

**Files to create:**

```
renderer/styles/
├── variables.css              # CSS custom properties
├── components.css            # Component-specific styles
└── layout.css                # Layout and grid
```

**Design system (variables.css):**

```css
:root {
  /* Colors - Dark Theme */
  --bg-primary: #1e1e1e;
  --bg-secondary: #252525;
  --bg-tertiary: #2d2d2d;

  --text-primary: #e0e0e0;
  --text-secondary: #b0b0b0;
  --text-tertiary: #808080;

  --border-color: #3d3d3d;

  /* Status Colors */
  --status-green: #4caf50;
  --status-yellow: #ffc107;
  --status-red: #f44336;
  --status-gray: #9e9e9e;

  /* Accent Colors */
  --accent-blue: #2196f3;
  --accent-blue-hover: #1976d2;

  /* Spacing */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 12px;
  --spacing-lg: 16px;
  --spacing-xl: 24px;
  --spacing-xxl: 32px;

  /* Border Radius */
  --radius-sm: 4px;
  --radius-md: 8px;

  /* Fonts */
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'SF Mono', Monaco, 'Courier New', monospace;
}
```

**Global styles:**
- Dark theme by default
- Smooth transitions
- Focus styles for accessibility
- Scrollbar styling (dark theme)

**Component styles:**
- Card component: background, border, padding, shadow
- Button variants: primary (blue), danger (red), secondary (gray)
- Status indicators: colored dots with labels
- Progress bars: filled/unfilled styling
- Tabs: active/inactive states
- Log viewer: monospace, line numbers, color coding

### Step 10: Testing & Documentation (2-3 hours)

**Files to create:**

```
examples/electron-control-panel/
├── README.md                  # Setup, usage, features
└── docs/
    └── SCREENSHOTS.md        # Screenshots and walkthroughs
```

**README.md sections:**

1. **Overview**
   - Purpose of the app
   - What it demonstrates
   - Relationship to genai-electron library

2. **Prerequisites**
   - Node.js 22+
   - Platform-specific requirements (GPU drivers, etc.)

3. **Installation**
   ```bash
   cd examples/electron-control-panel
   npm install
   ```

4. **Running in Development**
   ```bash
   npm run dev
   ```

5. **Building for Production**
   ```bash
   npm run build
   npm run package  # Creates distributable
   ```

6. **First-Run Walkthrough**
   - Step 1: Explore System Info
   - Step 2: Download a Model
   - Step 3: Start LLM Server
   - Step 4: Test the Server
   - Step 5: View Logs
   - Step 6: Stop the Server

7. **Features**
   - System Info Tab: Hardware detection
   - Models Tab: Download, manage models
   - Server Tab: Control llama-server

8. **Troubleshooting**
   - Common errors and solutions
   - Platform-specific issues
   - How to report bugs

**Manual testing checklist:**

**System Info Tab:**
- [ ] Detects CPU cores and architecture correctly
- [ ] Shows total and available RAM
- [ ] Detects GPU (Metal on macOS, CUDA on Windows/Linux if present)
- [ ] Shows VRAM (if GPU present)
- [ ] Status indicators display correct colors
- [ ] Recommendations are sensible for the system
- [ ] Refresh button updates values

**Models Tab:**
- [ ] Lists installed models (or shows empty state)
- [ ] Download from direct URL works
- [ ] Download from HuggingFace works (repo + file)
- [ ] Progress bar updates during download
- [ ] Download completes and model appears in list
- [ ] Model info is accurate (size, date)
- [ ] Delete with confirmation works
- [ ] Disk usage shows correctly

**Server Tab:**
- [ ] Status indicator shows "stopped" initially
- [ ] Model dropdown populates with installed models
- [ ] Auto-configure is checked by default
- [ ] Manual config fields are disabled when auto is on
- [ ] Manual config fields enable when auto is off
- [ ] Start button works (server starts)
- [ ] Status changes to "running" with health check
- [ ] Port and PID display correctly
- [ ] Logs appear in real-time
- [ ] Test chat sends message and receives response
- [ ] Stop button works (server stops gracefully)
- [ ] Restart button works

**Error Handling:**
- [ ] Network failure during download shows error
- [ ] Insufficient disk space shows clear error
- [ ] Port already in use shows error
- [ ] Server crash displays error message
- [ ] Invalid model file shows error

**UI/UX:**
- [ ] No console errors in dev tools
- [ ] All buttons have clear labels
- [ ] Loading states visible during async operations
- [ ] Transitions are smooth
- [ ] Tab switching works correctly
- [ ] Responsive layout (no overflow issues)

---

## Timeline Estimate

**Total: 28-37 hours (3.5 to 5 days full-time)**

| Step | Description | Estimate |
|------|-------------|----------|
| 1 | Project Initialization | 2-3h |
| 2 | Main Process Setup | 3-4h |
| 3 | Renderer Base | 2-3h |
| 4 | Common Components | 3-4h |
| 5 | System Info Tab | 3-4h |
| 6 | Models Tab | 4-5h |
| 7 | Server Tab | 5-6h |
| 8 | Type Definitions | 1-2h |
| 9 | Styling | 2-3h |
| 10 | Testing & Docs | 2-3h |

**Development approach:** Sequential implementation - complete each step before moving to the next to avoid dependency issues.

---

## Success Criteria

### Functional Requirements

- ✅ **System Info**: Detects CPU, RAM, GPU, VRAM correctly on macOS, Windows, Linux
- ✅ **Model Download**: Downloads from URLs and HuggingFace with progress tracking
- ✅ **Model Management**: Lists, deletes models; shows disk usage
- ✅ **Server Control**: Starts, stops, restarts llama-server successfully
- ✅ **Configuration**: Auto-configure works; manual override works
- ✅ **Health Monitoring**: Health checks update correctly
- ✅ **Logs**: Real-time log display with auto-scroll
- ✅ **Test Chat**: Sends message to server and displays response
- ✅ **Error Handling**: All error states handled with clear messages

### Technical Requirements

- ✅ **Zero TypeScript Errors**: All code compiles without errors
- ✅ **Clean Build**: No warnings during build
- ✅ **Cross-Platform**: Works on macOS, Windows, Linux
- ✅ **Security**: IPC uses contextBridge (no nodeIntegration)
- ✅ **Performance**: No memory leaks during long sessions
- ✅ **Code Quality**: Follows library conventions and style

### UI/UX Requirements

- ✅ **Developer Aesthetic**: Functional, not consumer-polished
- ✅ **Status Indicators**: Update correctly and clearly
- ✅ **Loading States**: Visible for all async operations
- ✅ **Error Messages**: Clear, actionable recovery suggestions
- ✅ **Accessibility**: Keyboard navigation, focus styles
- ✅ **Responsiveness**: Layout works at different window sizes

---

## Future Work (Phase 2+)

**Not included in this implementation:**

### Phase 2 Features (Future)
- Diffusion Server tab
- Resource Monitor tab
- Automatic resource management (offload/reload)
- VRAM/RAM usage graphs
- Event timeline

### Phase 3 Features (Future)
- Pause/resume downloads
- Download queue
- Event log viewer
- Enhanced checksum verification

### Phase 4 Features (Future)
- Storage mode configuration (isolated/shared/custom)
- Binary version management
- Port conflict resolution
- Advanced restart policies

These will be added in subsequent phases as the genai-electron library implements those capabilities.

---

## File Summary

**Total: ~40 files to create**

| Category | Count | Files |
|----------|-------|-------|
| Project Config | 6 | package.json, tsconfig.json, vite.config.ts, forge.config.js, .gitignore, README.md |
| Main Process | 4 | index.ts, preload.ts, ipc-handlers.ts, genai-api.ts |
| Renderer Base | 4 | index.html, index.tsx, App.tsx, global.css |
| Common Components | 6 | StatusIndicator, ProgressBar, ActionButton, LogViewer, Card, Spinner |
| System Info | 2 | SystemInfo.tsx, useSystemInfo.ts |
| Models | 4 | ModelManager.tsx, ModelList.tsx, ModelDownloadForm.tsx, useModels.ts |
| Server | 5 | LlamaServerControl.tsx, ServerConfig.tsx, TestChat.tsx, useServerStatus.ts, useServerLogs.ts |
| Types | 3 | index.ts, api.ts, ui.ts |
| Styles | 3 | variables.css, components.css, layout.css |
| Documentation | 2 | README.md, SCREENSHOTS.md |

---

## Implementation Notes

### IPC Communication Pattern

**Main Process → Renderer:**
```typescript
// In ipc-handlers.ts
ipcMain.handle('system:detect', async () => {
  return await systemInfo.detect();
});

// In preload.ts
contextBridge.exposeInMainWorld('api', {
  system: {
    detect: () => ipcRenderer.invoke('system:detect')
  }
});

// In renderer
const capabilities = await window.api.system.detect();
```

**Renderer → Main Process (Events):**
```typescript
// In main process
webContents.send('download:progress', downloaded, total);

// In preload
window.api.on('download:progress', (callback) => {
  ipcRenderer.on('download:progress', (_, ...args) => callback(...args));
});

// In renderer
window.api.on('download:progress', (downloaded, total) => {
  setProgress({ current: downloaded, total });
});
```

### State Management

Use simple React hooks - no Redux/Zustand needed for this app:

```typescript
// Global state via Context (if needed)
const AppContext = React.createContext<AppState>(/* ... */);

// Feature-specific hooks
const useServerStatus = () => {
  // Poll status, manage server state
};

const useModels = () => {
  // Manage model list, download state
};
```

### Error Handling

**In Main Process:**
```typescript
ipcMain.handle('server:start', async (_, config) => {
  try {
    await llamaServer.start(config);
  } catch (error) {
    if (error instanceof InsufficientResourcesError) {
      throw new Error(`Not enough RAM: ${error.details.suggestion}`);
    }
    throw error;
  }
});
```

**In Renderer:**
```typescript
try {
  await window.api.server.start(config);
} catch (error) {
  setError(error.message);
  // Show toast notification or inline error
}
```

---

## Next Steps

After plan approval:

1. ✅ Create `PLAN.md` (this document)
2. Create `examples/electron-control-panel/` directory
3. Initialize `package.json` with dependencies
4. Set up TypeScript configurations (main + renderer)
5. Implement Steps 2-10 sequentially
6. Test on all platforms (macOS, Windows, Linux)
7. Document usage and features
8. Commit to repository

---

**Document Version**: 1.0
**Last Updated**: 2025-10-16
**Status**: Ready for Implementation
