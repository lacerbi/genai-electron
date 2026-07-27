# ISSUE: Binary provisioning freezes the Electron main process and redoes work it has already done

Created: 2026-07-26
Status: RESOLVED (2026-07-27)
Package: genai-electron (filed from palimpsest-engine)
Observed against: `genai-electron@0.13.0`, Windows 11, NVIDIA CUDA machine, during the
one-time diffusion runtime re-provisioning triggered by the 0.13.0 sd.cpp re-pin
(`master-746-2574f59` → `master-782-b290693`).

## Incident summary

The first image generation after the 0.13.0 uptake triggered re-provisioning of the
stable-diffusion.cpp runtime (version change, plus the installed binary name changing from the
legacy `sd.exe` to `sd-cli.exe`). From the consumer app's perspective the sequence looked like:
download reaches 100% → **the entire Electron window goes Not Responding** → the app later shows
a generation in progress that the user never asked for → **another download appears to start from
zero**. The user killed the app during the first freeze (inviting exactly the residue described in
finding 3); the second attempt completed end-to-end and wrote a valid `.validation.json`
(`master-782-b290693`, cuda, phase 1+2 passed).

Every step behaved as coded — nothing corrupted, no variant fall-through occurred — but four
separate defects compound into an experience indistinguishable from a hang/crash/retry loop.
Findings below are ordered by severity; each has a "What has to be done".

## Findings

### 1. ZIP extraction runs synchronously on the Electron main process (the freeze)

`src/utils/archive-utils.ts` (`extractBinary` line ~89, `extractArchive` line ~140) uses
`new AdmZip(archivePath)` + `zip.extractAllTo(...)`. Both are fully synchronous: the constructor
parses the whole archive, and `extractAllTo` inflates every entry on the calling thread — which is
the Electron **main** process. While it runs, the event loop is dead: no IPC, no window messages,
Windows marks every window of the app Not Responding.

The freeze scales with archive size, and the CUDA archives are enormous once inflated:

- `cudart-sd-bin-win-cu12-x64.zip` → ~790 MB (cublasLt64_12.dll alone is 674 MB)
- `sd-master-*-bin-win-cuda12-x64.zip` → ~450 MB (ggml-cuda.dll is 350 MB)
- the llama.cpp Windows zips (`llama-*-bin-win-cuda-12.4-x64.zip` + its cudart dependency) go
  through the same code path, so **llama provisioning freezes the same way**

The tar.gz path (`tar.x({ file, C })`) is already async/streaming, so macOS/Linux tarballs do not
block — this is a ZIP-path problem, which in practice means a Windows problem.

Not the cause, ruled out: the checksum step (`calculateChecksum`) streams via `createReadStream`
and does not block. The adm-zip 0.5.16 → 0.6.0 security bump (v0.12.1,
[`ISSUE-archive-dependency-security.md`](docs/dev/issues/ISSUE-archive-dependency-security.md)) did not introduce
the synchronicity — it was always there — though 0.6.0's hardened extraction may have changed its
speed; the bump must stay regardless.

**What has to be done:** move ZIP extraction off the main thread. Either:

- run the existing adm-zip extraction inside a `worker_threads` Worker (smallest change; the two
  call sites keep their signatures), or
- replace adm-zip with an async streaming unzip (e.g. yauzl) and extract entry-by-entry.

Either way, emit per-entry progress through the existing `'binary-progress'` `extracting` phase
(entries done / total is enough) so hosts can show life during what is today a silent block.
`extractBinary`/`extractArchive` are the only two consumers; their async signatures already return
Promises, so no API change is needed.

### 2. Byte-identical dependency archives are re-downloaded every time

`BinaryManager.downloadDependencies()` (src/managers/BinaryManager.ts, ~line 352) downloads every
dependency unconditionally, each time `downloadAndTestVariant()` runs. But
`cudart-sd-bin-win-cu12-x64.zip` has been **byte-identical across sd.cpp releases** — same
checksum `fe20366…` across the `master-746` → `master-782` re-pin, and
`docs/dev/UPDATING-BINARIES.md` documents this ("compare digests before assuming a new download is
needed"). During this incident the same ~300 MB cudart archive was downloaded three times in one
evening (twice for the killed first attempt and its retry, once more inside the same session)
while its extracted DLLs were already sitting in the binaries directory.

**What has to be done:** keep a small manifest in `PATHS.binaries[type]` (e.g. `.deps.json`)
recording `{url, checksum}` of each dependency archive successfully extracted there. Before
downloading a dependency, if the manifest has a matching checksum entry, skip download and
extraction. Invalidate the entry when the binaries directory is cleaned or the dependency checksum
in `BINARY_VERSIONS` changes. (Verifying the extracted DLLs themselves is not required — the
manifest entry is only written after a verified archive was extracted successfully.)

### 3. Interrupted provisioning leaves residue and silently restarts from zero

Killing the app mid-provisioning — which finding 1 actively invites, since the app looks hung —
leaves `<binary>.<variant>.extract/` directories and stale archives behind, and the next attempt
starts the whole pipeline from scratch (including all dependency downloads). Observed directly:
an orphaned `sd-cli.exe.cuda.extract/` containing only the three cudart DLLs survived the killed
first attempt.

**What has to be done:**

- On entry to `downloadAndTestVariant()`, delete any stale extract dir for that variant before
  reusing it (today `extractAllTo(…, overwrite=true)` papers over it, but a partial main-archive
  extraction mixed with fresh dependency DLLs is an untested state).
- Reuse a fully-downloaded archive when one is already present and its checksum verifies, instead
  of re-downloading. (The `Downloader`'s `.partial` scheme already prevents a truncated file from
  being mistaken for a complete one, so a bare `<name>.zip` that passes checksum is safe to reuse.)
- Optional, larger: support HTTP range-resume of `.partial` downloads.

### 4. The phase-2 diffusion test ignores production offload auto-detection

`BinaryManager.runDiffusionTest()` (~line 839) spawns `sd-cli` with only the model args
(64×64, 1 step, 120 s timeout). Production generation, by contrast, auto-detects
`--clip-on-cpu` / `--vae-on-cpu` / `--offload-to-cpu` from VRAM headroom
(`DiffusionServerManager`). On the incident machine production runs **fully CPU-offloaded**
(`total params memory size = 5950.33MB (VRAM 0.00MB, RAM 5950.33MB)`), yet the phase-2 test asks
the CUDA build to place the same ~6 GB model with no offload flags at all.

It happened to pass here, but the failure mode is severe when it doesn't: a CUDA OOM in the test
output matches `GPU_ERROR_PATTERNS` (`'out of memory'`, `'failed to allocate'`), the variant is
judged broken, `ensureBinary()` falls through to the Vulkan variant — silently discarding ~600 MB
of downloads — and the wrong variant is then **cached in `.validation.json`**, so the machine is
stuck on it until a version re-pin. The test would be rejecting a variant for a resource condition
that production handles by design.

Related fragility: `checkForGpuErrors()` does substring matching over combined stdout+stderr.
Upstream log-format changes are routine (see the `master-782` sampler-table string bug in
`UPDATING-BINARIES.md`), so an innocuous log line containing e.g. "error: invalid argument" as
part of prose would also fail a healthy variant.

**What has to be done:** build the phase-2 test command through the same offload auto-detection
used for production generation (the detection logic already lives in `DiffusionServerManager`;
pass the resolved flags into `BinaryManagerConfig` alongside `testModelArgs`). Secondarily,
tighten `checkForGpuErrors()` to line-anchored matches so prose containing a pattern substring
does not fail a variant.

### 5. Provisioning logs are lost

`ServerManager.ensureBinaryHelper()` (src/managers/ServerManager.ts, ~line 512) logs via
`this.logManager?.write(…)` — but the log manager is only created later during `start()`, so
during provisioning the optional chain no-ops. Verified in the incident: `diffusion-server.log`
contains **nothing** from any of the evening's three provisioning runs; its last entry is the
morning's pre-update session. The `'binary-log'` events do fire, but a host that doesn't persist
them (palimpsest didn't) leaves no record anywhere. The most failure-prone part of the pipeline is
the only part that writes no log.

**What has to be done:** make provisioning logs durable without host cooperation — either create
(or accept) the log manager before `ensureBinary()` runs, or buffer provisioning log lines in
`ServerManager` and flush them into the log manager when it is created. `'binary-log'` stays
as-is.

## Ruled out / verified during the incident

- **Model / sd.cpp compatibility:** fine. The re-pinned binary and the multi-component Flux 2
  Klein model pass phase 1+2 and generate correctly once provisioning completes.
- **Variant fall-through:** did not occur — the CUDA variant passed; the "downloading again"
  appearance was sequential archives + the killed first attempt (findings 2/3), not retries.
- **Checksum step:** streaming, not a freeze contributor.
- **Download URL/revision handling:** tracked separately in
  [`ISSUE-genai-electron-huggingface-downloads.md`](docs/dev/issues/ISSUE-genai-electron-huggingface-downloads.md);
  nothing here overlaps it.

## Acceptance criteria

- Extracting the Windows CUDA archives does not block the Electron main process; the window stays
  responsive through the entire provisioning pipeline.
- A dependency archive whose checksum is already recorded as installed is not re-downloaded.
- Re-running provisioning after a mid-run kill reuses verified downloads and starts from a clean
  extract state.
- The phase-2 diffusion test uses the same offload flags production would use on that machine.
- After a provisioning run (success or failure), the per-server log file contains the full
  BinaryManager log for it.

## Resolution

- ZIP parsing and per-file extraction now run in an inline `worker_threads` worker for both archive
  consumers. `'binary-progress'` carries optional `completedEntries` / `totalEntries` counters, and
  a real-archive heartbeat regression confirms the caller's event loop remains responsive.
- Verified dependency installations are recorded atomically in checksum-addressed `.deps.json`
  manifests with validated file lists. A cache hit stages installed files without another
  download or inflation, even if the source URL changed.
- Every variant begins from clean staging. Complete bare main/dependency archives left by an
  interruption are reused only after SHA-256 verification; checksum mismatches are discarded. If
  installation completed before the interruption, the validated-binary fast path removes leftover
  main archives and extraction directories before returning. It deletes a dependency archive only
  when its checksum matches committed manifest state, retaining an unmanifested archive as the
  recovery point for a kill between installation and manifest commit.
- Diffusion Phase-2 validation and production generation share one resolved offload/flash-attention
  flag mapper. GPU failure detection is line-aware, retaining direct/function-prefixed backend
  errors without treating prose as a failure.
- Llama and diffusion logs initialize before provisioning and keep the same serial writer through
  startup or failure, so BinaryManager output is durable.
- The final double-check also closed two adjacent races: concurrent starts are rejected while
  provisioning is active, and main archives cannot overwrite a dependency-owned path before that
  dependency is installed or recorded.
- A real-filesystem integration test provisions through the actual ZIP worker and filesystem,
  persists `.deps.json` atomically, constructs a fresh manager, changes the dependency URL while
  retaining its checksum, and confirms the second run neither downloads nor inflates it and stages
  the installed dependency beside the candidate before validation.

## Validation evidence

- 215/215 original focused archive, BinaryManager, and server-manager tests pass, plus 58/58
  focused cleanup/cache follow-up tests.
- 634/634 full tests across 26 suites pass with Jest open-handle detection.
- TypeScript build, repository formatting, and lint pass; lint retains 61 existing warnings and
  introduces no errors.
- Generated runtime/declaration output contains the inline worker, additive progress fields,
  validation flags, collision guard, and concurrent-start guard.
- The 163-file npm package dry run and `git diff --check` pass.
- Final follow-up double-check found and closed the install-before-manifest recovery window, then
  confirmed the corrected cleanup policy and candidate-staging integration check have no blocker.
