# Troubleshooting

Common issues and solutions for genai-electron. Focus on non-obvious problems with actionable solutions.

## Navigation

- [Binary Validation Failures](#binary-validation-failures)
- [HTTP API Errors](#http-api-errors)
- [Memory & Resources](#memory--resources)
- [Model Issues](#model-issues)
- [Initialization & Cache Issues](#initialization--cache-issues)
- [Connection Issues](#connection-issues)
- [FAQ](#faq)
- [Additional Utilities](#additional-utilities)

---

## Binary Validation Failures

### CUDA Errors with Automatic Fallback

**Problem:** `BinaryError: CUDA error detected in validation output`

**Solution:** Binary manager automatically tries variants in priority order: CUDA → Vulkan → CPU. If CUDA fails, Vulkan or CPU will be used automatically.

After updating GPU drivers, use `forceValidation: true` to re-run validation tests:

```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  forceValidation: true  // Re-run Phase 1 & 2 tests after driver update
});
```

**Why this matters:** Binary validation is cached (checksum-based) for fast subsequent starts. After GPU driver updates, the cached validation may be stale even though the checksum matches.

### Linux NVIDIA: No CUDA Prebuilt (Vulkan Used)

**Problem:** On Linux x64, GPU acceleration runs through **Vulkan** rather than CUDA, even on NVIDIA hardware.

**Cause:** As of the pinned llama.cpp build (`b9860`), upstream no longer ships a CUDA prebuilt for Linux x64. The Linux variant chain is now **Vulkan → CPU**. NVIDIA users get GPU acceleration via the Vulkan build (install the Vulkan loader / NVIDIA Vulkan drivers).

**If you need CUDA on Linux:** Build llama.cpp from source with CUDA enabled and point genai-lite at it via `LLAMACPP_API_BASE_URL` (see the FAQ below). Windows CUDA prebuilts are unaffected.

### CUDA + CPU Offloading Crash (fixed upstream; re-verified in `master-782-b290693`)

**Problem (historical):** On sd.cpp builds up to `master-504-636d3cb`, diffusion generation crashed silently (exit code `0xC0000005`) when the CUDA backend was combined with any CPU offloading flag: `--clip-on-cpu`, `--vae-on-cpu`, or `--offload-to-cpu`. genai-electron used to suppress these flags automatically on CUDA installs.

**Now:** Fixed upstream; re-verified live on the current `master-782-b290693` pin with all three flags combined (and previously with each flag individually). Since genai-electron v0.10.0 the flags are auto-detected identically on all backends. If low VRAM headroom now auto-enables offloading on your CUDA setup and you prefer the old behavior, set `clipOnCpu`/`vaeOnCpu`/`offloadToCpu` to `false` explicitly. To pick these flags systematically instead of guessing, run `diffusionServer.calibrate()` — it benchmarks the combinations on the actual machine (see [Offload Calibration](./image-generation.md#offload-calibration)).

**Known upstream caveat:** SD3.5-Large conditioning is broken with `--clip-on-cpu` on any backend (leejet/stable-diffusion.cpp#1578) — force `clipOnCpu: false` for that model family if you hit it.

### Missing Shared Libraries

**Problem:** `BinaryError: error while loading shared libraries`

**Solution:**

```bash
# Linux: Install common dependencies
sudo apt-get update
sudo apt-get install libgomp1 libstdc++6

# Windows: Install Visual C++ Redistributable
# macOS: Usually not needed
```

### Monitor Binary Validation

```typescript
llamaServer.on('binary-log', (data) => {
  console.log(`[${data.level}] ${data.message}`);
});

// Watch for validation progress and errors
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });
```

Provisioning output is persisted automatically in `llama-server.log` or
`diffusion-server.log`, even if every variant fails before a server starts.
`'binary-log'` remains useful for live UI output.

### Interrupted or Long Windows Provisioning

Windows CUDA ZIPs can inflate to hundreds of megabytes. Extraction runs in a
worker thread; a responsive window plus changing
`completedEntries` / `totalEntries` on `'binary-progress'` means provisioning is
still active.

If the process is killed, restart normally. The next attempt removes the stale
variant extraction directory and reuses any complete archive whose SHA-256
still matches. A `.partial` download is never treated as complete and currently
starts over rather than using HTTP range resume. Installed dependencies are
reused by checksum through `.deps.json`; deleting that manifest is safe and
forces ordinary dependency provisioning. If the binary installation completed
before the process was killed, the next validated start removes leftover main
archives and extraction directories. An unmanifested dependency archive is
kept as a recovery copy for the next provisioning run.

---

## HTTP API Errors

### Error Codes Table

| Code | Description | Solution |
|------|-------------|----------|
| `SERVER_BUSY` | Server processing another generation | Wait for current generation to complete |
| `NOT_FOUND` | Generation ID not found | ID invalid or result expired (TTL) |
| `INVALID_REQUEST` | Invalid parameters | Check prompt, count (1-5) |
| `BACKEND_ERROR` | Backend processing failed | Check logs, model may be corrupt |
| `IO_ERROR` | File I/O error | Check disk space and permissions |

### Generation Not Found (TTL Expired)

**Problem:** `NOT_FOUND` error when polling for results

**Solution:** Results expire after TTL (default: 5 minutes). Poll more frequently or increase TTL:

```bash
# Set longer TTL (10 minutes)
export IMAGE_RESULT_TTL_MS=600000

# Restart diffusion server for changes to take effect
```

### Polling Frequency

**Recommendation:** Poll every 1 second. Polling too slowly (>5 seconds) increases risk of results expiring before retrieval.

```typescript
// Good polling frequency
await new Promise(resolve => setTimeout(resolve, 1000));

// Too slow - results may expire
await new Promise(resolve => setTimeout(resolve, 10000));
```

---

## Memory & Resources

### canRunModel Memory Modes

**Problem:** Confusing when to use `checkTotalMemory` option

**Solution:** Use different modes for different server types:

```typescript
// LLM servers: Check available memory (default)
// Models load at startup, need RAM available NOW
const llmCheck = await systemInfo.canRunModel(llmModelInfo);

// Diffusion servers: Check total memory
// Models load on-demand, ResourceOrchestrator will free memory
const diffusionCheck = await systemInfo.canRunModel(
  diffusionModelInfo,
  { checkTotalMemory: true }
);
```

**Why this matters:** Diffusion models are loaded on-demand. If you check available memory, it may fail even though ResourceOrchestrator can free memory by offloading LLM.

### Resource Orchestration Pattern

**Problem:** Both LLM and image generation running out of RAM/VRAM

**Solution:** Use ResourceOrchestrator for automatic LLM offload/reload:

```typescript
import { ResourceOrchestrator } from 'genai-electron';

const orchestrator = new ResourceOrchestrator(
  systemInfo,
  llamaServer,
  diffusionServer,
  modelManager
);

// Automatically offloads LLM if needed, then reloads after generation
await orchestrator.orchestrateImageGeneration({
  prompt: 'A landscape',
  steps: 30
});
```

### Context Capacity Contract Errors

**Problem:** `ContextConstraintError` is thrown during sizing or llama-server startup.

Inspect `error.details.reason`:

| Reason | Meaning | Action |
|---|---|---|
| `invalid-minimum`, `invalid-preferred`, `invalid-maximum` | A context-policy value is invalid | Use positive safe integers |
| `minimum-exceeds-preferred`, `preferred-exceeds-maximum`, `minimum-exceeds-maximum` | Context-policy values are out of order | Use minimum ≤ preferred ≤ maximum for the fields present |
| `minimum-exceeds-native` | The per-slot minimum exceeds GGUF `context_length` | Lower the minimum or choose another model |
| `model-context-unknown` | Native GGUF context metadata is missing and the requested minimum exceeds the conservative legacy limit | Refresh/redownload model metadata or lower the minimum |
| `precomputed-context-out-of-range` | Configured total `contextSize / parallelRequests` is outside the retained range | Re-run `getOptimalConfig()` with the desired range |
| `runtime-capacity-unavailable` | Mandatory post-health `GET /props` failed or had an incompatible shape | Check llama-server logs/version and the selected host/port |
| `runtime-slots-mismatch` | `/props.total_slots` differs from `parallelRequests` | Check the emitted `-np` flag and fitting behavior |
| `runtime-below-minimum`, `runtime-above-maximum` | `/props` reported an effective per-slot capacity outside the range | Adjust the range/configuration; the child has already been stopped |

`preferredContextSize` is a sizing target, not a runtime bound. An effective capacity above
preferred is accepted and does not produce a `ContextConstraintError`.

```typescript
import { ContextConstraintError } from 'genai-electron';

try {
  await llamaServer.start(config);
} catch (error) {
  if (error instanceof ContextConstraintError) {
    console.error(error.details.reason, error.details.suggestion);
  }
}
```

`/props` verification is strict for all managed llama-server starts, including unconstrained and
exact-only starts. Turning `occupancyCheck` off skips cross-app probing but does not skip this
post-health verification. Exact-only starts report configured and effective values without
enforcing equality; ranged starts enforce the effective per-slot result.

If the error code is `INSUFFICIENT_RESOURCES`, the range and model limit are valid but no allowed
GPU/RAM/cache/MoE placement can satisfy the minimum. Reduce the minimum or parallel slot count,
close memory-heavy applications, relax pinned placement/cache choices, or choose a smaller model.

### Batch Generation Limitation (Phase 3)

**Problem:** Generating multiple images (`count > 1`) doesn't trigger automatic LLM offload

**Workaround:** Use `count: 1` for now, or manually orchestrate. Batch orchestration planned for Phase 3.

```typescript
// Current limitation: orchestration bypassed for batch
const result = await diffusionServer.generateImage({
  prompt: 'A landscape',
  count: 3  // LLM won't be offloaded automatically
});
```

---

## Model Issues

### Multi-Component Model Issues

**Wrong VAE for Flux 2**
- **Symptom:** Tensor shape mismatch or silent failure during generation
- **Cause:** Using Flux 1 `ae.safetensors` (16 latent channels) instead of Flux 2 `flux2-vae.safetensors` (32 latent channels)
- **Fix:** Download the Flux 2 VAE from `Comfy-Org/flux2-dev` → `split_files/vae/flux2-vae.safetensors`

**Component Checksum Mismatch**
- **Symptom:** `ChecksumError: SHA256 checksum mismatch for component: llm`
- **Cause:** Corrupted or incomplete component download
- **Fix:** Delete the model with `modelManager.deleteModel(modelId)` and re-download

**Partial Download Cleanup**
- If a multi-component download fails mid-way, all already-downloaded component files are automatically cleaned up. Re-run `downloadModel()` to start fresh.

**"Model too large" with Multi-Component Models**
- The `canRunModel()` check uses the aggregate size of all components, which may be conservative when `--offload-to-cpu` is available
- Try setting `offloadToCpu: true` in the server config to enable CPU offloading

### Reasoning Not Extracted

**Problem:** Reasoning-capable model doesn't extract `<think>...</think>` tags

**How it works now:** llama-server is **always** launched with `--jinja`, and reasoning extraction is handled by `--reasoning-format`, which defaults to `'auto'`. There is no longer any conditional flag injection based on `supportsReasoning` — that field is now purely informational metadata and does not gate how the server starts.

**Check:** `supportsReasoning: true` is auto-set during download for Qwen3, DeepSeek-R1, and GPT-OSS. It is a display/UX hint only:

```typescript
const modelInfo = await modelManager.getModelInfo('qwen3-8b');
console.log('Supports reasoning:', modelInfo.supportsReasoning);
```

**Override the format:** If `'auto'` isn't extracting reasoning for your model, set the `reasoningFormat` option when starting the server:

```typescript
await llamaServer.start({
  modelId: 'qwen3-8b',
  // 'auto' (default) | 'deepseek' | 'deepseek-legacy' | 'none'
  reasoningFormat: 'deepseek',
});
```

To disable the Jinja template entirely, pass `jinja: false` (this also disables genai-lite's reasoning request toggle, which needs `--jinja`).

**Manual override:** Or start llama-server yourself and connect via `LLAMACPP_API_BASE_URL`:

```bash
llama-server -m model.gguf --jinja --reasoning-format deepseek --port 8080
```

### Checksum Mismatch

**Problem:** `ChecksumError: Checksum verification failed`

**Solution:** File corrupted during download. Delete and re-download:

```typescript
try {
  await modelManager.downloadModel(config);
} catch (error) {
  if (error instanceof ChecksumError) {
    console.log('File corrupted, re-downloading...');
    await modelManager.deleteModel(modelId);
    await modelManager.downloadModel(config);
  }
}
```

---

## Initialization & Cache Issues

### Library Called Before Electron Ready

**Problem:** `Error: Cannot call app.getPath() before app is ready`

**Cause:** genai-electron depends on Electron's `app.getPath('userData')` for model and binary storage. If you import and use the library before Electron's 'ready' event, it will crash.

**Solution:** Always initialize after `app.whenReady()`:

```typescript
// ❌ BAD: Called too early
import { modelManager } from 'genai-electron';
await modelManager.listModels(); // CRASH!

// ✅ GOOD: Wait for ready event
import { app } from 'electron';
import { modelManager } from 'genai-electron';

app.whenReady().then(async () => {
  const models = await modelManager.listModels(); // Works!
}).catch(console.error);
```

**Why this matters:** Common beginner mistake with a cryptic error message. The library needs `userData` path to function, which is only available after app initialization completes.

### SystemInfo Memory Cache Staleness

**Problem:** After loading a server, `systemInfo.detect()` may return stale memory data for up to 60 seconds, causing false "insufficient RAM" errors when loading additional models.

**Real-world scenario:**
1. Load 6GB LLM server → consumes RAM
2. Try to load diffusion model immediately
3. `canRunModel()` checks memory using cached data (shows OLD available memory)
4. Reports "insufficient RAM" even though enough RAM is actually available

**Cause:** `SystemInfo.detect()` caches results for 60 seconds for performance. The library automatically invalidates cache on server start/stop, BUT direct calls to `detect()` use cached data.

**Solution:** Use `detect(forceRefresh: true)` when you need real-time memory after server state changes:

```typescript
// After loading LLM server, memory consumed but cache may be stale
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });

// ❌ POTENTIALLY STALE: Uses cached memory (up to 60s old)
const caps1 = await systemInfo.detect();
console.log('Available RAM:', (caps1.memory.available / 1024 ** 3).toFixed(1), 'GB');

// ✅ ALWAYS FRESH: Force refresh for accurate real-time memory
const caps2 = await systemInfo.detect(true);
console.log('Available RAM:', (caps2.memory.available / 1024 ** 3).toFixed(1), 'GB');

// ✅ AUTOMATIC: Library methods invalidate cache automatically
const check = await systemInfo.canRunModel(diffusionModelInfo); // Uses fresh memory
```

**Automatic cache invalidation:** The library automatically clears cache on:
- `llamaServer.start()` completion
- `llamaServer.stop()` completion
- `diffusionServer.start()` completion
- `diffusionServer.stop()` completion

**When to force refresh:**
- When checking memory between rapid server operations
- After external processes consume significant memory
- When displaying real-time memory in UI (but consider using `getMemoryInfo()` instead, which never caches)

**Alternative for real-time memory:** Use `systemInfo.getMemoryInfo()` which always returns fresh data:

```typescript
// Always real-time, never cached (but no GPU/CPU/recommendations)
const memory = systemInfo.getMemoryInfo();
console.log('Available:', (memory.available / 1024 ** 3).toFixed(1), 'GB');
console.log('Used:', (memory.used / 1024 ** 3).toFixed(1), 'GB');
console.log('Total:', (memory.total / 1024 ** 3).toFixed(1), 'GB');
```

---

## Connection Issues

### Port Already in Use

**Problem:** `PortInUseError: Port 8080 is already in use`

**Solution:** Stop the conflicting application, use a different port, or let the library pick a free one:

```typescript
// Use a specific alternative port
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8081  // Instead of 8080
});

// Or let the OS assign a free port automatically
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 'auto'  // Resolved port is on ServerInfo.port after start
});
const { port } = llamaServer.getInfo();
console.log('Server bound to port', port);
```

**Note:** Port availability is now checked with a real bind test (via `isPortBindable`), not just an HTTP probe. This catches non-HTTP occupants (other processes holding the port) that a health-check probe would miss, so `PortInUseError` is raised before spawning the binary.

**Find what's using the port:**
```bash
# macOS/Linux
lsof -i :8080

# Windows
netstat -ano | findstr :8080
```

### "Another llama-server appears to be running" Warning

**Message:** `Another llama-server appears to be running on port(s) 8081 - starting a second one may double-load VRAM`

**Cause:** Before starting, `LlamaServerManager` runs a cross-app *occupancy check*: it fingerprints ports 8080–8083 (via `GET /props`, so your own diffusion HTTP wrapper is never flagged) to catch a second llama-server that would double-load VRAM. This is a safety rail, not a hard error.

**Control it via the `occupancyCheck` option:**

```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  occupancyCheck: 'warn',   // default: log the warning and continue
  // 'strict' → throw instead of starting
  // 'off'    → skip the probe entirely
});
```

If the detected server is expected (e.g. a deliberate second instance), set `occupancyCheck: 'off'` to silence the warning; use `'strict'` in setups where a double-load must never happen.

### Health Check Timeout

**Problem:** Server takes long to load model, `isHealthy()` returns false

**Solution:** Poll until ready with retry logic:

```typescript
await llamaServer.start({ modelId: 'llama-2-7b', port: 8080 });

// Poll until healthy (up to 30 seconds)
let retries = 0;
while (!(await llamaServer.isHealthy()) && retries < 30) {
  console.log('Waiting for model to load...');
  await new Promise(resolve => setTimeout(resolve, 1000));
  retries++;
}

if (await llamaServer.isHealthy()) {
  console.log('✅ Server is ready');
} else {
  console.error('❌ Server failed to become healthy');
  const logs = await llamaServer.getLogs(50);
  console.log('Recent logs:', logs);
}
```

**Why this matters:** Large models can take 10-30 seconds to load, especially on CPU-only systems.

---

## LLM Calibration Problems

### Calibration says the server or resources are busy

Stop the normal LLM server before calling `llamaServer.calibrate()`. Also stop diffusion generation,
other llama-server processes, and unrelated GPU-heavy work. `CALIBRATION_SERVER_RUNNING`,
`CALIBRATION_BUSY`, and `CALIBRATION_RESOURCE_BUSY` are setup failures; no candidate timing should
be trusted until the conflict is gone.

### A formerly valid calibration call now fails validation

The adaptive default uses `profiles: [profile]` and does not accept `combos`. Caller-ordered exact
mode uses one singular `profile` plus a non-empty `combos` tuple. The legacy singular `profile`
without `combos`, `profiles` together with `combos`, and a request containing both `profile` and
`profiles` are rejected before binary provisioning.

Adaptive mode accepts one or two unique context sizes with the same `parallelRequests`. Its
`maxProbes`, `maxWallTimeMs`, `contextPreferencePct`, and
`includeKvCacheComparison` fields cannot be used with exact combos.

### Slots or context cannot be verified

`CALIBRATION_SLOTS_UNAVAILABLE` means the pinned server did not expose compatible `/props`
evidence, reported a different slot count, or did not allocate exactly
`floor(profile.contextSize / profile.parallelRequests)` tokens per slot. Every fresh launch is
checked. Verify the binary version and logs; calibration deliberately refuses to guess capacity.

### A workload is rejected before timing

Every complete prompt must fit in the verified per-slot context together with `nPredict`.
Shared-prefix workloads need at least two suffixes. A single workload may omit its weight; multiple
workloads must all provide finite positive weights. Reduce the prompt/output size or run a separate
calibration at a larger exact total `contextSize`. In a two-profile adaptive call, every workload
must fit the smallest verified profile; larger profiles cannot use different or longer workloads in
the same call.

### Adaptive calibration returns a partial result

`time-limited`, `probe-limited`, and `inconclusive` are ordinary results, not crashes. They use
`searchCompleteness: 'partial'` and may still include the best clean `selected` configuration.
Inspect `selectionEvidence` to distinguish independent reproduction from a single full or search
launch, and inspect `cells`, `profiles`, `probes`, `warnings`, `terminalReason`, and `budget` to see
what remained unresolved.

First narrow on `resultKind`. A `preparation-time-limit` result means the one total deadline arrived
before ordinary report identity and the fixed baseline existed, so it intentionally has no
selection. Ordinary adaptive and exact results use `resultKind: 'report'` and then narrow by
`strategy`.

Time is the normal user-facing budget: the library defaults to 60 minutes, while a host may expose
any duration choices or custom input appropriate to its product. Omitted `maxProbes` means
unbounded by probe count; supply it only as an expert/test cap. A longer run may improve the
selected config or finish more of the search, but a host may apply, persist, present, or ignore any
returned selection according to its product policy. The evidence label should travel with that
decision. An explicit cap counts executor attempts, including startup failure, capacity or OOM
rejection, and deadline interruption; runner-internal start retries remain one attempt.

### The apparent boundary is unstable or steps down

Search samples guide the bracket; they do not certify a winner. A competitive finalist must be
observed successfully on at least two fresh processes, including one full-fidelity launch. A
conflicting failure, excessive cross-launch spread, non-monotone interior result, or ambiguous
performance cliff can trigger another full-fidelity launch or a direct test one GPU layer lower.

Check each probe's `operationalStatus`, `memoryEvidence`, and `boundaryDecision` separately. A broad
CUDA error, timeout, crash, or slow result does not by itself prove memory exhaustion. A reported
`fallback` is validated only when it carries `evidence: 'direct-measurement'`; an unvalidated
lower-layer possibility remains diagnostic rather than a fallback guarantee.

### No reference or viable candidate was found

The controller descends from the auto-configured layer starting point and directly tests `g=0`
before resolving a cell as `no-viable-point`. `no-viable-candidate` means all requested cells were
resolved and none produced an admissible point. If a still-relevant cell could not be searched or
resolved, the result is `time-limited`, `probe-limited`, or `inconclusive` according to what
actually stopped it.

Inspect startup diagnostics and confirm that the model can run at `gpuLayers: 0` with the exact
profile and pinned fixed/MoE placement. If not, reduce context/slots, use a smaller model, or change
the pinned placement with an explicit exact-combo calibration.

### A search probe stopped earlier than `requestTimeoutMs`

After a cell has an admissible reference, adaptive search may cap a completion when its partial
aggregate lower bound is already outside every active decision band. Such a probe records
`capped: true`, an aggregate lower bound, and a termination reason. The first capped observation is
ambiguous and cannot close a competitive boundary by itself. Decision-relevant repeats use the
full caller timeout unless the conservative two-launch lower-bound rule can establish an unsuitable
point. Tokenization, slot control, finalist probes, and exact combos always retain the full caller
timeout.

### A calibration was aborted or cleanup failed

Caller cancellation rejects with `details.code === 'CALIBRATION_ABORTED'`. Preparation, invariant,
or cleanup failures reject as failed. In both cases, inspect `details.partialReport` for the typed
schema-v4 chronological probes, warnings, terminal status, and `cleanupConfirmed` flag.

An internal adaptive deadline is different from caller cancellation: after confirmed cleanup it
returns a `time-limited` result. Its budget reports actual method-entry-to-settlement `elapsedMs` and
`overrunMs = max(0, elapsedMs - maxWallTimeMs)`. A
`CALIBRATION_CLEANUP_FAILED` rejection means the candidate PID could not be confirmed dead. Later
start/restart/calibration calls remain blocked while that process is alive; terminate the reported
PID, then retry. Do not discard the partial report when escalating a cleanup problem.

**Precedence.** An unconfirmed teardown is decided first and always rejects as
`CALIBRATION_CLEANUP_FAILED`, so possible orphaning is never hidden behind a resource error. An
explicit caller abort during baseline collection or a confirmation read stays
`CALIBRATION_ABORTED`. Only with cleanup confirmed and no abort does a resource-stability failure
apply — and it then supersedes the probe's own operational/OOM outcome, because that outcome is no
longer interpretable. The original failure survives inside the invalidated probe record.

### Calibration stopped with `CALIBRATION_RESOURCE_DRIFT`

Calibration establishes **one fixed baseline** for available host RAM and available VRAM at the
start of the call, then checks both sides of every launch against it. A trusted reading at or beyond
its band (host 10% down / 20% up, VRAM 10% / 10%, inclusive) is confirmed once with a single extra
telemetry read one cooldown later. When the same trusted metric is still outside its band,
`llamaServer.calibrate()` rejects with `LlamaCalibrationResourceStabilityError` and
`details.code === 'CALIBRATION_RESOURCE_DRIFT'`. This applies to adaptive **and** exact mode; exact
mode's reject path is new, so hosts that only handled the returned report must add a `catch`.

There is no resume or re-anchor. Inspect
`details.partialReport.resourceFailure` for the boundary (`pre-launch` or `post-cleanup`), the
affected metrics, the direction per metric, and the raw readings. `details.suggestion` is
host-facing, but a host may replace or localize it. `details.partialReport.bestKnown` may also expose
a start-ready recommendation supported only by earlier clean probes; the failed boundary probe is
excluded. A retry starts a fresh calibration from the beginning.

Two behaviors surprise callers upgrading from v0.19.1:

- comparison is cumulative against the baseline, so several individually minor decreases that
  together reach the band reject the call;
- a settled step change (a browser or another app taking memory once and keeping it) used to
  re-anchor and continue in a new *resource regime*; regimes are gone and the same event now fails
  the run.

An increase can also stop a run. That is deliberate: earlier probes then ran under materially
tighter conditions, and a large increase would silently desensitize the decrease guard. Ordinary
upward settling (measured up to +10.5% host on the reference machine) stays well inside the band.

The guard samples boundaries rather than observing continuously, so pressure that begins and fully
clears inside one launch is not detectable. Run calibration on an otherwise idle machine; the host
owns how it arranges those conditions. See
[Machine conditions during a run](llm-server.md#machine-conditions-during-a-run).

### Calibration stopped with `CALIBRATION_RESOURCE_STABILITY_UNVERIFIED`

Same error class, different `details.code`. A trusted reading was suspicious, but the single
confirmation could not settle the question: either that metric's confirmation reading became
untrusted (telemetry refresh failed, reading unavailable or invalid), or a *different* metric became
newly suspicious in the confirmation. Calibration refuses to loop or to treat the ambiguity as
clean, and never mislabels it as confirmed drift. If any metric *is* independently confirmed, the
run reports `CALIBRATION_RESOURCE_DRIFT` instead.

An isolated untrusted reading, with no trusted suspicious reading in that boundary, never
manufactures a failure — it is recorded and warned. Likewise a metric with fewer than two trusted
baseline samples is disabled for the whole run: it guards nothing, `resourceMonitoring.coverage`
drops to `partial` or `unavailable`, and an explicit warning says so. A disabled metric weakens only
the stated resource coverage; it never makes the other metric's confirmed change less fatal.

Retry the same way: quiet the machine, then recalibrate from the beginning. Persistent
stability-unverified failures on a genuinely idle machine point at *intermittent* platform telemetry
— a source that read cleanly at baseline and then failed at a confirmation, such as a Windows
standby-aware refresh that fails only sometimes, or flaky `nvidia-smi`-style available-VRAM data —
rather than at real resource pressure. Telemetry that is missing outright cannot cause this: a source
that never produces trusted baseline samples disables its metric at baseline instead.

### A resource-error partial report offers `bestKnown`

`bestKnown.recommendation.startConfig` is application-ready and comes with literal evidence plus
non-empty `sourceProbeIndexes`. Every cited probe is earlier, clean, accepted, and cleanup-confirmed;
the resource-invalidated probe is never included. Adaptive evidence may be single-search,
single-full, or independently reproduced; exact evidence is one measured launch. The typed resource
error still means the call lost comparability and did not complete. The library neither applies nor
forbids the recommendation: the host may use, persist, present, or ignore it.

### When is a saved recommendation stale?

Recalibrate after changes to model files/revision, llama.cpp version/backend, OS/GPU driver/runtime,
hardware, requested profiles/slot count, fixed launch values (including pinned MoE placement),
workload definitions/weights/order, samples/timeouts, adaptive budgets/preferences, report schema,
or calibration policy. Schema-v2 reports (policy `llama-runtime-v2`) predate the fixed-baseline
guard and should be discarded rather than migrated. Treat a report whose `cacheability.level` is
`best-effort`, or whose `resourceMonitoring.coverage` is not `complete`, more conservatively because
part of that identity was unavailable.

## FAQ

### Can I use custom llama.cpp builds?

**Yes!** Set `LLAMACPP_API_BASE_URL` environment variable:

```bash
export LLAMACPP_API_BASE_URL=http://localhost:9000

# Start your custom llama-server
llama-server -m model.gguf --port 9000

# Then use genai-lite - it will connect to your custom server
```

### How to disable GPU?

Set `gpuLayers: 0` to force CPU-only mode:

```typescript
await llamaServer.start({
  modelId: 'llama-2-7b',
  port: 8080,
  gpuLayers: 0  // Force CPU-only
});
```

### How to enable embeddings with llama.cpp?

Start llama-server manually with `--embeddings` flag:

```bash
llama-server -m model.gguf --port 8080 --embeddings
```

Then connect with genai-lite using `LLAMACPP_API_BASE_URL`.

---

## Additional Utilities

genai-electron exports additional utilities for advanced use cases:

**Platform Detection**:
```typescript
import {
  getPlatform,      // 'darwin' | 'win32' | 'linux'
  getArchitecture,  // 'x64' | 'arm64'
  getPlatformKey,   // 'darwin-arm64', etc.
  isMac, isWindows, isLinux, isAppleSilicon
} from 'genai-electron';
```

**File Utilities**:
```typescript
import {
  calculateChecksum,  // SHA256 checksum
  formatBytes,        // Human-readable sizes
  fileExists,         // Check file existence
  ensureDirectory,    // Create directory if needed
  sanitizeFilename    // Safe filenames
} from 'genai-electron';
```

These are low-level utilities used internally. Most applications won't need them directly.

---

## See Also

- [Installation and Setup](installation-and-setup.md) - Requirements and setup
- [System Detection](system-detection.md) - Hardware capability checking
- [LLM Server](llm-server.md) - Server configuration and logs
- [Image Generation](image-generation.md) - HTTP API and error codes
- [Integration Guide](integration-guide.md) - Error handling patterns
