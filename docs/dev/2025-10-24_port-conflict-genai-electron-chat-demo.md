# Port Conflict: genai-electron Control Panel vs chat-demo Backend

**Date:** 2025-10-24
**Status:** Resolved (2025-10-24)
**Severity:** High (prevents chat-demo from working when genai-electron is running)
**Resolution:** Changed electron-control-panel port from 3000 to 3100

## Issue Summary

When running genai-electron's control panel and genai-lite's chat-demo simultaneously, the chat-demo frontend fails with a JSON parsing error: `Unexpected token '<', "<!doctype "... is not valid JSON`. This is caused by both applications defaulting to port 3000, creating a port conflict.

## Problem Description

### What Happens

1. User starts genai-electron control panel (Electron app)
   - Vite dev server starts on port 3000
   - Serves the control panel UI

2. User starts chat-demo with `npm run dev`
   - Backend claims to start on port 3000
   - Frontend starts on port 5173 (proxies to port 3000)

3. Frontend makes API request to `/api/presets`
   - Vite proxy forwards to `http://localhost:3000/api/presets`
   - Request hits genai-electron's Vite server (not chat-demo backend)
   - genai-electron returns its index.html (SPA fallback)
   - Frontend tries to parse HTML as JSON → error

### Error Messages

**Browser Console:**
```
Failed to load presets: SyntaxError: Unexpected token '<', "<!doctype "... is not valid JSON
```

**Backend Console:**
```
Error fetching llama.cpp models: TypeError: fetch failed
[cause]: AggregateError [ECONNREFUSED]
```

**Direct Test (`curl http://localhost:3000/api/presets`):**
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>genai-electron Control Panel</title>
  </head>
  ...
</html>
```

## Root Cause

Both applications use port 3000 by default:

- **genai-electron**: Vite dev server configured in `forge.config.ts` (renderer process)
- **chat-demo**: Express backend defaults to port 3000 in `server/index.ts`

Express's `.listen()` may not properly fail if another process already has the port bound, leading to misleading log messages claiming the server is running.

## Investigation Steps

1. **Check what's on port 3000:**
   ```bash
   curl http://localhost:3000/api/presets
   # Returns HTML with "genai-electron Control Panel" in title
   ```

2. **Check genai-electron startup logs:**
   ```
   √ [plugin-vite] Preparing Vite bundles
     ➜  Local:   http://localhost:3000/
   ```

3. **Check chat-demo startup logs:**
   ```
   🚀 Backend server running on http://localhost:3000
   ```

4. **Verify ports in use:**
   - Windows: `netstat -ano | findstr :3000`
   - Linux/Mac: `lsof -i :3000` or `netstat -an | grep 3000`

## Solution Options

### Option 1: Auto-detect Available Port (Most Robust)

Use a library like `get-port` to automatically find an available port.

**Implementation:**
```typescript
// examples/chat-demo/server/index.ts
import getPort from 'get-port';

const PORT = await getPort({ port: 3000 }); // Tries 3000, then finds next available
app.listen(PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${PORT}`);
});

// Update Vite to use dynamic port (requires additional setup)
```

**Pros:**
- Automatically finds available port
- Works regardless of what else is running
- Industry standard approach
- Prevents all port conflicts

**Cons:**
- Requires adding `get-port` dependency
- Vite proxy configuration becomes more complex (needs dynamic config or env variable)
- Backend and frontend configs must be synchronized

**Files to modify:**
- `examples/chat-demo/package.json` (add get-port)
- `examples/chat-demo/server/index.ts` (use get-port)
- `examples/chat-demo/vite.config.ts` (read port from env or config file)

### Option 2: Change genai-electron's Port (Recommended)

Configure genai-electron's Vite dev server to use a less common port (e.g., 3100).

**Implementation:**
```typescript
// genai-electron's forge.config.ts or vite config
server: {
  port: 3100,  // Changed from default 3000
}
```

**Pros:**
- Port 3000 is the de facto standard for Node.js/Express backends
- Simple one-time configuration change
- genai-electron is the "special case" (Electron app UI, not standard web backend)
- Fixes root cause rather than working around it
- No dependency changes needed

**Cons:**
- Still hardcoded (but 3100 is less commonly used)
- Requires modifying genai-electron

**Files to modify:**
- `genai-electron/forge.config.ts` or Vite renderer config
- genai-electron documentation (update default port references)

### Option 3: Better Error Handling

Make chat-demo detect port conflicts and provide clear error messages.

**Implementation:**
```typescript
// examples/chat-demo/server/index.ts
app.listen(PORT, () => {
  console.log(`🚀 Backend server running on http://localhost:${PORT}`);
}).on('error', (error: any) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use!`);
    console.error(`   Another application (possibly genai-electron) is using this port.`);
    console.error(`   Solutions:`);
    console.error(`   1. Stop the other application`);
    console.error(`   2. Set PORT environment variable: PORT=3001 npm run dev`);
    console.error(`   3. Change genai-electron to use a different port`);
    process.exit(1);
  }
  throw error;
});
```

**Pros:**
- Clear error message with actionable steps
- Simple to implement
- No dependencies

**Cons:**
- Doesn't prevent the conflict, just reports it
- Still requires manual intervention
- User experience: have to restart with different port

**Files to modify:**
- `examples/chat-demo/server/index.ts`

## Recommended Solution

**Option 2: Change genai-electron's Vite port to 3100**

**Rationale:**
1. Port 3000 is the conventional default for Node.js backend development
2. genai-lite's chat-demo (and potentially other demos/integrations) will expect port 3000
3. genai-electron is an Electron application UI, not a standard web backend
4. Port 3100 is less commonly used but still in the "user ports" range
5. This is a one-time fix that prevents future conflicts

**Alternative:** If genai-electron commonly runs alongside other tools, Option 1 (auto-detect) would be even better but requires more implementation work.

## Implementation (2025-10-24)

**Status:** ✅ Resolved

**Changes Made:**
1. Updated `examples/electron-control-panel/vite.config.ts`
   - Changed `server.port` from `3000` to `3100`

**Result:**
- electron-control-panel now runs on port 3100 (Vite dev server)
- chat-demo backend can run on port 3000 (Express server)
- Both applications can run simultaneously without conflict

**Port Allocation After Fix:**
- **Port 3000:** chat-demo backend (Express)
- **Port 3100:** electron-control-panel UI (Vite dev server)
- **Port 5173:** chat-demo frontend (Vite dev server)
- **Port 8080:** llama-server (managed by genai-electron)
- **Port 8081:** diffusion-server (managed by genai-electron)

## Implementation Notes

### For genai-electron (Recommended Fix)

1. Locate Vite configuration for renderer process (likely in `forge.config.ts`)
2. Set `server.port` to 3100
3. Update documentation to reference port 3100
4. Update any hardcoded references to localhost:3000

### For chat-demo (Temporary Workaround)

If changing genai-electron is not immediately possible:

1. Create or update `.env` file:
   ```bash
   PORT=3001
   ```

2. Update `vite.config.ts`:
   ```typescript
   proxy: {
     '/api': {
       target: 'http://localhost:3001',  // Changed from 3000
       changeOrigin: true,
     },
   }
   ```

3. Document this in chat-demo's README

## Related Files

- `examples/chat-demo/server/index.ts` - Express server initialization
- `examples/chat-demo/vite.config.ts` - Vite proxy configuration
- `examples/chat-demo/.env` - Environment variables (PORT)
- `examples/chat-demo/README.md` - User documentation
- genai-electron's `forge.config.ts` - Vite renderer configuration

## Architecture Context

### Current Port Usage

When both applications run:
- **Port 3000:** CONFLICT (both want it)
- **Port 5173:** chat-demo frontend (Vite dev server)
- **Port 8080:** llama-server (managed by genai-electron)

### Intended Port Usage (After Fix)

- **Port 3000:** chat-demo backend (Express)
- **Port 3100:** genai-electron UI (Vite)
- **Port 5173:** chat-demo frontend (Vite)
- **Port 8080:** llama-server (managed by genai-electron)

## Testing the Fix

### Verify Port Availability
```bash
# Check what's listening on port 3000
# Linux/Mac:
lsof -i :3000

# Windows:
netstat -ano | findstr :3000
```

### Test Backend Directly
```bash
curl http://localhost:3000/api/health
# Should return JSON: {"status":"ok","message":"genai-lite chat demo backend is running",...}
```

### Test Presets Endpoint
```bash
curl http://localhost:3000/api/presets
# Should return JSON with presets array
```

### Test Frontend
1. Start both applications
2. Access http://localhost:5173
3. Open browser DevTools console
4. Should see no JSON parsing errors
5. Presets should load successfully

## Prevention

### For Future Examples/Demos

1. **Document port requirements** in README files
2. **Use environment variables** for ports (never hardcode)
3. **Add port conflict error handling** (Option 3 above)
4. **Consider auto-detection** for production-quality examples

### For genai-electron

1. **Use less common port** (3100 instead of 3000)
2. **Document the port** clearly in README
3. **Make it configurable** via environment variable
4. **Consider port conflict detection** on startup

## Related Issues

- None currently documented

## References

- Express `.listen()` documentation: https://expressjs.com/en/api.html#app.listen
- Vite server configuration: https://vitejs.dev/config/server-options.html
- Node.js port ranges: https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback
- get-port library: https://github.com/sindresorhus/get-port
