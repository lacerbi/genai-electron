# Plan: Adaptive Context Sizing & KV-Aware Auto-Configuration (v0.7.0)

Created: 2026-07-03
Status: COMPLETE (2026-07-03) — implemented, tested (506/506), live-verified on GPU
Resolves: ISSUE-context-size-recommendation.md (filed from palimpsest-engine integration)

## Summary

Replace the `recommendContextSize` stub (constant 4096) with real KV-cache math from GGUF
metadata, restructure `calculateGPULayers` policy to prefer **full GPU offload** (flexible
KV reserve instead of the flat 2 GB), auto-select **q8_0 KV quantization by default**
(f16 only when headroom is abundant), and make `canRunModel` / ResourceOrchestrator
estimates KV-aware. Ships as v0.7.0 (behavior change: auto-configured servers offload
more aggressively and allocate larger KV caches).

## User-approved design decisions

1. **No ceiling** on auto-recommended context beyond the model's own `context_length`.
2. **KV quant auto-selection is ON by default**, leaning q8_0 (small quality loss):
   f16 only when f16 KV at the model's FULL native context fits alongside fully-offloaded
   weights ("abundant headroom"). Explicit user `cacheTypeK/V` (incl. `'f16'`) always wins;
   explicit `flashAttention: 'off'`/`false` suppresses auto-quantization (quantized V needs FA).
3. **Full-offload preference**: if shrinking the KV reserve down to the floor-context
   (4096 × bytes/token) fits ALL layers in VRAM, do full offload; context then gets all
   leftover VRAM. Partial offload only when full genuinely doesn't fit.
4. `canRunModel` and orchestrator `estimateLLMUsage` updated to include real KV cost.

## Algorithm (getOptimalConfig)

- `bytesPerToken = layers × kvHeads × headDim × (bytes(K) + bytes(V))`
  - kvHeads: `attention.head_count_kv` (GQA-correct!) → fallback `head_count`
  - headDim: `attention.key_length` → fallback `embedding_length / head_count`
  - per-element bytes from llama.cpp block layouts (f16 2, q8_0 1.0625, q4_0 0.5625, ...)
- Budget: `(vramAvailable ?? vram) − computeBuffer(1 GiB)`; weights at 1.1× on GPU, 1.2× on CPU.
- **Full offload** if `weights×1.1 + 4096×bpt ≤ budget` → `gpuLayers = totalLayers`,
  `ctx = clamp(⌊(budget − weights×1.1)/bpt⌋, 4096, modelCtx)` rounded down to 1024.
- **Partial** otherwise: reserve `max(4096×bpt, 1.5 GiB)` (or `userCtx×bpt` when contextSize
  is user-pinned), pack layers; ctx bounded by BOTH the GPU reserve share and RAM share.
- **CPU-only**: ctx from `available RAM − weights×1.2 − 2 GiB` ; keep f16 KV (no FA-on-CPU
  questions).
- **No GGUF metadata** → exact legacy behavior (4096 + old layer packing, no quant rec).
- User-pinned `gpuLayers`/`contextSize` hints inform the other dimension's math.

## Work

1. [x] `src/utils/kv-cache-math.ts` (new): `KV_CACHE_BYTES_PER_ELEMENT` map,
   `estimateKVBytesPerToken(modelInfo, cacheTypeK?, cacheTypeV?)`; export from index.
2. [x] GGUF metadata: add `attention_head_count_kv` + `attention_key_length` to
   `GGUFMetadata` type and `createGGUFMetadataFromParsed` (via `getArchField`); new
   fallback helpers `getKVHeadCountWithFallback` / `getHeadDimWithFallback` in
   model-metadata-helpers (raw-metadata lookup for already-downloaded models).
3. [x] `SystemInfo.getOptimalConfig(modelInfo, hints?)` rewrite per algorithm; return type
   widens to `Partial<LlamaServerConfig>` (adds cacheTypeK/V, flashAttention when
   auto-quant chosen); `recommendContextSize` stub deleted; sizing constants in defaults.ts.
4. [x] `LlamaServerManager.autoConfigureIfNeeded`: pass user hints; merge cacheTypeK/V +
   flashAttention with `??` (user wins); `fit: 'on'` skips ALL auto-sizing incl. quant.
5. [x] `canRunModel`: include floor-context KV in the RAM requirement when metadata present.
6. [x] `ResourceOrchestrator.estimateLLMUsage`: weights + real KV (configured ctx × bpt with
   configured cache types), split by GPU ratio; zero-KV fallback without metadata.
7. [x] Tests: kv-cache-math unit suite (GQA vs MHA vs quantized); getOptimalConfig scenario
   matrix (abundant→f16, long-ctx→q8_0+fa, partial, CPU-only, no-metadata legacy, hint
   precedence, fa-off suppression); autoconfig merge + flag emission; canRunModel/orchestrator
   updates.
8. [x] Docs: system-detection.md (getOptimalConfig section rewrite), llm-server.md
   auto-config notes, typescript-reference.md signature, `migration-0-6-to-0-7.md`
   (behavior changes + how to opt out: `cacheTypeK/V: 'f16'`, explicit contextSize),
   index/README versions, PROGRESS entry.
9. [x] ISSUE resolved & archived (docs/dev/issues/, Status: RESOLVED); version 0.7.0; PR + tag done.

## Verification

- [x] 0 TS errors, lint clean, 506/506 tests (21 suites).
- [x] Live GPU smoke PASSED (2026-07-03): pure auto-config on Qwen3.5-4B (real GGUF
  metadata: 32 layers, 4 KV heads, key_length 256 — validating the GQA + key_length
  extraction paths) → `-ngl 32` full offload, auto `--cache-type-k/v q8_0` + `-fa on`,
  **context 58368** (vs the old constant 4096), confirmed via /props; an 8130-token
  prompt round-tripped with the secret from the prompt start retrieved (no truncation).
