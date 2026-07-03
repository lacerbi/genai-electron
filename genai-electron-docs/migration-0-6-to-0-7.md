# Migrating from v0.6.x to v0.7.0

v0.7.0 replaces the fixed 4096-token context recommendation with **adaptive, KV-cache-aware auto-configuration**. Auto-configured servers now prefer full GPU offload, size their context window from real KV arithmetic, and select q8_0 KV quantization by default. Explicit configuration is always respected — the changes below apply only to fields you leave unset.

## Compatibility

All API changes are additive and source-compatible. The behavioral changes affect **auto-configured** servers (models with GGUF metadata; models without metadata keep the exact v0.6 behavior):

- **Context size is no longer pinned at 4096.** The recommendation comes from `layers × kvHeads × headDim × bytes-per-element` arithmetic against available VRAM/RAM, clamped only by the model's own `context_length` (no artificial ceiling) and rounded down to 1024. A small model on a large GPU can now get a very large context — with a correspondingly large KV allocation at server startup.
- **q8_0 KV quantization is auto-selected by default** (together with `flashAttention: 'on'`), unless f16 KV at the model's *full native context* fits alongside fully-offloaded weights. The quality impact of q8_0 KV is typically negligible; it roughly doubles the affordable context. **Opt out** with `cacheTypeK: 'f16', cacheTypeV: 'f16'` or `flashAttention: 'off'`.
- **Full GPU offload is preferred.** The old flat 2 GB KV reserve could push a model that *almost* fit into partial offload; the reserve now flexes down to the floor-context (4096-token) cost to win full offload, since partial offload is a large performance cliff.
- **VRAM/RAM usage estimates are KV-aware.** `canRunModel()` includes the floor-context KV cost, and the ResourceOrchestrator's offload decisions account for the configured context's KV — expect slightly more conservative co-running decisions with large contexts.
- `getOptimalConfig()` now returns `Partial<LlamaServerConfig>` (was `Partial<ServerConfig>`) and may include `cacheTypeK`, `cacheTypeV`, and `flashAttention`.

**If you relied on the old defaults**: pass `contextSize: 4096` (and `cacheTypeK/V: 'f16'`) explicitly to reproduce v0.6 behavior exactly.

## What's New

| Feature | Summary |
| --- | --- |
| Adaptive context sizing | Context recommendation from real KV-cache math (GQA-aware via `attention.head_count_kv`) |
| Full-offload preference | KV reserve flexes (floor: 4096 tokens' worth) so full GPU offload wins whenever possible |
| Automatic KV quantization | q8_0 K/V + flash attention chosen by default when it buys context; f16 kept when headroom is abundant |
| Sizing hints | `getOptimalConfig(modelInfo, hints)` — pinned fields shape the recommendations for the rest |
| KV arithmetic export | `estimateKVBytesPerToken(modelInfo, cacheTypeK?, cacheTypeV?)` + `KV_CACHE_BYTES_PER_ELEMENT` |
| KV-aware estimates | `canRunModel()` and ResourceOrchestrator estimates include real KV cost |

## New Types

### OptimalConfigHints

```typescript
type OptimalConfigHints = Partial<
  Pick<
    LlamaServerConfig,
    'contextSize' | 'gpuLayers' | 'parallelRequests' | 'flashAttention' | 'cacheTypeK' | 'cacheTypeV'
  >
>;
```

## Extended Interfaces

### GGUFMetadata

```typescript
interface GGUFMetadata {
  // ... existing fields ...
  attention_head_count_kv?: number; // KV heads (GQA)
  attention_key_length?: number; // per-head key dimension
}
```

Both fields are extracted for newly downloaded models; models downloaded earlier are read from the stored `raw` metadata automatically.

## New Exports

- `estimateKVBytesPerToken(modelInfo, cacheTypeK?, cacheTypeV?)` — per-token KV cost in bytes
- `KV_CACHE_BYTES_PER_ELEMENT` — bytes-per-element map matching llama.cpp's block layouts
- `KV_SIZING` — the sizing constants (floor context, compute buffer, margins)
- `OptimalConfigHints` (type)

## How the sizing works

1. **Cache types**: q8_0 K/V unless f16 KV at the model's full native context fits alongside fully-offloaded weights; explicit user cache types or `flashAttention: 'off'` win; CPU-only stays f16.
2. **Full offload** if `weights × 1.1 + 4096-token KV ≤ (available VRAM − 1 GB compute buffer)` → all layers on GPU, and all leftover VRAM becomes context budget.
3. **Partial offload** otherwise: reserve `max(floor KV, 1.5 GB)`, pack layers, bound context by both the GPU reserve share and available RAM.
4. **CPU-only**: context from `available RAM − weights × 1.2 − 2 GB`.
5. Clamp to `[4096, model context_length]`, round down to 1024.

## See Also

- [System Detection](system-detection.md) — `getOptimalConfig()` reference
- [LLM Server](llm-server.md) — configuration options
- [Migrating 0.5 → 0.6](migration-0-5-to-0-6.md)
