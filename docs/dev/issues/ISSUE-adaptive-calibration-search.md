# ISSUE — Adaptive boundary search for LLM runtime calibration

**Filed from:** palimpsest-engine (consumer), 2026-08-01, after adopting v0.18.0's
`llamaServer.calibrate()` and prototyping the search downstream (validated; trace below).

## Problem: the generated ladder's anchors miss the region that matters

`generateDefaultLlamaCalibrationCombos` derives its four `gpuLayers` anchors from the
autoconfig baseline (baseline ± step, full-GPU). The baseline is deliberately conservative, so
the anchors cluster low and the interesting region — just under the VRAM cliff, where the
optimum lives — goes unsampled. Observed on the reference 8 GB card (Gemma 4 12B IQ4_XS,
12,288 ctx × 1 slot): baseline resolved to `-ngl 19`–38 (context-hint dependent), anchors at
14/19/24/48 (or 38-relative), and **nothing between 24 and 48** — while the true per-cell
boundaries sit at 45 (`swaFull`) and 48 (window). The ladder's recommendation
(`full-gpu-swa-window`, score 3,742 ms on our workloads) was beaten by a config it never
tested (`ngl45-swa-full`, 3,318 ms).

## Request: a native adaptive search mode

The structure of the problem makes this cheap and robust, and we validated the algorithm
downstream by driving repeated single-candidate `calibrate({combos: [...]})` calls:

1. **Below the VRAM cliff, more GPU layers is strictly faster** (prefill and decode), so per
   cell the optimum is the **max feasible `gpuLayers`** — a boundary, found by bisection on a
   monotone feasibility predicate. No general optimization needed.
2. **Binary axes (`swaFull`, and any other VRAM-affecting toggle) define cells that shift the
   boundary**, monotonically: `swaFull` only adds KV bytes, so its boundary cannot exceed the
   window cell's — each found boundary upper-bounds the next cell's search.
3. **Everything must be cell-local.** This is the non-obvious requirement; our first prototype
   violated it and misclassified the eventual winner:
   - *Cell-local reference*: each cell probes its own low anchor (walking down from
     min(baseline, cellCeiling) on failure). The autoconfig baseline is sized for window-cache
     KV and proves nothing about the `swaFull` cell.
   - *Cell-local thrash predicate*: infeasible = non-`ok` status OR narration median >
     1.5× the **cell's** best so far. A cross-cell predicate is wrong by construction:
     `swaFull` trades narration speed for burst cache reuse, so a healthy `swaFull` config
     runs narration at ~2× the window cell's best without being anywhere near the cliff. Our
     first prototype used a global predicate and it classified the eventual overall winner as
     infeasible.
   - *Cell-local early cancel*: `requestTimeoutMs` = 2× the cell's best narration. A
     thrashing candidate then cancels in under a minute instead of grinding to the 120 s
     default (the conclusion is already proven). Saved ~3 min per infeasible probe.
4. **Probes run `samples: 1`** (bisection needs ordering, not precision; ±20% single-sample
   jitter is fine against 1.5×/2× thresholds). **Finalists** — each cell's boundary config —
   re-measure at full samples, then the existing selection rule and
   `kvPrecisionPreferencePct` counter-probe apply (KV as counter-probe only, not a searched
   axis: an f16 counter-probe at the winner preserves the precision-preference rule at one
   candidate's cost).

## Evidence (reference machine, 12,288 ctx × 1 slot, production-mirrored workloads)

Search trail — 10 server starts, 18.0 min total:

```
38-window   ok  narration 46.9s            (cell reference)
48-window   ok  narration 18.5s            -> window boundary = 48, one probe
38-swa-full ok  narration 46.5s            (cell reference — global predicate would reject this)
48-swa-full ok  narration 88.9s            -> cliff confirmed from within the cell
43-swa-full ok  narration 33.0s            feasible
45-swa-full ok  narration 28.0s  score 3309
46-swa-full ok  narration 42.9s            cliff edge (1.53x cell floor) -> boundary = 45
finals:  48-window 5193 (unstable: 18.5s <-> 29.1s across runs — near-cliff variance)
         45-swa-full 3318 (reproducible: 3309/3318)
kv f16 @ 45-swa-full: request-timeout      -> q8_0 confirmed
WINNER: ngl45-swa-full q8 fa-on, score 3318
```

The generated ladder on the same machine/workloads: 9 candidates, 51.6 min, winner
`48-window` at 3,742 ms — ~3× the wall time for a 13% worse pick, which is additionally the
variance-unstable configuration.

## Additional findings worth folding into a native implementation

- **Near-cliff configs are variance-unstable** (`48-window`: narration 18.5 s in probes,
  29.1 s at finals, with a stable control config in between — ambient VRAM pressure, not
  thermal). A native search could add a stability criterion at boundary configs (e.g. spread
  across samples, or prefer the config whose repeat agrees within N%) rather than scoring on
  the median alone.
- Single-sample cell references are noisy (±20% observed on the same config across runs);
  harmless against wide thresholds but worth documenting.
- The consumer-side loop pays a full cold server start per probe (~30–60 s of the ~1–2 min
  probe cost). A native mode could amortize provisioning/occupancy checks across probes, and
  potentially reuse the loaded model when only KV/runtime flags change between candidates.

## API sketch (names flexible)

`calibrate({ search: { axes: ['gpuLayers', 'swaFull'], kvCounterProbe: true }, ... })` or a
sibling `calibrateSearch()`, returning the existing report shape extended with the probe
trail and per-cell boundaries. Everything else (workloads, profile lock, report identity,
recommendation rule) carries over unchanged.
