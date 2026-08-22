# Migrating from v0.25.0 to v0.26.0

v0.26.0 hardens the diffusion path that v0.25.0 introduced. It adds a stuck-job watchdog for the
persistent `sd-server` backend, makes the wrapper's CORS opt-in and adds a loopback `Host` guard,
exposes the built-in `ResourceOrchestrator`, and fixes several pieces of wrong data (reported image
dimensions, batch progress counters, a progress bar that could touch 100 % early, and documentation
that claimed library-side generation defaults). The wrapper's HTTP routes, the manager's method and
event surface, and every existing configuration key are preserved; genai-lite consumers and Electron
main-process clients keep working without source changes.

Because genai-electron is pre-1.0, a dependency range such as `^0.25.0` does not admit v0.26.0.
Update the range or exact pin explicitly to adopt this release.

## What changed

- **Stuck-job watchdog.** A backend that stayed alive but stopped making progress (a GPU hang with
  the job forever at `generating`) used to wedge the wrapper permanently: every later request got
  `503 SERVER_BUSY`, the generation record was never evicted, and an LLM offloaded for the image never
  reloaded. Only a client `DELETE` recovered it. The library now runs a **no-activity** watchdog on
  the in-flight job (`DiffusionServerConfig.jobActivityTimeoutMs`, default
  `DIFFUSION_BACKEND_DEFAULTS.jobActivityTimeoutMs` = 600 000 ms; `0` or any non-positive value
  disables it). Activity means backend stdout progress or log output and a job status or
  queue-position change; a poll that still says `generating` is not activity. On expiry the library
  cancels the job best-effort, releases the backend with the new reason `'stuck'` (a
  `'backend-status'` event), and fails the generation with wire code `BACKEND_ERROR` and
  `details.code: 'BACKEND_JOB_STUCK'` (async API status `error`). `ResourceOrchestrator` treats
  `'stuck'` like `'crashed'`, so an offloaded LLM comes back. The watchdog is also armed during
  `calibrate()` (a hung combo is recorded as `'error'`, not `'oom'`).
- **Wrapper access control.** CORS is now opt-in through `DiffusionServerConfig.allowedOrigins`.
  With no entries the wrapper sends no `Access-Control-*` headers at all (only `Vary: Origin`);
  entries are matched exactly against the request `Origin` and echoed; `['*']` restores the
  unconditional wildcard that v0.25.0 and earlier sent. Because CORS only stops a browser from
  *reading* a response, a state-changing request (anything other than GET/HEAD/OPTIONS — in practice
  POST and DELETE) that carries an `Origin` the allowlist does not cover is refused outright with
  `403 INVALID_ORIGIN`; a preflight-free cross-origin POST would otherwise still start a generation.
  While bound to a loopback address (the default), requests whose `Host` header is not `localhost`
  (including `*.localhost`), an IPv4 literal, or a bracketed IPv6 literal — each with an optional
  `:port` — are rejected with `403 INVALID_HOST` (DNS-rebinding protection); an absent `Host` is
  accepted and a non-loopback bind is unguarded. `host: ''` now binds loopback instead of every
  interface. The policy is written down in `image-generation.md`: loopback-only and unauthenticated by
  design, CORS opt-in, `host` is the knob for anything else, no API-key option on either server.
- **Built-in orchestrator accessor.** `DiffusionServerManager.getOrchestrator()` returns the live
  `ResourceOrchestrator` the manager drives (the exported `diffusionServer` singleton always has one;
  `undefined` for a manager constructed without a `LlamaServerManager`). Hosts no longer need a
  second, split-brain instance to observe `getSavedState()` / `waitForReload()`.
- **Truthful data.** `ImageGenerationResult.width` / `height` are read from the returned PNG's header
  (falling back to the requested size, then 512, only for a non-PNG payload). Batch progress
  `currentImage` is clamped to `totalImages`. In-flight `percentage` values never decrease within a
  generation and stop at 99; 100 is reported exactly once, by the completion callback, once the image
  exists. Documentation no longer claims library-side defaults for `width/height/steps/cfgScale/
  sampler` — the library applies none (omitted fields fall back to stable-diffusion.cpp's own; genai-
  lite fills its own values); always send the model's native values.

## New public surface (all additive)

- `DiffusionServerConfig`: `jobActivityTimeoutMs`, `allowedOrigins`.
- `DIFFUSION_BACKEND_DEFAULTS.jobActivityTimeoutMs` (600 000).
- `DiffusionBackendReleaseReason` gains `'stuck'` (also emitted by `'backend-status'` and accepted
  by the orchestrator's deferred-reload set).
- `ServerError.details.code` value `'BACKEND_JOB_STUCK'` with `jobId`, `idleMs`, `timeoutMs`,
  `stage`, `args`, `backendStderrTail`, `suggestion`.
- `DiffusionServerManager.getOrchestrator(): ResourceOrchestrator | undefined`.
- HTTP wire codes `INVALID_HOST` and `INVALID_ORIGIN` (both `403`).

## Behavior changes to review

- **No CORS headers by default.** A browser context that called the wrapper directly (a Vite dev
  page, a renderer with `webSecurity` on) must now set `allowedOrigins` (an exact origin, or `['*']`
  for the previous behavior). Node/Electron-main clients — genai-lite's `ImageService`, `fetch` from
  the main process, curl — send no `Origin` and are unaffected.
- **Cross-origin writes are refused** (`403 INVALID_ORIGIN`) when the `Origin` is not allowed, even
  for requests that previously slipped through without a preflight.
- **Loopback Host guard.** A hosts-file alias such as `http://my-sd.local:8081` pointing at
  `127.0.0.1` is now rejected (`403 INVALID_HOST`); use `localhost` / `127.0.0.1`, or bind `host`
  explicitly (non-loopback binds are unguarded).
- **A wedged backend now fails after ten minutes of silence** instead of hanging forever; the
  generation ends with `BACKEND_ERROR` / `BACKEND_JOB_STUCK` and the backend is respawned lazily on
  the next image. Set `jobActivityTimeoutMs` higher (or `0`) only for hardware that legitimately goes
  that long without any output.
- `ImageGenerationResult.width/height` now reflect the rendered image; a request that omitted the
  size no longer reports 512×512 when the backend rendered its own default.
- `percentage` no longer reaches 100 before completion or falls back after a slow stage; a cancelled
  or failed generation ends without a terminal percentage (unchanged).
- The example control panel uses `diffusionServer.getOrchestrator()` (its offload indicator is now
  truthful) and auto-applies a preset's recommended settings when a matching model is selected
  instead of starting from 20 steps / CFG 7.5.

## Compatibility

- genai-lite (checked against 0.11.0 in the example app) needs no change: it sends no `Origin`, the
  request keys, status payloads, `result.images[].{image,seed,width,height}` and the
  `error.{message,code}` envelope are unchanged, and the new `403` codes are unreachable from it. A
  stuck job surfaces to genai-lite as the existing `BACKEND_ERROR` wire code.
- Persisted offload-calibration reports and `policyVersion` (`diffusion-offload-v2`) are unchanged.
- `'stuck'` is a new member of a public union: exhaustive `switch` statements over
  `DiffusionBackendReleaseReason` need a case (treat it like `'crashed'`).
- The `ImageGenerationProgress.percentage` contract (monotonic, ≤ 99 in flight, single 100) is now
  documented; consumers that keyed "done" off `percentage === 100` keep working and no longer see an
  early 100.

## Consumer action

1. Update the dependency to v0.26.0 or a compatible range beginning at v0.26.0.
2. If a browser context calls the wrapper directly, set `DiffusionServerConfig.allowedOrigins`
   (exact origins; `['*']` restores the old wildcard). Nothing to do for genai-lite / main-process
   clients.
3. If you reach the wrapper through a custom hostname mapped to loopback, switch to `localhost` /
   `127.0.0.1` or bind `host` explicitly.
4. If you handle `'backend-status'` reasons or `DiffusionBackendReleaseReason` exhaustively, add
   `'stuck'`.
5. If you surface generation failures, recognise `details.code === 'BACKEND_JOB_STUCK'` (wire code
   stays `BACKEND_ERROR`) and consider retrying the image; tune `jobActivityTimeoutMs` only for
   hardware that legitimately goes minutes without output.
6. If you observe the offload/reload cycle, replace any host-constructed `ResourceOrchestrator`
   used only for observation with `diffusionServer.getOrchestrator()`.
7. Send `steps` / `cfgScale` / `sampler` / `width` / `height` explicitly for the model in use; the
   library never filled them in, and the docs no longer suggest otherwise.

## Verification and rollback

Verify in the packaged application: a normal image still completes (the watchdog never fires while
the backend reports progress); a browser page from another origin can neither read from nor POST to
the wrapper unless listed in `allowedOrigins`; `http://localhost:<port>/health` answers while a
custom loopback hostname gets `403 INVALID_HOST`; `diffusionServer.getOrchestrator()` is defined on
the singleton and `getSavedState()` reflects an offload performed for an image.

To roll back, pin v0.25.0: models, binary caches, and persisted calibration reports are unchanged. A
v0.25.0 host sends `Access-Control-Allow-Origin: *` again and has no stuck-job recovery beyond a
client `DELETE`.

## Checklist

- [ ] Update the dependency to v0.26.0.
- [ ] Set `allowedOrigins` if (and only if) a browser context talks to the wrapper directly.
- [ ] Add a `'stuck'` case to any exhaustive handling of `DiffusionBackendReleaseReason`.
- [ ] Recognise `BACKEND_JOB_STUCK` in failure handling; keep or tune `jobActivityTimeoutMs`.
- [ ] Replace observation-only `ResourceOrchestrator` instances with `getOrchestrator()`.
- [ ] Send explicit generation parameters for the model in use.
