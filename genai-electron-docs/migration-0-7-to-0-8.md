# Migrating from v0.7.x to v0.8.0

v0.8.0 makes auto-configuration **MoE-aware**. Mixture-of-Experts models that don't fit in VRAM as a whole are now automatically run with `--cpu-moe` (experts in RAM, dense trunk + KV cache fully on GPU) instead of falling into slow dense partial offload with a floor-level context. Explicit configuration is always respected.

## Compatibility

All API changes are additive. Behavioral change (auto-configured MoE models with GGUF metadata only):

- **`cpuMoe: true` is auto-recommended** when full weights don't fit VRAM but the dense trunk does *and* the expert weights fit available RAM. This means `start({ modelId })` on a large MoE model now uses several GB of **RAM** for expert weights (e.g. ~10 GB for Gemma-4-26B-A4B) — previously it would have used a slow dense partial offload instead. **Opt out** with an explicit `cpuMoe: false` (or any explicit offload field — `gpuLayers`, `nCpuMoe`, `overrideTensors` — which makes the auto-recommendation stand down and sizes for your plan instead).
- Context for MoE offload setups is now sized against the **trunk**, not the whole file — the v0.7 behavior of clamping to the 4096 floor for `cpuMoe` configurations (filed as `ISSUE-moe-aware-auto-config.md`) is fixed.
- Dense models are completely unaffected — with two hardening exceptions that benefit everyone:
  - **Per-layer attention arrays**: architectures with heterogeneous attention (e.g. Gemma 4's alternating full/sliding-window layers) store `attention.head_count_kv` as a per-layer array; the KV math now normalizes these via mean (exact for the summed cache cost). `GGUFMetadata` head-count/key-length fields are typed `number | number[]` accordingly.
  - **Windows available-RAM detection**: `os.freemem()` excludes Windows' standby list, making busy machines look starved. `SystemInfo` now refreshes a standby-aware reading (PerfOS `AvailableBytes`) during `detect()`, so RAM-feasibility checks see reclaimable memory.
  - **mmap-aware expert gating**: expert weights are memory-mapped and sparsely activated (e.g. 8 of 128 experts per token), so `canRunModel()` gates them against **60% of total RAM** rather than requiring committed free RAM; only the dense trunk keeps the strict committed requirement.

## What's New

| Feature | Summary |
| --- | --- |
| Expert-weights measurement | `GGUFMetadata.expert_weights_bytes` — exact `_exps` tensor bytes from GGUF offsets (quant-agnostic, correct for Unsloth Dynamic quants), computed at download |
| MoE metadata | `expert_count`, `expert_used_count`, `expert_feed_forward_length` extracted — no more filename heuristics for MoE detection |
| MoE offload hints | `OptimalConfigHints` accepts `cpuMoe`, `nCpuMoe`, `overrideTensors`; `'exps=CPU'` is treated as `cpuMoe`, other `-ot` patterns are sized conservatively as dense |
| Auto `cpuMoe` tier | Decision ladder: full dense offload → **cpuMoe trunk offload** → dense partial offload → CPU |
| MoE-aware estimates | ResourceOrchestrator accounts CPU-resident experts against RAM, not VRAM |

## Extended Interfaces

```typescript
interface GGUFMetadata {
  // ... existing fields ...
  expert_count?: number;
  expert_used_count?: number;
  expert_feed_forward_length?: number;
  expert_weights_bytes?: number; // what --cpu-moe moves to RAM
}
```

`OptimalConfigHints` gains `cpuMoe` / `nCpuMoe` / `overrideTensors`.

New helpers exported via metadata utilities: `getExpertCountWithFallback`, `getExpertWeightsBytesWithFallback` (measured → parameter-count heuristic → undefined). Models downloaded before v0.8.0 fall back to the heuristic (needs `general.parameter_count` in stored raw metadata) or dense treatment; re-download or call `updateModelMetadata` to get exact measurements.

## See Also

- [System Detection](system-detection.md) — the full decision ladder
- [Migrating 0.6 → 0.7](migration-0-6-to-0-7.md) — the adaptive-sizing foundation
