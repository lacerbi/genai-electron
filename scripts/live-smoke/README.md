# Live smoke: persistent `sd-server` diffusion backend

`sd-server-live-smoke.mjs` drives the **real** library (`dist/`) against the **real** binaries and
models on this machine and checks the behaviors the unit suites can only fake: provisioning +
Phase-2 validation of the pinned stable-diffusion.cpp build, cold/warm generation through the HTTP
wrapper (same request shape genai-lite sends), cancel, backend crash + respawn, idle timeout, the
LLM offload / yield / `single` / `burst` cycle with a real llama-server, `stop()` with a resident
backend, calibration in both `usageMode`s, re-validation without re-download, and a 2048² probe.

It is the tool to re-run after a stable-diffusion.cpp **pin bump** (see
`docs/dev/UPDATING-BINARIES.md`) and after changes to `DiffusionServerManager` /
`ResourceOrchestrator`. Reference results: `docs/dev/plans/PLAN-sd-server-migration.md` (Phase 7).

## Run

```bash
npm run build   # the script imports ../../dist/index.js
# Windows (Git Bash); on macOS/Linux use node_modules/.bin/electron
examples/electron-control-panel/node_modules/electron/dist/electron.exe \
  scripts/live-smoke/sd-server-live-smoke.mjs
```

- Reuses the example app's `userData` by default (models + binary cache), so the models named by
  `SMOKE_DIFF_MODEL` / `SMOKE_LLM_MODEL` must already be downloaded there (ids as in
  `userData/models/*/*.json`). Override with `SMOKE_USERDATA`.
- `SMOKE_STEPS="S7,S8"` runs a subset (steps are `S1`…`S11`, see the script); each step is
  independent enough to be run alone except that S8–S11 expect the binaries provisioned by S1.
- Output: `scripts/live-smoke/artifacts/live-smoke_<ts>.{log,json}` (gitignored).
- It is GPU-heavy (~10 min end to end; the first `S1` may download binaries). Run it in the
  **foreground**; background runs can be killed from outside mid-scenario.
- Expected wall clock on the reference laptop (RTX 4060 8 GB, klein 4B Q4_0): cold image ≈ 11 s,
  warm ≈ 7 s, calibration S9 ≈ 1.5 min, S11 up to 3 min.

The script is an Electron main-process ESM entry: do not `await app.whenReady()` at top level
(Electron waits for the entry module's top-level evaluation before emitting `ready`).
