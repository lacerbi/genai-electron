# Migrating from v0.5.x to v0.6.0

Guide for upgrading genai-electron from 0.5.x to 0.6.0. This release is about **server reliability and launch control**: crash auto-restart, a hang watchdog, automatic port selection, cross-app occupancy safety, and a much larger set of llama-server launch flags (KV-cache quantization, flash-attention control, MoE offload). It also adds **multi-shard GGUF downloads** and **image-generation cancellation**, and bumps the pinned llama.cpp binary.

Unlike 0.5.0, this release is **source-compatible but not behavior-identical**: existing code compiles unchanged, but several defaults changed, so the servers you start will behave a little differently on upgrade. Read the [Compatibility](#compatibility) section before deploying.

---

## Compatibility

All 0.5.x code compiles against 0.6.0 without edits — every new field is optional and the one widened type (`flashAttention`) is a superset of the old one. The behavioral shifts below take effect automatically on upgrade:

- **First start re-downloads the llama.cpp binary.** The pin moved **b7956 → b9860**. The first `llamaServer.start()` after upgrading downloads the new binary (~50–300 MB depending on platform/variant) into the version-keyed cache; subsequent starts reuse it. No action needed, but budget for the one-time download.
- **Linux NVIDIA users get Vulkan, not CUDA.** Upstream discontinued the Linux x64 CUDA prebuilt at this tag. The Linux variant chain is now **Vulkan → CPU**. NVIDIA GPUs are still accelerated via Vulkan; for a CUDA build you must compile llama.cpp from source and point genai-electron at it. macOS (Metal) and Windows (CUDA → Vulkan → CPU) are unchanged.
- **`--jinja` is now always passed.** The model's embedded Jinja chat template is enabled by default (`jinja: true`), which `chat_template_kwargs` features such as genai-lite's reasoning toggle depend on. Opt out with `jinja: false`. The old special-case `--jinja --reasoning-format deepseek` for reasoning-detected models is **gone** — reasoning extraction now relies on llama-server's default `--reasoning-format auto` (override with the new `reasoningFormat` field).
- **`flashAttention` default changed to server-decided.** When unset, genai-electron now emits **nothing** and lets llama-server choose (`auto`, usually ON on GPUs). Previously it defaulted to OFF. The type is widened to `boolean | 'on' | 'off' | 'auto'` — a source-compatible superset (`true → 'on'`, `false → 'off'`).
- **`-ngl 0` is now passed explicitly for CPU-only configs**, and **`-fit off` is passed by default.** b9860 auto-offloads to the GPU unless `-ngl` is set, so a `gpuLayers: 0` config that used to run on CPU now needs the explicit flag genai-electron adds for you. Auto-fit stays off so genai-electron's own sizing remains authoritative (opt in with `fit: 'on'`).
- **`DEFAULT_TIMEOUTS.serverStart` raised 60 s → 120 s.** Cold loads of large GGUFs on slow disks were timing out. Override per-start with `startupTimeout`.
- **Previously-ignored fields now take effect.** `modelAlias`, `continuousBatching`, `batchSize`, `useMmap`, and `useMlock` were accepted but silently dropped in 0.5.x. They are now wired to real llama-server flags — any config that already sets them will change server behavior on upgrade. See [Newly-Wired Fields](#newly-wired-fields).

**Pairing note**: **genai-lite ≥ 0.9 pairs with genai-electron ≥ 0.6.** genai-lite's reasoning toggle for hybrid models (Gemma 4, Qwen 3.5) needs the server started with `--jinja`, which is now always on here.

---

## What's New

| Feature | Summary |
|---------|---------|
| Multi-shard GGUF downloads | `model-00001-of-0000N.gguf` files auto-download all sibling shards as one model |
| Optional / auto ports | `port` is now optional (defaults to 8080/8081); `'auto'` picks a free OS port |
| KV-cache quantization | `cacheTypeK` / `cacheTypeV` → `--cache-type-k/-v` for large VRAM savings on long contexts |
| Flash-attention control | Tri-state `flashAttention` (`'on'`/`'off'`/`'auto'`); quantized V-cache auto-upgrades to on |
| MoE offload | `cpuMoe`, `nCpuMoe`, `overrideTensors`, `cacheRam` to fit large MoE models in VRAM |
| Crash auto-restart | `autoRestart` + `maxRestarts` with exponential backoff, reusing the resolved port |
| Hang watchdog | `healthCheckInterval` polls health and kills a wedged process (feeds auto-restart) |
| Occupancy safety rail | `occupancyCheck` probes for other llama-servers that could double-load VRAM |
| Startup timeout / load timing | Per-start `startupTimeout`; `ServerInfo.loadTimeMs` reports spawn→healthy duration |
| Log rotation | Size-based rotation of `server.log` (default 5 MB / 2 archives) |
| Image-generation cancellation | `cancelImageGeneration()` + `DELETE /v1/images/generations/:id` |
| Binary bump | llama.cpp b7956 → b9860 (re-download on first start) |
| Loopback via 127.0.0.1 | All health/validation probes use `127.0.0.1` (avoids Windows IPv6 penalty) |
| Debug gating | Verbose auto-config / orchestrator traces gated behind `GENAI_ELECTRON_DEBUG` |

---

## New Types

Four new types support KV-cache control, flash-attention, sharded models, and log rotation.

### KVCacheType

Quantization type for the llama-server KV cache (`--cache-type-k` / `--cache-type-v`; server default is `f16`):

```typescript
type KVCacheType =
  | 'f16' | 'bf16' | 'q8_0' | 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'iq4_nl';
```

### FlashAttentionSetting

llama-server tri-state, plus `boolean` for backwards compatibility. When unset, nothing is emitted and the server decides (`auto`):

```typescript
type FlashAttentionSetting = boolean | 'on' | 'off' | 'auto';
// true → 'on', false → 'off'
```

### ShardInfo

Metadata about a single shard of a multi-shard GGUF model:

```typescript
interface ShardInfo {
  /** Absolute path to this shard file. */
  path: string;
  /** Shard file size in bytes. */
  size: number;
  /** SHA256 checksum (if verified; typically only the first shard). */
  checksum?: string;
}
```

### LogRotationOptions

Constructor options for `LogManager`'s size-based rotation:

```typescript
interface LogRotationOptions {
  /** Rotate when the log exceeds this many bytes (default: 5 MB). */
  maxFileSize?: number;
  /** Number of rotated archives to keep — server.log.1, .2, … (default: 2). */
  maxArchives?: number;
}
```

---

## Extended Interfaces

### ServerConfig (base)

`port` becomes optional, `flashAttention` is widened, and two new fields are added:

```typescript
interface ServerConfig {
  modelId: string;

  /**
   * Port to listen on. Optional — defaults to 8080 (llama) / 8081 (diffusion).
   * 'auto' picks a free OS-assigned port (read the result from ServerInfo.port).
   */
  port?: number | 'auto';

  // ... threads, contextSize, gpuLayers, parallelRequests unchanged ...

  /** Flash attention; unset → server decides ('auto'). Was: default off. */
  flashAttention?: FlashAttentionSetting;

  /**
   * Host/interface to bind (--host). Unset → llama-server default (127.0.0.1).
   * Health checks target this host (0.0.0.0/:: are probed via 127.0.0.1).
   */
  host?: string;

  // ... forceValidation unchanged ...

  /**
   * Max time to wait for health after spawn (ms).
   * Default: DEFAULT_TIMEOUTS.serverStart (now 120000).
   */
  startupTimeout?: number;
}
```

### LlamaServerConfig

Many new fields, plus five that were previously accepted but ignored (now wired). See [Launch-Contract Additions](#launch-contract-additions) and [Reliability Additions](#reliability-additions) for details.

```typescript
interface LlamaServerConfig extends ServerConfig {
  // --- Newly wired (were silently dropped in 0.5.x) ---
  modelAlias?: string;            // --alias (masks the filename genai-lite uses)
  continuousBatching?: boolean;   // false → --no-cont-batching
  batchSize?: number;             // -b
  useMmap?: boolean;              // false → --no-mmap
  useMlock?: boolean;             // true → --mlock

  // --- Chat template / reasoning ---
  jinja?: boolean;                // --jinja / --no-jinja (default: true)
  reasoningFormat?: 'auto' | 'deepseek' | 'deepseek-legacy' | 'none';

  // --- KV-cache quantization ---
  cacheTypeK?: KVCacheType;       // --cache-type-k
  cacheTypeV?: KVCacheType;       // --cache-type-v (quantized → forces flash attention on)

  // --- MoE / tensor offload ---
  overrideTensors?: string;       // -ot / --override-tensor (e.g. 'exps=CPU')
  cacheRam?: number;              // --cache-ram (MiB)
  cpuMoe?: boolean;               // --cpu-moe (all expert weights on CPU)
  nCpuMoe?: number;               // --n-cpu-moe N (first N layers' experts on CPU)

  // --- Sizing ---
  fit?: 'on' | 'off';             // -fit (default: 'off')

  // --- Reliability ---
  occupancyCheck?: 'warn' | 'strict' | 'off';  // default 'warn'
  autoRestart?: boolean;                        // default false
  maxRestarts?: number;                         // default 3
  healthCheckInterval?: number;                 // ms; default off (watchdog)
}
```

### ServerInfo

New optional field reporting how long the last successful start took:

```typescript
interface ServerInfo {
  // ... all existing fields unchanged ...

  /**
   * How long the last successful start took, spawn → healthy, in milliseconds
   * (llama-server only; undefined before the first successful start).
   * Also included in the 'started' event payload.
   */
  loadTimeMs?: number;
}
```

### ModelInfo

New optional field for multi-shard models (distinct from the multi-component `components` field added in 0.5.0):

```typescript
interface ModelInfo {
  // ... all existing fields unchanged ...

  /**
   * Shard files for multi-shard GGUF models (model-00001-of-0000N.gguf).
   * Lists ALL shards in order; `path` equals the first shard's path
   * (llama-server auto-discovers siblings) and `size` is the aggregate total.
   * Undefined for single-file models.
   */
  shards?: ShardInfo[];
}
```

Code that reads `modelInfo.path` and `modelInfo.size` continues to work — `path` points to the first shard and `size` is the aggregate across all shards.

### DownloadConfig

One new optional field for non-standard shard naming:

```typescript
interface DownloadConfig {
  // ... all existing fields unchanged ...

  /**
   * Additional sibling shards for multi-shard GGUF models.
   * Usually unnecessary — names matching model-00001-of-0000N.gguf are
   * auto-detected and siblings derived. Provide explicitly only for
   * non-standard naming: entries are filenames resolved next to the primary
   * file (same HF repo path / URL directory), or full http(s) URLs.
   */
  shardFiles?: string[];
}
```

### DiffusionServerConfig

`port` now also accepts `'auto'`:

```typescript
interface DiffusionServerConfig {
  // ... all existing fields unchanged ...

  /** Port to listen on (default: 8081; 'auto' picks a free OS-assigned port). */
  port?: number | 'auto';
}
```

### GenerationStatus

Gains a new terminal state, `'cancelled'`:

```typescript
type GenerationStatus = 'pending' | 'in_progress' | 'complete' | 'error' | 'cancelled';
```

See [Image-Generation Cancellation](#image-generation-cancellation) for the client-compatibility caveat.

---

## New Exports

All importable from `genai-electron`:

```typescript
import {
  // Port utilities
  findFreePort,        // (host?: string) => Promise<number>
  isPortBindable,      // (port: number, host?: string) => Promise<boolean>
  normalizeHealthHost, // maps 0.0.0.0 / :: to 127.0.0.1 for probing

  // New types (type-only imports)
  type KVCacheType,
  type FlashAttentionSetting,
  type ShardInfo,
  type LogRotationOptions,
} from 'genai-electron';
```

**`findFreePort(host?)`** binds port 0 to get an OS-assigned free port. Treat the result as a strong hint, not a reservation (there is an unavoidable race between the probe closing and your server binding):

```typescript
import { findFreePort, llamaServer } from 'genai-electron';

const port = await findFreePort();
await llamaServer.start({ modelId: 'my-model', port });
// Or skip the manual step entirely: start({ modelId, port: 'auto' })
```

**`isPortBindable(port, host?)`** tests whether a port can be bound. Unlike an HTTP probe, this catches *any* occupant of the port, not just HTTP servers:

```typescript
import { isPortBindable } from 'genai-electron';

if (!(await isPortBindable(8080))) {
  console.warn('Port 8080 is already in use');
}
```

---

## Multi-Shard GGUF Downloads

Large GGUF models are often split into numbered shards (`model-00001-of-00003.gguf`, `…-00002-of-00003.gguf`, …). In 0.6.0, pointing `downloadModel()` at the **first** shard downloads all siblings automatically and registers them as a single model.

### Concept

- A filename matching `*-00001-of-0000N.gguf` triggers auto-detection: genai-electron derives the sibling filenames and downloads all N shards.
- Shards live in a **per-model subdirectory** (like multi-component models).
- `ModelInfo.path` is the **first** shard — llama-server auto-discovers the rest from there.
- `ModelInfo.size` is the **aggregate** of all shards; `ModelInfo.shards` lists every shard in order.
- The metadata sidecar stays at `models/{type}/{modelId}.json` (parent level).

This is **distinct from multi-component diffusion models** (the role-keyed `components` field from 0.5.0). Shards are ordered pieces of *one* model; components are different files (encoder, VAE, …) that work together.

### Download Example

```typescript
import { modelManager } from 'genai-electron';

const modelInfo = await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'someorg/Big-Model-GGUF',
  file: 'big-model-Q8_0-00001-of-00003.gguf',   // point at the FIRST shard
  name: 'Big Model Q8_0',
  type: 'llm',
  checksum: 'sha256:...',   // optional — verifies the FIRST shard
  onProgress: (downloaded, total) => {
    // Aggregate progress across all shards — one smooth 0→100%
    console.log(`${((downloaded / total) * 100).toFixed(1)}%`);
  },
});

// modelInfo.path   → '.../big-model-q8-0/big-model-Q8_0-00001-of-00003.gguf'
// modelInfo.size   → aggregate of all 3 shards
// modelInfo.shards → [{ path, size, checksum? }, { … }, { … }]  (in order)
```

### Non-Standard Shard Names

If the shards do not follow the `-00001-of-0000N` convention, list the extra siblings explicitly with `shardFiles`. Entries are filenames resolved next to the primary file (same HF repo path / URL directory) or full `http(s)` URLs:

```typescript
await modelManager.downloadModel({
  source: 'huggingface',
  repo: 'someorg/Weird-Split-GGUF',
  file: 'model.part-a.gguf',
  name: 'Weird Split',
  type: 'llm',
  shardFiles: ['model.part-b.gguf', 'model.part-c.gguf'],
});
```

### Key Behaviors

- `onProgress` reports aggregate bytes across all shards — a single smooth 0→100%.
- `checksum` verifies only the **first** shard.
- Pointing at a non-first shard (e.g. `…-00002-of-00003.gguf`) throws.
- `…-00001-of-00001.gguf` is treated as a single file (no subdirectory).
- `StorageManager` delete / verify / `getStorageUsed()` all account for shards.

---

## Launch-Contract Additions

0.6.0 widens the set of llama-server flags genai-electron can emit. All are opt-in via `LlamaServerConfig` unless noted.

### Newly-Wired Fields

These five fields existed in 0.5.x but were silently dropped. They now map to real flags — **a config that already sets them will change server behavior on upgrade**:

| Field | Flag | Notes |
|-------|------|-------|
| `modelAlias` | `--alias` | ⚠️ Masks the GGUF filename genai-lite uses for family detection — leave unset unless you have a reason |
| `continuousBatching: false` | `--no-cont-batching` | `true`/unset emit nothing (server default is on) |
| `batchSize` | `-b` | Logical batch size |
| `useMmap: false` | `--no-mmap` | `true`/unset emit nothing (server default mmaps) |
| `useMlock: true` | `--mlock` | Locks the model in RAM |

### KV-Cache Quantization

`cacheTypeK` / `cacheTypeV` quantize the KV cache (`--cache-type-k` / `--cache-type-v`), giving significant VRAM savings on long contexts. Default is unset (`f16`).

**Flash-attention constraint**: quantized V-cache requires flash attention ON. When `cacheTypeV` is set to a quantized type and `flashAttention` is unset, genai-electron auto-upgrades flash attention to `'on'`. Combining a quantized `cacheTypeV` with `flashAttention: 'off'` (or `false`) **throws at `start()`** rather than launching a config that would fail.

```typescript
await llamaServer.start({
  modelId: 'llama-3-70b',
  cacheTypeK: 'q8_0',
  cacheTypeV: 'q8_0',   // flash attention auto-upgraded to 'on'
});
```

### MoE Offload

For large mixture-of-experts models that don't fit in VRAM, keep expert weights on the CPU:

| Field | Flag | Use |
|-------|------|-----|
| `cpuMoe: true` | `--cpu-moe` | Keep **all** MoE expert weights on CPU (ergonomic shortcut) |
| `nCpuMoe: N` | `--n-cpu-moe N` | Keep the first N layers' expert weights on CPU |
| `overrideTensors: 'exps=CPU'` | `-ot` / `--override-tensor` | Fine-grained buffer-type overrides |
| `cacheRam: MiB` | `--cache-ram` | Cap CPU-side prompt/KV cache; pairs with `overrideTensors` (-1 = no limit, 0 = disable) |

```typescript
await llamaServer.start({
  modelId: 'mixtral-8x22b',
  cpuMoe: true,          // all experts on CPU
  gpuLayers: 999,        // attention/norm layers on GPU
});
```

### Host Binding

`host` sets `--host`. Health checks follow it — `0.0.0.0` / `::` bindings are probed via `127.0.0.1`:

```typescript
await llamaServer.start({ modelId: 'my-model', host: '0.0.0.0' }); // LAN-accessible
```

### Auto-Fit

`fit` maps to `-fit` and **defaults to `'off'`**: genai-electron computes explicit `gpuLayers`/`contextSize` values via its own auto-configuration. Setting `fit: 'on'` delegates sizing to llama-server instead, and genai-electron then **skips its own auto-configuration** for those unset fields. Use `'on'` only if you specifically want llama-server's fitter (it has hung on some GPUs, which is why it is off by default).

---

## Reliability Additions

### Automatic Port Selection

`port` is optional and accepts `'auto'`. Omit it to use the default (8080 llama / 8081 diffusion); pass `'auto'` to have the OS assign a free port. Either way, read the concrete port back from `ServerInfo.port`:

```typescript
await llamaServer.start({ modelId: 'my-model', port: 'auto' });
const info = llamaServer.getInfo();
console.log('Listening on', info.port);
```

`checkPortAvailability` now also does a real bind test, so it catches non-HTTP occupants of a port, not just other HTTP servers.

### Occupancy Safety Rail

`occupancyCheck` (default `'warn'`) probes common llama-server ports (8080–8083) before starting to detect **another** llama-server that could double-load VRAM. Candidates are fingerprinted via `GET /props`, so the app's own diffusion HTTP wrapper is never flagged.

- `'warn'` (default): log a warning and continue.
- `'strict'`: throw and refuse to start.
- `'off'`: skip the check.

### Startup Timeout & Load Timing

`startupTimeout` (ms) overrides the per-start health-wait window; the default rose to `DEFAULT_TIMEOUTS.serverStart` = **120 000 ms** to accommodate cold loads of large GGUFs. After a successful start, `ServerInfo.loadTimeMs` reports the spawn→healthy duration (llama-server only), also carried in the `'started'` event payload.

### Auto-Restart & Hang Watchdog

`autoRestart` (default `false`) opts into crash recovery. On an unexpected crash the server is restarted with exponential backoff (1 s, 2 s, 4 s, …), reusing the resolved configuration including the concrete port, up to `maxRestarts` (default 3) consecutive attempts. The restart budget resets on a manual `start()`, and an intentional `stop()` never triggers a restart. Event order on recovery: **`'crashed'` → `'started'` → `'restarted'`**.

`healthCheckInterval` (ms, default off) enables a hang watchdog: the health endpoint is polled while running, emitting `'health-check-ok'` / `'health-check-failed'` events (previously declared but never fired). Three consecutive failures kill the process, which feeds `autoRestart` when enabled.

```typescript
await llamaServer.start({
  modelId: 'my-model',
  autoRestart: true,
  maxRestarts: 5,
  healthCheckInterval: 10000,   // watchdog every 10 s
});

llamaServer.on('restarted', () => console.log('Server recovered'));
llamaServer.on('health-check-failed', () => console.warn('Server unresponsive'));
```

### Log Rotation

`LogManager` now rotates `server.log` by size. Defaults are **5 MB per file, 2 archives** (`server.log.1`, `server.log.2`), configurable via the `LogRotationOptions` constructor argument (defaults live in `DEFAULT_LOG_ROTATION`). Setting `maxArchives: 0` truncates in place instead of rotating.

---

## Image-Generation Cancellation

The async image-generation API is now cancellable.

### API

```typescript
import { diffusionServer } from 'genai-electron';

// Cancel a known generation ID (from the async POST API)
await diffusionServer.cancelImageGeneration(id);

// When only the HTTP client knows the ID, look up the active one
const activeId = diffusionServer.getActiveGenerationId(); // string | undefined
if (activeId) await diffusionServer.cancelImageGeneration(activeId);
```

`cancelImageGeneration(id)` kills the sd-cli process and halts batch generation between images. It is **idempotent for terminal states** (complete / error / already-cancelled return quietly) and **throws for unknown IDs** (`GENERATION_NOT_FOUND`). `getActiveGenerationId()` returns the ID currently being processed, or `undefined` when idle.

### HTTP Endpoint

```
DELETE /v1/images/generations/:id
```

| Response | Meaning |
|----------|---------|
| `200 { id, status: 'cancelled' }` | Cancelled (or already cancelled — idempotent) |
| `404 { error: { code: 'NOT_FOUND' } }` | No such generation ID |
| `409 { error: { code: 'ALREADY_TERMINAL' } }` | Already `complete` / `error` — cannot cancel |

### genai-lite Client Caveat

`GenerationStatus` gains the terminal state `'cancelled'`. **genai-lite ≤ 0.9.0 pollers only treat `complete` / `error` as terminal** — if a generation is cancelled out-of-band (e.g. from your app's own Cancel button rather than through the poller), those older clients keep polling until their own client-side timeout (~120 s) before giving up. A follow-up is filed in genai-lite; until then, prefer cancelling through the same client that started the generation, or expect the delayed timeout on older genai-lite versions.

---

## Loopback via 127.0.0.1

All health and binary-validation probes now target **`127.0.0.1`** instead of `localhost`. On Windows, `localhost` can resolve to IPv6 first and incur a connection-retry penalty when the server is bound to IPv4; using the literal loopback address avoids it. `host` bindings of `0.0.0.0` / `::` are also probed via `127.0.0.1` (see `normalizeHealthHost`). This is transparent unless you were parsing the health URL — it now reads `http://127.0.0.1:{port}/health`.

---

## Debug Logging

Verbose internal traces — `autoConfigure` sizing decisions and `ResourceOrchestrator` offload/reload steps — are now **silent by default** and gated behind the `GENAI_ELECTRON_DEBUG` environment variable. Set it to surface those traces when diagnosing sizing or orchestration issues:

```bash
GENAI_ELECTRON_DEBUG=1 electron .
```

Server lifecycle events and errors are unaffected — only the noisy diagnostic output is gated.

---

## See Also

- [LLM Server](llm-server.md) — LlamaServerManager API, launch flags, and binary management
- [Image Generation](image-generation.md) — DiffusionServerManager API and async generation
- [Model Management](model-management.md) — ModelManager API, downloads, and storage
- [Resource Orchestration](resource-orchestration.md) — ResourceOrchestrator and offload/reload
- [TypeScript Reference](typescript-reference.md) — Complete type definitions
- [Troubleshooting](troubleshooting.md) — Error codes, port conflicts, and FAQ
- [Migrating from v0.4.x to v0.5.0](migration-0-4-to-0-5.md) — Previous migration guide (multi-component models)
