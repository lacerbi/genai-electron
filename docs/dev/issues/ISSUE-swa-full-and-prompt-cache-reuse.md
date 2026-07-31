# ISSUE: No way to enable llama.cpp's full-size SWA cache; prompt-cache reuse collapses for short requests

Created: 2026-07-30
Status: RESOLVED
Resolved: 2026-07-30
Target release: v0.17.0
Package: genai-electron (v0.16.0 at filing)

## Resolution

The capability gap is resolved for v0.17.0 with the deliberately narrow, opt-in
surface requested in item 1:

- `LlamaServerConfig.swaFull?: boolean` is part of the public type and strict config
  allowlist.
- `LlamaServerManager.start()` now accepts `LlamaServerConfig`, so direct object
  literals can use the full llama-specific surface without a TypeScript excess-property
  error.
- `swaFull: true` emits exactly one `--swa-full`; `false` and unset emit nothing and
  preserve the previous argv.
- Unit coverage locks the tri-state argv behavior and config-key completeness.
- The LLM server, type reference, and system-sizing documentation describe the
  cache-reuse/memory tradeoff.

The sizing investigation found that metadata-backed auto-sizing already charges the
full-context KV footprint for every transformer layer. It therefore conservatively
covers full-size SWA cache today rather than depending on the smaller runtime SWA
window. A Gemma 4 mixed full-attention/SWA regression now locks that calculation.
Exact window-aware sizing could recover capacity when `swaFull` is disabled, but is
not required to expose the opt-in flag safely. Models without usable GGUF metadata
remain on the documented conservative fallback; consumers should refresh metadata or
pin placement for tightly constrained systems.

Automatic enablement remains deferred: the latency/VRAM tradeoff is workload- and
machine-dependent. `checkpointMinStep` and a raw `extraArgs` escape hatch were also
left out of this release because neither is necessary for the confirmed fix and a raw
passthrough would weaken the curated, validated config boundary.

Acceptance tracking:

- [x] `swaFull: true` emits `--swa-full`.
- [x] `swaFull: false` and an unset field leave argv unchanged.
- [x] Metadata-backed Gemma 4 sizing includes full-context KV cost across its mixed
  layer pattern.
- [x] Public docs explain adoption, sizing, and rollback.
- [ ] Re-run the downstream live-server assertion that a repeated short prompt reports
  `timings.prompt_n === 1` after adopting v0.17.0. The original measurements establish
  the llama.cpp behavior; this repository's deterministic coverage verifies its
  command-line integration.

`LlamaServerConfig` exposes no way to pass llama.cpp's `--swa-full`. On
sliding-window-attention models — the whole Gemma family — that makes prompt-cache
reuse collapse for any request below roughly 1024 tokens: the server reuses only the
shared system prefix and re-prefills everything after it, on every call, forever.

Consumers that send many small, highly-similar requests (evaluation/judge/classifier
calls against a large shared context) pay a full prefill per call where a warm cache
would cost tens of milliseconds. Measured downstream at **3.6× on that workload**.

This is a pure capability gap: the llama.cpp flag exists and works, and genai-electron
already surfaces neighbouring cache flags (`cacheTypeK/V`, `cacheRam`). There is no
`swaFull`, no checkpoint-spacing control, and no raw-argument escape hatch, so a
consumer cannot work around it.

## Evidence

Measured against genai-electron's own provisioned stack: llama.cpp **b9860** (CUDA),
`gemma-4-12b-it-IQ4_XS.gguf`, 8 GB VRAM, flags as spawned by
`buildCommandLineArgs` (`--jinja -c 12288 -ngl 34 -np 1 -fa on -fit off
--cache-type-k q8_0 --cache-type-v q8_0`).

**Reuse depends on prompt length, not content.** Identical prompt sent twice, content
shape held fixed, varying only length (tokens reused on the second call):

| prompt tokens | 94 | 130 | 310 | 550 | 790 | 910 | **1030** | 1270 | 1510 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| stock | 50 | 50 | 50 | 50 | 50 | 50 | **1029** | 1269 | 1509 |
| `--swa-full` | 93 | 129 | 309 | 549 | 789 | 909 | 1029 | 1269 | 1509 |

Below the threshold, reuse is pinned to a constant 50 tokens — exactly the shared
system message, nothing after it. The server log names the mechanism:

```text
slot create_check: id 0 | task 813 | erasing old context checkpoint
                   (pos_min = 0, pos_max = 50, n_tokens = 51, size = 8.468 MiB)
```

Checkpoints are spaced by `--checkpoint-min-step` (default 8192 tokens), so for a
few-hundred-token request exactly one checkpoint ever exists, at the system/user
boundary, and reuse falls back to it.

**Effect on a real request.** A 569-token evaluation prompt, replayed byte-identical:

| | reprocessed / total | wall |
|---|---|---:|
| stock | 519 / 569 | 898 ms |
| `--swa-full` | 1 / 569 | **91 ms** |

**End to end** (one turn of a text-RPG host issuing four short evaluation calls):

| config | eval calls total | mean per call | VRAM |
|---|---:|---:|---:|
| stock | 4423 ms | 1106 ms | 4889 MiB |
| `--swa-full` | 1743 ms | 436 ms | 6211 MiB |

Not a workaround: `--checkpoint-min-step 0` is free in VRAM and fixes an
identical-repeat microbenchmark, but delivers nothing on real traffic (4824 ms), since
consecutive real requests are never byte-identical and checkpoints only help at
checkpoint boundaries. Only `--swa-full`, which permits reuse from an arbitrary
position, helps.

## 1. Expose `swaFull` on `LlamaServerConfig` (capability gap; small; high priority)

**Request:** add `swaFull?: boolean` to `LlamaServerConfig`
(`src/types/servers.ts:43-62`, alongside `cacheTypeK` / `cacheTypeV` / `cacheRam`) and
emit it from `buildCommandLineArgs` (`src/managers/LlamaServerManager.ts`, in the
existing KV-cache block):

```ts
if (config.swaFull === true) {
  args.push('--swa-full');
}
```

Follow the established tri-state convention: omit the flag when unset and let the
server default apply.

**Acceptance:** a config with `swaFull: true` spawns a server whose byte-identical
short-prompt repeat reports `timings.prompt_n === 1`; with the field unset, the emitted
argv is unchanged from today.

## 2. Account for `--swa-full` in KV sizing before defaulting it on (correctness; important)

Defaulting this on is tempting — it is right for every SWA model with VRAM to spare —
but it **must not** ship ahead of the sizing math, because it is not free. Measured on
the stack above, `--swa-full` cost **+1322 MiB** (4889 → 6211 MiB) at `-c 12288`: the
SWA layers move from a windowed cache to a full-context one, so the delta scales with
context size.

`SystemInfo.getOptimalConfig` is explicitly KV-cache-aware (`KV_SIZING` in
`src/config/defaults.ts:45`, e.g. `minPartialReserveBytes: 1.5 GB`,
`computeBufferBytes: 1 GB`) and its `contextSize` / `gpuLayers` results are consumed at
`src/managers/LlamaServerManager.ts:722-723`. If `--swa-full` is enabled without
teaching that model about the larger KV footprint, auto-offload will over-commit.

That failure mode is **worse than the bug being fixed**, because it is silent. On
Windows/WDDM the driver oversubscribes VRAM into system memory rather than failing, so
the server still starts and still answers — just far slower. Measured, sweeping
`-ngl` with `--swa-full` at `-c 12288`:

| `-ngl` | 34 | 38 | **42** | 46 |
|---|---:|---:|---:|---:|
| VRAM (MiB) | 6163 | 6791 | **7451** | 7837 |
| cold prefill (tok/s) | 699 | 836 | **1001** | 262 |

Full offload (`-ngl 99`, 7883 MiB) was **worse than the stock baseline** end to end.
There is no error and no log line marking the cliff — only a ~4× throughput loss.

**Request:** land item 1 as opt-in first. Then, separately, extend the KV sizing model
to include the SWA-full footprint (it needs the model's SWA window and layer pattern,
both available from GGUF metadata) and only then consider defaulting `swaFull: true`
for SWA models when the sizing says it fits.

**Acceptance:** with `swaFull: true` and auto-configured `gpuLayers`, the chosen
offload leaves headroom rather than landing past the thrash cliff; a config that does
not fit reduces `gpuLayers` (or context) instead of silently oversubscribing.

## 3. Optional: `checkpointMinStep`, and a general escape hatch (nice to have; low priority)

`--checkpoint-min-step` is not independently useful here (see above), but exposing it
alongside `swaFull` would round out the cache-tuning surface at near-zero cost.

More valuable is the general point: this issue exists only because there is no way for
a consumer to pass a flag genai-electron does not model. A vetted passthrough — even an
allowlisted `extraArgs?: string[]` — would let consumers unblock themselves on the next
llama.cpp flag without a release round-trip. Reasonable to decline if the curated
surface is deliberate; noting it because the cost of the gap here was a full downstream
investigation.

## Notes

- Consumer-side investigation and full measurement record:
  `palimpsest-engine/ISSUE-soft-eval-prompt-cache-reuse.md`.
- The threshold behaviour has a loose end: why reuse is fine *above* ~1024 tokens but
  pinned below it was not pinned down — it is a llama.cpp internal, and `--swa-full`
  removes the length dependence entirely, so it did not block the fix. Flagged in case
  it matters to the sizing work in item 2.
- Cross-checked against an unrelated project (gmbench) that runs Gemma 3 12B locally
  and never hit this: its prompts are 2316–2457 tokens, comfortably above the
  threshold. Only short-request workloads are affected, which is likely why this has
  not surfaced before.
