# Integration Guide

Best practices and patterns for integrating genai-electron into Electron applications. Covers initialization, lifecycle management, error handling, and integration with genai-lite.

## Navigation

- [Initialization](#initialization)
- [Lifecycle Management](#lifecycle-management)
- [Error Handling](#error-handling)
- [Integration with genai-lite](#integration-with-genai-lite)
- [Best Practices](#best-practices)
- [Common Patterns](#common-patterns)

---

## Initialization

### App Ready Requirement

genai-electron depends on Electron's `app.getPath('userData')` for model and binary storage. **Must initialize after Electron's 'ready' event.**

**Correct:**
```typescript
import { app } from 'electron';
import { systemInfo, llamaServer } from 'genai-electron';

app.whenReady().then(async () => {
  // Safe to use genai-electron here
  const capabilities = await systemInfo.detect();
  console.log('System capabilities:', capabilities);

  await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
}).catch(console.error);
```

**Incorrect:**
```typescript
import { systemInfo } from 'genai-electron';

// ❌ Don't use before app is ready
const capabilities = await systemInfo.detect(); // Will fail!

app.whenReady().then(() => {
  // ...
});
```

---

## Lifecycle Management

### attachAppLifecycle()

Attach automatic cleanup handlers for graceful server shutdown on app quit.

**Function Signature:**
```typescript
attachAppLifecycle(
  app: App,
  managers: {
    llamaServer?: LlamaServerManager;
    diffusionServer?: DiffusionServerManager;
  }
): void
```

**Example (Both Servers):**
```typescript
import { app } from 'electron';
import { attachAppLifecycle, llamaServer, diffusionServer } from 'genai-electron';

app.whenReady().then(async () => {
  // Start your servers...
  await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
  await diffusionServer.start({ modelId: 'sdxl-turbo', port: 8081 });

  // Attach automatic cleanup
  attachAppLifecycle(app, { llamaServer, diffusionServer });
});
```

**Example (LLM Only):**
```typescript
import { app } from 'electron';
import { attachAppLifecycle, llamaServer } from 'genai-electron';

app.whenReady().then(() => {
  attachAppLifecycle(app, { llamaServer });
});
```

**Behavior:**
1. Registers `before-quit` event listener
2. Prevents default quit to allow cleanup
3. Stops all running servers gracefully (checks status first)
4. Logs cleanup progress to console
5. Exits app with code 0 after cleanup

---

## Error Handling

### formatErrorForUI()

Convert library errors to consistent, user-friendly format with actionable remediation steps.

**Function Signature:**
```typescript
formatErrorForUI(error: unknown): UIErrorFormat

interface UIErrorFormat {
  code: string;           // Error code for programmatic handling
  title: string;          // Short, human-readable title
  message: string;        // Detailed error message
  remediation?: string;   // Optional suggested remediation
}
```

**Example (Basic Usage):**
```typescript
import { formatErrorForUI, llamaServer } from 'genai-electron';

try {
  await llamaServer.start(config);
} catch (error) {
  const formatted = formatErrorForUI(error);
  console.error(`${formatted.title}: ${formatted.message}`);

  if (formatted.remediation) {
    console.log('Suggestion:', formatted.remediation);
  }
}
```

**Example (IPC Handler):**
```typescript
import { ipcMain } from 'electron';
import { formatErrorForUI, llamaServer } from 'genai-electron';

ipcMain.handle('server:start', async (_event, config) => {
  try {
    await llamaServer.start(config);
    return { success: true };
  } catch (error) {
    const formatted = formatErrorForUI(error);

    // Send formatted error to renderer
    return {
      success: false,
      error: formatted
    };
  }
});
```

### Error Codes Reference

| Error Class | Code | Title | Remediation Example |
|-------------|------|-------|---------------------|
| ModelNotFoundError | MODEL_NOT_FOUND | Model Not Found | Check that the model ID is correct... |
| DownloadError | DOWNLOAD_FAILED | Download Failed | Check your internet connection... |
| InsufficientResourcesError | INSUFFICIENT_RESOURCES | Not Enough Resources | Try closing other applications... |
| PortInUseError | PORT_IN_USE | Port Already In Use | Choose a different port... |
| ServerError | SERVER_ERROR | Server Error | Check the server logs... |
| FileSystemError | FILE_SYSTEM_ERROR | File System Error | Check permissions and disk space... |
| ChecksumError | CHECKSUM_ERROR | Checksum Verification Failed | The file may be corrupted... |
| BinaryError | BINARY_ERROR | Binary Error | Try restarting to trigger fresh download... |
| GenaiElectronError | (varies) | Operation Failed | (from error details) |
| Error | UNKNOWN_ERROR | Unknown Error | Please try again... |

**Benefits:**
- Eliminates brittle substring matching on error messages
- Provides consistent error format across all apps
- Includes actionable remediation suggestions
- Safe handling of unknown error types
- Suitable for both console logging and UI display

---

## Integration with genai-lite

### Separation of Concerns

**genai-electron:** Manages infrastructure (servers, binaries, resources)
**genai-lite:** Provides unified API (LLMService, ImageService)

```
┌────────────────────────────────────────────────────────────┐
│                  Electron Application                      │
│                                                            │
│  ┌──────────────┐        ┌────────────────────────────┐  │
│  │  genai-lite  │◄───────│   genai-electron           │  │
│  │  (API layer) │        │   (Runtime manager)        │  │
│  │              │        │                            │  │
│  │ • LLMService │        │ • ModelManager             │  │
│  │ • ImageServ. │        │ • LlamaServerManager       │  │
│  │              │        │ • DiffusionServerManager   │  │
│  │              │        │ • ResourceOrchestrator     │  │
│  └──────┬───────┘        └──────┬─────────────────────┘  │
│         │                       │                        │
└─────────┼───────────────────────┼────────────────────────┘
          │                       │
          │ HTTP requests         │ spawns/manages
          │                       ▼
          │              ┌─────────────────┐
          ├─────────────►│  llama-server   │
          │              │  (port 8080)    │
          │              └─────────────────┘
          │              ┌─────────────────┐
          └─────────────►│  HTTP wrapper   │
                         │  (port 8081)    │
                         └─────────────────┘
```

### Integration Pattern

**Main Process** (infrastructure management):
```typescript
import { app } from 'electron';
import { LLMService } from 'genai-lite';
import {
  systemInfo,
  modelManager,
  llamaServer,
  diffusionServer,
  attachAppLifecycle
} from 'genai-electron';

app.whenReady().then(async () => {
  // 1. Detect capabilities
  await systemInfo.detect();

  // 2. Start servers
  await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
  await diffusionServer.start({ modelId: 'sdxl-turbo', port: 8081 });

  // 3. Create LLM service (talks to servers)
  const llmService = new LLMService(async () => 'not-needed');

  // 4. Setup IPC handlers for renderer
  setupIPCHandlers(llmService);

  // 5. Attach lifecycle cleanup
  attachAppLifecycle(app, { llamaServer, diffusionServer });
});
```

**Example IPC Handler:**
```typescript
import { ipcMain } from 'electron';
import { LLMService } from 'genai-lite';

function setupIPCHandlers(llmService: LLMService) {
  ipcMain.handle('llm:sendMessage', async (_event, request) => {
    const response = await llmService.sendMessage({
      providerId: 'llamacpp',
      modelId: request.modelId,
      messages: request.messages
    });

    return response;
  });
}
```

---

## Best Practices

### System Detection on Startup

Always detect capabilities on startup to show users their system status:

```typescript
app.whenReady().then(async () => {
  const capabilities = await systemInfo.detect();

  // Log to console
  console.log('System Info:');
  console.log('  CPU:', capabilities.cpu.cores, 'cores');
  console.log('  RAM:', (capabilities.memory.total / 1024 ** 3).toFixed(1), 'GB');
  console.log('  GPU:', capabilities.gpu.available ? capabilities.gpu.name : 'none');

  // Send to renderer for UI display
  mainWindow.webContents.send('system-info', capabilities);
});
```

### Auto-Configuration vs Manual

Prefer auto-configuration for better user experience:

```typescript
// ✅ Good: Auto-configuration
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080
  // threads, gpuLayers, contextSize auto-detected
});

// ⚠️ Advanced: Manual configuration (for power users)
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  threads: 8,
  gpuLayers: 35,
  contextSize: 8192
});
```

### Event-Driven UI Updates

Use server events for reactive UI updates:

```typescript
import { llamaServer } from 'genai-electron';

// Register event listeners
llamaServer.on('started', () => {
  mainWindow.webContents.send('server-status', { status: 'running' });
});

llamaServer.on('stopped', () => {
  mainWindow.webContents.send('server-status', { status: 'stopped' });
});

llamaServer.on('crashed', (error) => {
  mainWindow.webContents.send('server-status', { status: 'crashed', error: error.message });
});
```

### Health Monitoring Pattern

Periodically check server health for UI status indicators:

```typescript
import { llamaServer } from 'genai-electron';

// Check health every 5 seconds
setInterval(async () => {
  const healthy = await llamaServer.isHealthy();
  mainWindow.webContents.send('server-health', { healthy });
}, 5000);

// Or trigger on server start/stop events
llamaServer.on('started', async () => {
  const healthy = await llamaServer.isHealthy();
  mainWindow.webContents.send('server-health', { healthy });
});
```

### Log Streaming to Renderer

Use structured logs for better UI display:

```typescript
import { llamaServer } from 'genai-electron';

ipcMain.handle('server:getLogs', async () => {
  const logs = await llamaServer.getStructuredLogs(100);

  // Filter and format for UI
  return logs.map(entry => ({
    timestamp: new Date(entry.timestamp).toLocaleTimeString(),
    level: entry.level,
    message: entry.message
  }));
});
```

### Model Download Progress

Stream download progress to renderer via IPC:

```typescript
import { modelManager } from 'genai-electron';

ipcMain.handle('model:download', async (_event, config) => {
  await modelManager.downloadModel({
    ...config,
    onProgress: (downloaded, total) => {
      const percentage = (downloaded / total) * 100;

      // Send progress to renderer
      mainWindow.webContents.send('download-progress', {
        modelId: config.name,
        downloaded,
        total,
        percentage
      });
    }
  });

  return { success: true };
});
```

---

## Common Patterns

### Resource Monitoring (Real-Time)

```typescript
// Periodic memory checks
setInterval(async () => {
  const memory = systemInfo.getMemoryInfo();
  const usage = (memory.used / memory.total) * 100;

  mainWindow.webContents.send('memory-usage', {
    total: memory.total,
    used: memory.used,
    available: memory.available,
    percentage: usage
  });
}, 2000);
```

### Server Lifecycle via IPC

```typescript
ipcMain.handle('server:start', async (_event, config) => {
  try {
    await llamaServer.start(config);
    return { success: true };
  } catch (error) {
    return { success: false, error: formatErrorForUI(error) };
  }
});

ipcMain.handle('server:stop', async () => {
  try {
    await llamaServer.stop();
    return { success: true };
  } catch (error) {
    return { success: false, error: formatErrorForUI(error) };
  }
});

ipcMain.handle('server:getStatus', () => {
  return llamaServer.getInfo();
});
```

---

## See Also

- [Installation and Setup](installation-and-setup.md) - Initial setup
- [System Detection](system-detection.md) - SystemInfo API
- [LLM Server](llm-server.md) - LlamaServerManager API
- [Image Generation](image-generation.md) - DiffusionServerManager API
- [Example Control Panel](example-control-panel.md) - Reference implementation
- [Troubleshooting](troubleshooting.md) - Common issues
