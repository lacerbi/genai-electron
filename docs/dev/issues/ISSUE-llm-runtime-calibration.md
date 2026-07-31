# ISSUE: LLM runtime calibration for `swaFull`, `gpuLayers`, and related flags

Created: 2026-07-31
Updated: 2026-07-31 (implemented and verified)
Status: RESOLVED
Resolved in: v0.18.0
Package: genai-electron
Filed from: palimpsest-engine (consumer), after adopting v0.17.0
Plan: [`PLAN-llm-runtime-calibration.md`](../plans/PLAN-llm-runtime-calibration.md)

## Resolution

Implemented `LlamaServerManager.calibrate()` and `isCalibrating()` as a serial, fixed-profile,
report-only calibration API. The generated policy is a bounded model-aware core rather than a
Cartesian flag sweep, and callers can replace it with an exact narrower candidate list. One call
holds total `contextSize` and `parallelRequests` constant; consumers compare capacity tradeoffs by
running separate calls. KV-cache types remain caller-controlled by default, with one optional
f16/q8 comparison and a configurable precision preference window.

The implementation uses isolated real `llama-server` processes and the server HTTP path because
`llama-bench`, `llama-batched-bench`, and `llama-fit-params` do not reproduce the prompt-cache,
slot, SWA, and lifecycle behavior being calibrated. It returns reproducible per-workload reports
and a start-ready recommendation but deliberately does not persist or auto-apply it.

Verification completed with the full automated suite, open-handle diagnostics, and the pinned
Windows CUDA b9860 server against Gemma 4 12B. The smoke covered fixed `/props` capacity, slot
erase, shared-prefix cache observation, exact output lengths, candidate cleanup, and a subsequent
normal manager start using the resolved config.

## Summary

v0.17.0 shipped `LlamaServerConfig.swaFull` as a deliberately opt-in flag, with
automatic enablement explicitly not added. Deciding it — and the toggles it
interacts with — is a per-machine, per-model, per-context measurement question,
and genai-electron already has the right instrument for exactly this class of
question on the diffusion side: `DiffusionServerManager.calibrate()`, which
benchmarks a set of `DiffusionOffloadCombo`s with production-mirrored
generation settings (warmup + timed samples per combo, fixed seed, progress
events, AbortSignal) and returns a report the host uses to set the offload
toggles. This issue requests the analogous `LlamaServerManager.calibrate()`.

## Why a benchmark, not placement arithmetic

The reference consumer machine (8 GB CUDA card, Gemma 4 12B IQ4_XS, 12,288
tokens/slot; palimpsest-engine `ISSUE-soft-eval-prompt-cache-reuse.md`) shows
both directions:

- `--swa-full` plus `-ngl 42` measured **3.6× on soft evaluation**
  (1106 → 309 ms/sample) and 1.7× on whole-turn LLM time. Without it, prefix
  reuse collapses to the shared system prompt for any request under ~1024
  tokens — exactly the short-request band.
- The same card has a thrash cliff past ~7.5 GB where a **full offload
  measures worse than baseline** even though it nominally fits. Sizing
  arithmetic says yes; the benchmark says no. That is why the diffusion side
  calibrates by running real generations rather than pricing components, and
  the same reasoning applies here.

## Requested behavior — mirror the diffusion calibration design

An `LlamaServerManager.calibrate()` (name flexible) with the same contract
shape as the diffusion sweep:

1. **Combos over the LLM toggles**: `swaFull` on/off × a `gpuLayers` ladder
   (and optionally `cacheTypeK`/`cacheTypeV`), benchmarked at the
   application's production `contextSize` and slot count — mirrored from
   production for the same reason `DiffusionCalibrationGeneration` requires
   steps/sampler/threads to match: the winner changes with the workload.
2. **Workloads that mirror the two real request shapes**: (a) a long-prefill
   generation sample (narration-shaped), and (b) a burst of short, similar
   requests sharing a large prefix (soft-eval-shaped) — the case `swaFull`
   exists for, and the one a single long-generation benchmark would miss.
   Fixed seed, one discarded warmup, N timed samples per combo.
3. **Stability is a first-class result, not a silent skip**: a combo that
   OOMs, thrashes, or fails to start is reported as such in its
   `CalibrationRun` — the cliff behavior above is precisely the data point
   the report exists to capture.
4. **Same ergonomics as the diffusion sweep**: progress callback + events,
   AbortSignal with partial runs on abort, server held stopped while
   calibrating.
5. **The report drives the toggles**: the host applies the winning combo (as
   it does with `diffusionOffload` today), or — nicer — the result is stored
   per model as calibrated defaults that `getOptimalConfig()` and restores
   after image-generation offload cycles pick up automatically.

## Consumer context

palimpsest-engine adopted v0.17.0 on 2026-07-31 and wired `swaFull` through to
an opt-in GUI toggle as the interim surface; its dev launcher carries
hand-measured per-model `-ngl` values with a comment admitting the non-12B
ones predate `--swa-full` and need re-measurement. Both are exactly what a
calibration report replaces: the GUI would run LLM calibration from the same
settings surface as diffusion calibration, and the hand-tuned presets become
report output. See PLAN-request-class-contract.md (Phase 1.5 adoption item)
in that repo.
