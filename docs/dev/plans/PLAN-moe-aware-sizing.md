# Plan: MoE-Aware Auto-Configuration (v0.8.0)

Created: 2026-07-03
Post-review (Opus doublecheck, 6 findings, all addressed pre-merge):
- MEDIUM sharded-MoE partial measurement → tensorInfos dropped in the sharded download
  path AND updateModelMetadata for sharded models (heuristic fallback covers them); test.
- nCpuMoe missing from orchestrator estimate → proportional split added.
- Auto tier restricted to MEASURED expert bytes (heuristic = hint-driven only); test.
- typescript-reference GGUFMetadata array types corrected; PROGRESS counts/files fixed.
- Added tests: nCpuMoe layer packing, hinted-cpuMoe partial-trunk branch. 532/532.

Status: COMPLETE (2026-07-03) — implemented, tested, live-verified (see Verification)
Resolves: ISSUE-moe-aware-auto-config.md (filed from palimpsest-engine 0.7.1 integration)

## User-approved design decisions

1. **Tier 3 is default**: when an MoE model's full weights don't fit VRAM but the dense
   trunk does (and experts fit RAM), auto-recommend `cpuMoe: true` + full offload with
   context sized against the trunk. Ladder: full dense offload → cpuMoe trunk offload →
   dense partial offload → CPU.
2. **`overrideTensors: 'exps=CPU'`** (exact string) is treated as `cpuMoe` for sizing;
   any other `-ot` pattern → skip the weights-split adjustment (dense math, conservative).
3. **Shared experts (`_shexp`) count as trunk** — the `_exps` tensor-name match mirrors
   llama.cpp's `--cpu-moe` pattern exactly (shexp stays on GPU there too).

## Key technique (beyond the issue's suggestion)

**Measure, don't estimate**: `fetchGGUFMetadata`/`fetchLocalGGUFMetadata` already parse
`tensorInfos` (name/offset per tensor; currently discarded). Sorting by offset and diffing
gives exact per-tensor byte sizes — summing `_exps` tensors yields the exact expert byte
share, quant-agnostic (correct even for Unsloth Dynamic quants where experts and trunk use
different bit-widths). Stored as `GGUFMetadata.expert_weights_bytes` at download time.
Fallback for older downloads: param-count heuristic via `general.parameter_count` +
`expert_count × 3 × embedding × expert_ff × layers`; absent that → dense treatment.

## Work

1. [x] Metadata: `expert_count`, `expert_used_count`, `expert_feed_forward_length`,
   `expert_weights_bytes` on `GGUFMetadata`; extraction in `createGGUFMetadataFromParsed`
   (accepts tensorInfos; offset-delta measurement, `_exps.` name match, BigInt-safe).
   Sharded models: shard-1 tensorInfos only → skip measurement (heuristic fallback).
2. [x] Helpers: `getExpertCountWithFallback`, `getExpertWeightsBytesWithFallback`
   (typed → raw lookup → parameter-count heuristic → undefined).
3. [x] Hints: `OptimalConfigHints` += `cpuMoe`, `nCpuMoe`, `overrideTensors`;
   `autoConfigureIfNeeded` forwards them and merges `optimalConfig.cpuMoe`.
4. [x] Sizing in `getOptimalConfig`: weight-split model (cpuMoe → trunk on GPU, experts
   on RAM budget; nCpuMoe → proportional split; custom -ot → dense). Auto tier between
   full-dense and partial-dense: trunk + required KV ≤ vramBudget AND experts fit RAM →
   `cpuMoe: true`, gpuLayers = all, ctx from trunk leftover. KV stays GPU-side (llama.cpp
   keeps attention/KV on GPU under --cpu-moe). Cache-type selection unchanged (dense-weights
   abundance test; MoE naturally lands on q8_0).
5. [x] `ResourceOrchestrator.estimateLLMUsage`: cpuMoe-aware split (trunk+KV on VRAM,
   experts on RAM).
6. [x] Tests: extraction (mock tensorInfos incl. `_shexp` non-match), helper fallbacks,
   sizing matrix (MoE-too-big → auto cpuMoe + ctx ≫ floor; MoE-fits → plain full offload;
   palimpsest hint case cpuMoe+gpuLayers 999 → trunk-sized ctx; 'exps=CPU' ≡ cpuMoe;
   custom -ot → dense; experts-don't-fit-RAM → dense partial), autoconfig --cpu-moe emission.
7. [x] Docs: system-detection (MoE tier), llm-server auto-config note, typescript-reference
   (fields + hints), migration-0-7-to-0-8.md, versions → 0.8.0, PROGRESS entry.
8. [x] Resolve & archive ISSUE; archive this plan; PR + merge + tag + GH release.

Discovered during live smoke (first run FAILED with NaN + RAM gate):

9. [x] Gemma 4 stores `attention.head_count_kv` as a per-layer ARRAY
   ([8,8,8,8,8,2,...] — alternating full/sliding-window attention). Widen
   GGUFMetadata head-count/key-length fields to `number | number[]` and
   normalize via mean in the fallback helpers (mean makes the summed KV cost
   exact). Regression test with the real gemma4 shape.
10. [x] `os.freemem()` on Windows excludes standby-list memory (smoke saw
   "1.5GB available" on a box with tens of GB reclaimable) — starves
   canRunModel and the experts-fit-RAM gate. Add standby-aware Windows
   available-memory refresh (PerfOS AvailableBytes via PowerShell) cached in
   memory-detect, refreshed from SystemInfo.detect(); getMemoryInfo() stays
   sync and takes max(freemem, cached).

## Verification

- [x] 0 TS errors, lint clean (unmasked; 0 errors), 529/529 tests (21 suites).
- [x] Live GPU smoke (2026-07-03, two runs): pure auto-config on gemma-4-26B-A4B
  (12.5 GiB file, measured 10.08 GiB experts / 2.42 GiB trunk). Run 1 FAILED and
  yielded items 9-10 (per-layer head_count_kv array → NaN; Windows freemem starvation)
  plus the mmap-aware expert gate. Run 2 PASSED all config assertions:
  `--cpu-moe` auto-selected, `-ngl 30` full trunk offload, auto q8_0 KV + `-fa on`,
  **contextSize 16384** (vs the 4096 floor the issue reported), server healthy and
  /props-confirmed — i.e. the 12.5 GiB model loaded and served on an 8 GiB-class GPU +
  23 GiB-RAM machine. The final generation round-trip was interrupted by a manual stop
  of the background task, then completed in a dedicated e2e run post-release:
  131 tokens at ~12.2 tok/s on the auto-configured --cpu-moe server (experts on CPU),
  final answer exact ("MOE-OK") with Gemma 4's thinking cleanly separated into
  reasoning_content — the --jinja reasoning contract holds on MoE; warm start 7.9 s. Dense regression: covered by the unchanged
  getOptimalConfig dense test matrix (529 tests).

Status: COMPLETE (2026-07-03)
