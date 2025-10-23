# LIBRARY-EXTRACTION-PLAN.md

**Promoting stable, reusable pieces from the example app into `genai-electron`—without premature lock-in**

**Audience:** Junior devs new to the codebase
**Status:** Proposed plan
**Scope:** What to move now vs. later, why, and exactly how to do it safely

---

## 1) Context & Goals

`genai-electron` (the library) is production-ready for Phase 1 & 2 (LLM + image generation). The example app (`examples/electron-control-panel`) demonstrates how to use it.

We want to promote some app-side pieces into the base library **only where it reduces duplication and risk**—while **avoiding premature optimization**. Phase 3 work (resume/cancel downloads, stronger checksums, queueing) will change a few surfaces, so we’ll promote only what’s low-churn now and defer the rest.

**Goals**

* Reduce drift between app and library (especially types & logs).
* Improve developer ergonomics with **additive** utilities (no breaking changes).
* Keep the core library **headless**: no UI/React in core.

---

## 2) TL;DR Decisions

### Move now (safe, low churn)

1. **Type Consolidation** (use existing exports)
2. **Structured Logs API** (additive method alongside existing logs)
3. **Lifecycle/Cleanup Helper** (tiny optional utility)
4. **Error Normalization Helper** (map library errors → UI-friendly shape)

### Defer until Phase 3 stabilizes

5. IPC bridge & preload surface (channel names/payloads still evolving)
6. Runtime monitor/usage aggregator contracts (orchestration & multi-model will evolve)
7. Standardized download event contract (resume/cancel/queue affects semantics)
8. HTTP client wrappers for local servers (paths/params still moving)
9. React hooks (`useServerStatus`, `useModels`, etc.) → future `genai-electron-react`
10. Event forwarding bridge (bundle with IPC bridge later)

---

## 3) Why this split?

* **“Move now” items** remove duplication (types), eliminate footguns (string-parsing logs), and make apps easier to shut down cleanly—**without** locking us into unstable contracts.
* **“Defer” items** depend on Phase 3/4 behavior (downloads, orchestration, multi-model queues). Promoting them now risks churn and breaking changes.

---

## 4) What exactly to move now (and how)

> The steps below are additive and safe. They won’t break current apps.

### 4.1 Type Consolidation (use existing exports)

**Problem:** `src/index.ts` already re-exports the stable type surface, but the example app still maintains duplicate definitions in `renderer/types/*`, which leads to drift and extra maintenance.

**Plan:**

* Replace the duplicated interfaces in `renderer/types` (or turn them into thin re-exports) with imports from `'genai-electron'`.
* If any fields differ, bring the example app into alignment with the library types to maintain compatibility.

**Acceptance Criteria:**

* Example app compiles using only the library’s exported types (no bespoke duplication).
* No type drift between the library and the example app after the change.

---

### 4.2 Structured Logs API (additive)

**Today in app:** `examples/electron-control-panel/main/ipc-handlers.ts` still calls `getLogs()` and manually parses each string with `LogManager.parseEntry`. Every consumer would need to repeat this logic.

**Plan:**

* Add a **new** method on each server manager:

  * `llamaServer.getStructuredLogs(limit?: number): Promise<LogEntry[]>`
  * `diffusionServer.getStructuredLogs(limit?: number): Promise<LogEntry[]>`
* Keep the existing `getLogs()` (raw strings) for backwards compatibility.
* Internally reuse `LogManager.parseEntry`, returning `{ timestamp, level, message }`.

**Acceptance Criteria:**

* Example app switches to `getStructuredLogs()` and removes manual parsing / fallback logic.
* `LogViewer` displays logs exactly as before.

**Example usage (app):**

```ts
const logs = await llamaServer.getStructuredLogs(100);
// logs: Array<{ timestamp: string; level: 'info' | 'warn' | 'error' | 'debug'; message: string }>
```

---

### 4.3 Lifecycle/Cleanup Helper

**Today in app:** `examples/electron-control-panel/main/genai-api.ts` exposes `cleanupServers()`, and `main/index.ts` wires `before-quit` manually.

**Plan:**

* Provide an optional helper in the library, e.g.:

  * `attachAppLifecycle(app, { llamaServer, diffusionServer })`
  * Internally register a safe `before-quit` listener and stop any running servers.

**Acceptance Criteria:**

* Example app replaces the custom `cleanupServers` wiring with the helper.
* Consumers who prefer custom logic can ignore it (no breaking change).

**Example usage:**

```ts
import { attachAppLifecycle, llamaServer, diffusionServer } from 'genai-electron';
attachAppLifecycle(app, { llamaServer, diffusionServer });
```

---

### 4.4 Error Normalization Helper

**Today in app:** `ipc-handlers.ts` performs brittle substring checks on `Error.message` for RAM/port/model scenarios.

**Plan:**

* Add helper: `formatErrorForUI(error: unknown): { code: string; title: string; message: string; remediation?: string }`
* Map known library error classes (`InsufficientResourcesError`, `DownloadError`, `ModelNotFoundError`, etc.) to consistent codes/messages.
* Keep it **additive**—apps can opt in gradually.

**Acceptance Criteria:**

* Example app consumes `formatErrorForUI()` in the relevant IPC handlers and removes the substring checks.
* Calls stay simple and readable; renderer gets stable error metadata.

**Example usage (app):**

```ts
try {
  await llamaServer.start(config);
} catch (e) {
  const ui = formatErrorForUI(e);
  throw new Error(`${ui.title}: ${ui.message}`);
}
```

---

## 5) What to defer (and why)

### 5.1 IPC Bridge & Preload Surface

* The set of channels, payload shapes, and events will likely change with download resume/cancel and resource orchestration.
* **Defer** to a dedicated package later:

  * `genai-electron-bridge` (typed IPC handlers + event forwarding)
  * `genai-electron-react` (hooks built atop the bridge)

### 5.2 Runtime Monitor / Usage Aggregator

* Orchestrator and multi-model queueing will reshape “unified status”.
* Keep the aggregator logic in the example app for now.
* Promote later once states and semantics stabilize.

### 5.3 Standardized Download Event Contract

* Phase 3 will introduce resume/cancel/queue which affects event lifecycle (IDs, state transitions).
* Define and promote when full lifecycle is known.

### 5.4 HTTP Clients for Local Servers

* Endpoints and params may evolve; not urgent today.

### 5.5 React Hooks

* Valuable, but best shipped after the bridge stabilizes.
* Target a separate `genai-electron-react` package.

### 5.6 Event Forwarding Bridge

* Bundle it with the IPC bridge to version the contract end-to-end.

---

## 6) Step-by-Step: Implementation Plan

> Create a feature branch: `feat/library-extraction-phase-1`

### Step A — Export Types from Library

1. Identify types used in the app:

   * `SystemCapabilities`, `MemoryInfo`
   * `LlamaServerConfig`, `ServerStatus`, `DiffusionServerInfo`
   * `ImageGenerationConfig`, `ImageGenerationResult`
   * `ResourceUsage`, `SavedLLMState`
   * `LogEntry`, `BinaryLogEvent`
2. Ensure each exists in `src/types/*`. If missing, add minimal definitions that match current app usage.
3. Re-export from `src/index.ts`.
4. In the example app, replace local imports with:

   ```ts
   import type { ... } from 'genai-electron';
   ```
5. Build & run app; fix any minor mismatches.

**Definition of Done:**

* Renderer compiles with only library-imported types.
* No duplicate type definitions remain in the renderer.

---

### Step B — Add Structured Logs

1. Add `getStructuredLogs(limit?: number)` in:

   * `LlamaServerManager`
   * `DiffusionServerManager`
2. Internally use the existing `LogManager` to parse lines.
3. Keep `getLogs()` as-is.
4. Update example app’s IPC `server:logs`/`diffusion:logs` handlers to call `getStructuredLogs()` and **stop** doing manual parsing.

**Definition of Done:**

* `LogViewer` renders the same.
* No manual string parsing in the app layer.

---

### Step C — Lifecycle Helper

1. Add utility in library (e.g., `src/utils/electron-lifecycle.ts`):

   * `attachAppLifecycle(app, managers)` registers `before-quit` and gracefully stops running servers.
2. Update example app:

   * Remove `cleanupServers()` and the manual `before-quit` code.
   * Call `attachAppLifecycle(app, { llamaServer, diffusionServer })`.

**Definition of Done:**

* App quits cleanly via the helper.
* Behavior identical across platforms.

---

### Step D — Error Normalization Helper

1. Implement `formatErrorForUI(error)` in the library:

   * Map known error classes → `{ code, title, message, remediation? }`
   * Fallback for unknown errors → `code: 'unknown_error'`
2. Update `ipc-handlers.ts`:

   * Use `formatErrorForUI()` in error branches.
   * Remove substring matching.

**Definition of Done:**

* IPC handlers use formatted UI errors.
* Error messages remain at least as helpful as before.

---

## 7) Testing & Validation

**Local:**

* Build the library (`npm run build`) and the example app.
* Run the app; verify:

  * Logs still show and filter properly.
  * Start/stop/restart LLM server works and errors look clean.
  * Diffusion server controls still function.
  * App exits cleanly on all OSes.

**Cross-platform sanity:**

* Smoke test on Windows, macOS, and Linux if possible:

  * Start/stop both servers
  * Generate an image
  * View logs
  * Quit app

**Automated:**

* Add unit tests for:

  * `formatErrorForUI`
  * `getStructuredLogs` (with representative log lines)

---

## 8) Versioning & Rollout

* **Type exports:** Patch or minor (non-breaking, but useful).
* **Structured logs:** Additive → minor.
* **Lifecycle helper:** Additive → minor.
* **Error normalization helper:** Additive → minor.

**Changelog notes:**

* “Added: consolidated type imports from `genai-electron` (removed renderer duplication)”
* “Added: `getStructuredLogs()` for LLM & diffusion managers”
* “Added: `attachAppLifecycle(app, …)` helper for graceful shutdown”
* “Added: `formatErrorForUI()` to convert library errors to UI-friendly messages”

---

## 9) Guardrails & Non-Goals

* **Do not** move React UI or hooks into the core library.
* **Do not** publish the IPC bridge yet—wait until Phase 3 features land.
* Keep every change **additive**; don’t rename or remove existing methods now.

---

## 10) Future Work (after Phase 3 stabilizes)

* `genai-electron-bridge`: IPC + event forwarding (typed channels, stable payloads).
* `genai-electron-react`: Hooks (`useServerStatus`, `useDiffusionServer`, `useModels`, `useResourceMonitor`).
* Standardized download lifecycle events (start/progress/pause/resume/cancel/complete/error).
* Optional HTTP clients for local servers.

**Promotion checklist for later:**

* Used by ≥2 apps.
* API unlikely to change with Phase 3/4.
* Good test coverage.
* Can be shipped additively or as a separate package.

---

## 11) Practical Notes for the Refactorer

* Work in a feature branch: `feat/library-extraction-phase-1`.
* Commit in small steps:

  1. Type consolidation (switch app imports, drop duplicates)
  2. Structured logs + app switch-over
  3. Lifecycle helper + app switch-over
  4. Error normalization + app switch-over
* Keep CI green; if unsure, mark new APIs as **experimental** in docs (or prefix with `unstable_` if needed).
* Coordinate with the maintainer before merging (to slot the release and changelog).

---

## 12) Quick Reference: Files You’ll Touch (Example App)

* `examples/electron-control-panel/main/ipc-handlers.ts`
* `examples/electron-control-panel/main/genai-api.ts` (remove `cleanupServers` usage)
* `examples/electron-control-panel/main/index.ts` (replace manual `before-quit`)
* `examples/electron-control-panel/renderer/types/*` (switch imports to library)
* `examples/electron-control-panel/renderer/components/common/LogViewer.tsx` (no change, but verify)
* Hooks (`useServerLogs`, etc.) continue to work, just verify parsing isn’t duplicated anywhere.

> Core library changes will be under `src/types/*`, `src/managers/*`, `src/utils/*`, and `src/index.ts`.

---

## 13) FAQs

**Q: Why not ship the IPC bridge now?**
A: Phase 3 (resume/cancel/queue) will change event shapes and channels. Shipping now would cause churn.

**Q: Is it okay to mark new APIs as experimental?**
A: Yes—document it clearly. But the four “move now” items are already stable enough for a regular minor release.

**Q: Can we split types into a separate package?**
A: You can, but not required. Re-exporting from core is simpler for now.
