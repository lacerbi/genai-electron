# ISSUE: getOptimalConfig() pins contextSize at 4096 — recommendContextSize is a stub

Created: 2026-07-03
Status: RESOLVED (2026-07-03, v0.7.0) — full adaptive-sizing fix implemented:
GQA-aware KV math from GGUF metadata, full-offload-preferring layer packing,
automatic q8_0 KV selection, and KV-aware canRunModel/orchestrator estimates.
See genai-electron-docs/migration-0-6-to-0-7.md and
docs/dev/plans/PLAN-adaptive-context-sizing.md.
Package: genai-electron (filed from palimpsest-engine 0.6.1 integration work)

## Problem

`SystemInfo.recommendContextSize(_availableRAM, _modelSize)`
(src/system/SystemInfo.ts:331-335) ignores both parameters and returns a
constant 4096 (llama.cpp's default). `getOptimalConfig()` (:240-269) computes
`contextSize = min(modelContextLength, recommendContextSize(...))`, so the
returned context is **always ≤ 4096 regardless of hardware** — on a 24 GB GPU
with a 256K-context model, same as on an 8 GB laptop. The fresh memory info
fetched at :243-244 feeds only this dead parameter.

The API surface implies otherwise: the method is documented as "optimal
server config for a model based on system capabilities", takes RAM/model-size
parameters, and sits next to genuinely adaptive logic (`calculateGPULayers`).
Consumers that trust it (the natural integration path shown in the docs) run
4K-context servers everywhere; LLM apps with long prompts (chat history,
context injection) silently truncate at llama-server with no error.

palimpsest-engine hit exactly this: its GM prompt's history budget alone is
~4000 tokens, so real prompts overflowed the 4096 window. It now bypasses the
recommendation and sets `contextSize` itself (VRAM-tiered 8192/32768, bounded
by `ggufMetadata.context_length`).

## Fix

Implement real sizing, using data the library already has:

1. Estimate KV bytes/token from parsed GGUF metadata (`block_count`,
   `attention_head_count` / KV heads, `embedding_length`; gguf-parser's
   arch-field access already resolves these), honoring `cacheTypeK/V`
   quantization when set.
2. Budget = (VRAM when offloading, else RAM) minus weights and a compute
   buffer margin; contextSize = clamp(budget / bytesPerToken, floor 4096,
   cap `ggufMetadata.context_length`).
3. Round down to a sane granularity (e.g. multiples of 1024).

Minimal alternative if adaptive sizing is out of scope: keep the constant but
document it explicitly in `getOptimalConfig()`'s JSDoc ("contextSize is a
fixed 4096 default — override for long-context workloads"), and drop the
misleading unused parameters.

## Notes

- Severity: medium — silent quality degradation (truncation), not a crash.
- Sliding-window models (Gemma family) have much cheaper effective KV than
  full-attention models; a first pass can ignore this (conservative) and
  refine later.
- Related: `recommendParallelRequests` (:350-355) already went through the
  same "constant is better than wrong heuristic" reasoning — if the same
  conclusion is reached here, the fix is the documentation variant.
