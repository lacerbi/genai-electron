# ISSUE: getOptimalConfig has no MoE awareness — experts-on-CPU configs are mis-sized

Created: 2026-07-03
Status: RESOLVED (2026-07-03, v0.8.0) — all three tiers implemented: MoE metadata
extraction incl. exact expert-weights measurement from GGUF tensor offsets
(expert_weights_bytes), offload-plan hints (cpuMoe/nCpuMoe/overrideTensors with
'exps=CPU' recognized), and automatic cpuMoe recommendation when the trunk fits
VRAM and experts fit RAM. See genai-electron-docs/migration-0-7-to-0-8.md and
docs/dev/plans/PLAN-moe-aware-sizing.md.
Package: genai-electron (filed from palimpsest-engine 0.7.1 integration work)

## Problem

The v0.7.0 adaptive sizing treats the entire model file as GPU-resident:
`weightsGPU = modelInfo.size × 1.1` (src/system/SystemInfo.ts, full- and
partial-offload branches). For MoE models run with `--cpu-moe` (or
`--n-cpu-moe` / `-ot`), only the dense trunk actually occupies VRAM — the
expert weights (the bulk of the file) live in RAM — so this assumption breaks
both directions of the config:

1. **Context is clamped to the floor.** A caller configuring the standard
   MoE-offload setup (`cpuMoe: true`, `gpuLayers: ≥ totalLayers`) and passing
   `gpuLayers` as a hint hits the full-offload branch, where
   `(vramBudget − full_MoE_weights) / bytesPerToken` goes negative and
   `clampCtx` returns the 4096 floor — on hardware that could comfortably run
   32K+ (e.g. Gemma 4 26B-A4B UD-Q4_K_XL, 14.2 GB file, ~few-GB trunk, on a
   12 GB GPU). Without hints, the partial-offload branch similarly
   over-reserves and undersizes both `gpuLayers` and context.
2. **Callers can't even detect MoE from parsed metadata.** `GGUFMetadata`
   carries no expert fields, so downstream apps resort to filename heuristics
   (palimpsest matches `/-a\d+b\b/i`, e.g. `gemma-4-26B-A4B`, `Qwen3-30B-A3B`)
   and then bypass the sizing entirely for those models.

Downstream state today: palimpsest keeps its own MoE path — filename
detection, `cpuMoe: true` + `gpuLayers: 999`, and a manually chosen
`contextSize` — and only trusts `getOptimalConfig` for dense models.

## Fix

Suggested, in increasing order of ambition:

1. **Parse MoE metadata.** Add `expert_count` (and optionally
   `expert_used_count`, `expert_feed_forward_length`) to `GGUFMetadata` —
   `{arch}.expert_count` is a standard GGUF key and the arch-field resolver
   already handles prefixing. This alone lets callers detect MoE robustly and
   drop filename heuristics.
2. **Accept the offload plan as hints.** Let `OptimalConfigHints` carry
   `cpuMoe` / `nCpuMoe` / `overrideTensors`; when experts stay on CPU, size
   `weightsGPU` as the dense-trunk share only (estimable from the expert
   tensor fraction of the file, or a conservative heuristic like
   activeParams/totalParams from the model name/metadata), keep the KV budget
   GPU-side for all offloaded layers, and count expert weights against the
   RAM budget instead.
3. **Auto-recommend the offload.** When `expert_count > 0` and full weights
   don't fit `vramBudget` but the dense trunk does, return
   `cpuMoe: true, gpuLayers: totalLayers` with context sized per (2) —
   making the MoE path as hands-off as the dense path became in v0.7.0.

## Notes

- Severity: medium — no crash; MoE users of getOptimalConfig get floor-level
  context or CPU-heavy partial offload on hardware that can do much better.
- Step (1) is independently useful and cheap; (2) makes hint-driven MoE
  setups correct; (3) is the quality-of-life end state.
- Relevant context: llama.cpp's `--cpu-moe` keeps attention/KV on GPU for
  offloaded layers, so per-token KV math from v0.7.0 carries over unchanged —
  only the weights split needs to become offload-plan-aware.
