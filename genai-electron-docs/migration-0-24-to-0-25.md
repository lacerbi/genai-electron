# Migrating from v0.24.0 to v0.25.0

v0.25.0 replaces the per-image `sd-cli` spawn inside `DiffusionServerManager` with a persistent
stable-diffusion.cpp `sd-server` backend driven through its native job API, adds a residency policy
(`'single'` / `'burst'`), makes resource orchestration symmetric (an LLM start yields a resident
diffusion backend), and re-bases offload calibration on the same backend. The wrapper's HTTP
contract, the manager's method and event surface, and every existing configuration key are
preserved, so existing applications and genai-lite consumers keep working without source changes.

Because genai-electron is pre-1.0, a dependency range such as `^0.24.0` does not admit v0.25.0.
Update the range or exact pin explicitly to adopt this release.

## What changed

- **Process model.** `diffusionServer.start()` still starts only the node:http wrapper (no VRAM is
  held). The first image request spawns one `sd-server` child lazily; later images reuse it while it
  is resident. Results travel as base64 inside the job JSON — no temp PNG files are written.
- **Residency policy.** After each image the backend is either released (`'single'`: VRAM handed
  back immediately) or kept warm (`'burst'`: released after `idleTimeoutMs`, default 300 000 ms,
  `0` = never). The mode is resolved per image: `ImageGenerationConfig.usageMode` (request) >
  `DiffusionServerConfig.usageMode` (server-level, when not `'auto'`) > computed (`'single'` when the
  orchestrator had to offload the LLM for this image, `'burst'` otherwise).
- **Symmetric orchestration.** The LLM reload after an offloaded image happens only after the
  backend is released (`'single'`), or is deferred under `'burst'` until a qualifying release
  (idle timeout, explicit `releaseBackend()`, backend crash, `stop()`, or a cancelled image).
  `llamaServer.start()` now runs pre-start hooks; the built-in hook releases a resident diffusion
  backend when the LLM and the backend would not fit together, and fails the LLM start with
  `CALIBRATION_IN_PROGRESS` while an offload calibration sweep is running. Batch requests
  (`count > 1`) now go through the orchestrator (offload once, generate N, settle once).
- **Calibration.** `calibrate()` accepts `usageMode` (default `'single'` = one cold spawn per timed
  sample; `'burst'` = one launch per combo, warm samples), echoes `usageMode` and
  `policyVersion: 'diffusion-offload-v2'`, and records per-run `vramPeakBytes` / `vramIdleBytes`
  (NVIDIA on Linux/Windows only). `stageMs.loadMs` is spawn-relative in `'single'` and
  submit-relative in `'burst'`; timings compare only within one mode.
- **Provisioning.** `sd-server(.exe)` is the primary validated binary (Phase-2 validation launches
  it and runs one 64×64 job through the job API); `sd-cli` is still extracted but never executed.
  `<userData>/loras` is created and passed as `--lora-model-dir`. No binary pin change
  (`master-782-b290693`).

## New public surface (all additive)

- `DiffusionServerConfig`: `host` (default `'127.0.0.1'`), `startupTimeout`, `usageMode`,
  `idleTimeoutMs`.
- `ImageGenerationConfig.usageMode`; the same optional field in the wrapper's POST body.
- `DiffusionServerManager.releaseBackend({ reason?, waitForInFlight? })`, `getBackendInfo()`;
  `getInfo().backend` (and `pid` now reports the backend PID while resident); `/health` gains
  `backend`.
- Event `'backend-status'` (`DiffusionBackendStatusEvent`); `'calibration-progress'` is now declared
  in `ServerEvent`.
- `LlamaServerManager.registerPreStartHook(hook)` and the `LlamaPreStartHook` type.
- Types `DiffusionUsageMode`, `DiffusionBackendState`, `DiffusionBackendReleaseReason`,
  `DiffusionBackendInfo`, `DiffusionBackendStatusEvent`; constant `DIFFUSION_BACKEND_DEFAULTS`.
- Calibration: `DiffusionCalibrationConfig.usageMode`, `DiffusionCalibrationReport.usageMode` /
  `policyVersion`, `CalibrationRun.vramPeakBytes` / `vramIdleBytes`.

## Behavior changes to review

- **The wrapper binds `127.0.0.1` by default** (previously all interfaces). Hosts that reached the
  wrapper from another machine must set `DiffusionServerConfig.host` explicitly.
- `getInfo().pid` is the backend PID while a backend is resident and `undefined` otherwise (it was
  always `undefined` before).
- `stop()` and `attachAppLifecycle()` now also stop a resident backend (confirmed death), including a
  backend left alive by a calibration sweep; quit never starts an LLM.
- HTTP: malformed JSON → `400 INVALID_REQUEST` (was 500); `503 SERVER_NOT_RUNNING` while the
  wrapper is not running; `400` for an invalid `usageMode`; a cancelled generation ends with
  `status: 'cancelled'` (incl. `stop()` mid-image); a backend queue-full maps to `SERVER_BUSY`.
- Cancelling a generating image kills the backend (the next image pays a reload); cancelling a
  queued job uses the backend API. `DELETE` answers on initiation.
- Existing installs re-validate the binary cache once (no re-download) because the primary binary
  name changed; POSIX fresh installs get the exec bit before validation.
- `batchSize` maps to the job's `batch_count` (clamped to ≥ 1); `-b` is no longer emitted. The
  `gpuLayers` diffusion field remains accepted and ignored.
- Warm images show no `loading` ticks (the backend is already resident); cold images carry the
  model-placement work inside the first job.
- Persisted offload-calibration reports without `policyVersion` were measured under the old
  one-spawn-per-image model; treat them as stale and re-measure.

## Compatibility

- genai-lite (checked against 0.19.0) needs no change: request keys, `201 {id}`, the per-status GET
  payloads, `result.images[].{image,seed,width,height}`, `error.{message,code}`, and `DELETE`
  semantics are unchanged; the new fields are additive.
- The example control panel keeps its method calls, events, config keys, and stage tokens
  (`loading | diffusion | decoding`).
- `'crashed'` is still never emitted by the diffusion manager — a backend crash surfaces as
  `'backend-status'` (`reason: 'crashed'`) while the wrapper keeps running and respawns lazily.
- Only the built-in orchestration (the `diffusionServer` singleton wired to `llamaServer`, or a
  `DiffusionServerManager` constructed with a `llamaServer`) participates in deferred reloads; a
  host-constructed `ResourceOrchestrator` is a separate instance.

## Consumer action

1. Update the dependency to v0.25.0 or a compatible range beginning at v0.25.0.
2. If the wrapper must be reachable off-loopback, set `DiffusionServerConfig.host` deliberately
   (and protect it — the wrapper has no authentication).
3. Decide whether the computed residency default fits your app; otherwise set
   `DiffusionServerConfig.usageMode` (`'single'` to always free VRAM after an image, `'burst'` to
   keep it warm) and tune `idleTimeoutMs`.
4. If you display backend state, read `getInfo().backend` / `'backend-status'`; treat `pid` as the
   backend PID.
5. If you persist offload-calibration recommendations, key them by `policyVersion` and `usageMode`
   and re-measure reports that lack `policyVersion`.
6. If you cancel long images, expect the next image after a cancel to pay a backend reload.

## Verification and rollback

Verify in the packaged application: the wrapper listens on the intended host; a cold image, then a
warm one; `DELETE` mid-image; with the LLM running, an image offloads and the LLM returns after the
backend is released; `stop()` leaves no `sd-server` process. `scripts/live-smoke/` in the repository
holds the end-to-end harness used for the reference machine.

To roll back, pin v0.24.0: persisted models and binary caches are compatible (the v0.24.0 provisioning
re-validates `sd-cli` once); persisted calibration reports from v0.25.0 carry `policyVersion` and
should not be applied by a v0.24.0 host.

## Checklist

- [ ] Update the dependency to v0.25.0.
- [ ] Confirm the wrapper's bind host (`127.0.0.1` default) matches the deployment.
- [ ] Choose `usageMode` / `idleTimeoutMs` or keep the computed default.
- [ ] Re-measure or discard offload-calibration reports without `policyVersion`.
- [ ] Exercise cold/warm generation, cancel, crash recovery, and the LLM offload cycle in the
      packaged application.
