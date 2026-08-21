# Diffusion Path Architecture Review: sd.cpp, FLUX.2 klein, and What to Change

**Date:** 2026-08-21
**Status:** 📋 REVIEW (2026-08-21) — implemented in part; see the Implementation line
**Implementation:** §3, §5.1 (bind), §5.2, §5.3, §5.5, §8.1, §8.2 and §8.6 (the busy-gate and
temp-PNG halves; the `darwin-x64` explicit error and the `sd35LargePattern` expiry note were added
in the follow-up small-fix batch) implemented via `docs/dev/plans/PLAN-sd-server-migration.md`
(branch `feat/sd-server-backend`, unreleased). §5.4, §5.6 (Linux-Vulkan: a provisioning **warning**
only — no CUDA asset exists upstream), §5.7, §8.3–§8.5 and §8.7 are tracked in
`ISSUE-diffusion-followups.md`
**Scope:** Image-generation path (DiffusionServerManager, ResourceOrchestrator, model/binary
strategy). LLM path touched only where the two interact.
**Reference machine:** laptop, 8 GB VRAM NVIDIA GPU, 24 GB RAM — FLUX.2 klein 4B (quantized
GGUF), 768×768, 4 steps, ~10 s/image via stable-diffusion.cpp.

---

## Context and question

The driving question was architectural, not code-level: *is the diffusion path going down a
wrong road?* Specifically, the bet on stable-diffusion.cpp + quantized GGUF + a few-step
distilled 4B model, versus whatever the rest of the ecosystem has converged on by mid-2026.

The review combined a full audit of the diffusion path in this repo with web research on
(a) the local-diffusion runtime ecosystem and (b) the fast/small image-model landscape as of
August 2026. Sources are listed at the end; community benchmark figures are flagged as such.

## Verdict summary

1. **The runtime bet is right, and stronger than when it was made.** stable-diffusion.cpp is
   the only actively developed runtime combining day-1-to-day-3 support for new models, all
   GPU backends (CUDA/Vulkan/Metal/ROCm/SYCL/CPU) in one MIT codebase, best-in-class low-VRAM
   offloading, and prebuilt per-platform binaries. No credible embeddable alternative exists
   for a no-Python, cross-platform Electron library.
2. **~10 s at 768²/4-step on 8 GB is at or better than par.** No >2× gap exists versus the
   realistic alternative (ComfyUI + GGUF) on the same hardware. The only genuine >2× win on
   this hardware class (Nunchaku/SVDQuant) is Python + NVIDIA-only and structurally
   unreachable from an embeddable stack.
3. **The one architectural decision to revisit:** we spawn `sd-cli` fresh per image and pay a
   full model load every generation, behind a hand-rolled HTTP wrapper — while the pinned
   sd.cpp release zip already ships an `sd-server` binary with an async job API that nearly
   duplicates our wrapper's contract. Migrating to a persistent `sd-server` child is the
   single biggest available win (latency, code deletion, feature ceiling).
4. **FLUX.2 klein 4B is the right *default* model but the wrong thing to hard-commit to.**
   The durable bet is the *shape* — 4B-class DiT + ~4B LLM text encoder + GGUF Q4/Q5 +
   4–8 steps at cfg 1 — with the checkpoint as a swappable, metadata-described choice. The
   multi-component design already supports this well (klein 4B and Z-Image Turbo literally
   share the same Qwen3-4B text encoder).

---

## 1. The runtime bet: sd.cpp got stronger, not weaker

Findings from upstream (leejet/stable-diffusion.cpp, checked 2026-08-21):

- **Health:** ~6.8k stars, pushed 2026-08-19, MIT, ~12–15 distinct commit authors in the last
  month (incl. stduhpf, wbruna, LostRuins, danielhanchen) — no longer a solo project.
  Releases are rolling per-commit tags (`master-N-sha`), multiple per day at peak.
- **Model velocity is now a moat.** FLUX.2 klein supported 3 days after BFL's release
  (2026-01-15 → 2026-01-18); MiniMax-H3 day-1 (2026-08-04); Z-Image, Qwen-Image, FLUX.2-dev,
  Ideogram 4, Krea 2, Mage-Flow, ERNIE-Image, HiDream-O1 all in. The old "sd.cpp lags
  ComfyUI by months" reputation is factually obsolete.
- **The DiT era plays to ggml's strengths.** sd.cpp's historical weakness was `ggml_conv_2d`
  (a UNet problem — SD1.5/SDXL; see arXiv:2412.05781). FLUX/Z-Image/Qwen are DiTs: almost
  pure matmul + attention. Practitioner reports have sd.cpp at parity with PyTorch UIs on
  FLUX-class models while notably behind on SD1.5. Residual conv cost sits in VAE decode,
  mitigable via tiling/TAESD.
- **Low-VRAM engineering is best-in-class:** `--diffusion-fa`, `--offload-to-cpu`,
  `--params-backend diffusion=disk,te=cpu,vae=cpu`, `--max-vram <GiB>` (negative =
  auto-detect), `--stream-layers` (streams transformer blocks from CPU; upstream claims
  ~3–4× larger models than raw VRAM). For scale: Ollama's klein 4B requires 13 GB VRAM; we
  run it in 8 GB.
- **The competition validates the choice.** Ollama launched image generation 2026-01-20 on
  Apple MLX and is *still macOS-only* seven months later ("Windows and Linux coming soon…
  a whole separate undertaking"). Every other alternative fails a hard constraint:
  Nunchaku = Python + NVIDIA-only; Draw Things' engine = GPL-3, no Windows; ONNX/DirectML =
  ~3 model generations behind (Microsoft's own extension: "SDXL is not supported at this
  time"); TensorRT = NVIDIA-only + per-GPU engine builds; Rust options (mistral.rs, candle)
  = FLUX.1-only or framework-not-runtime; bundling/provisioning Python (ComfyUI Desktop,
  Invoke both do install-time provisioning via embedded Python/`uv`) = an app-team support
  burden, not a library trade. llama.cpp has **no** image-generation ambitions (its
  `examples/diffusion` is diffusion *language* models).

## 2. Performance reality check

- Community reference point (SEO-tier source, directional only): ComfyUI + ComfyUI-GGUF,
  klein 4B Q4_K_M on an 8 GB card, 1024², 4 steps: ~15–30 s. Normalizing 768² → 1024²
  (1.78× pixels, attention worse than linear), our ~10 s is **at or ahead of par**.
- ComfyUI running the same GGUF does the same dequant work through PyTorch; its edge is
  memory management, not kernels. ComfyUI's own klein-4B low-VRAM path had launch problems
  (Comfy-Org/ComfyUI#11913, VRAM overflow on small GPUs).
- The genuine >2× on consumer NVIDIA is **Nunchaku/SVDQuant** (FLUX-class in ~4 GiB VRAM at
  2–3× speed) — Python wheels pinned to Python×PyTorch×CUDA combos, NVIDIA-only, no C API,
  nothing embeddable as of Aug 2026. Watch for a `libnunchaku`; do not act on it.
- GGUF-vs-FP8/NVFP4 comparisons (NVFP4 ~2× faster than GGUF Q8 on Blackwell) are a trap for
  this use case: on 8 GB, those formats don't fit klein at all and NVFP4 needs Blackwell.
  **GGUF Q4/Q5 is not the fast option on 8 GB; it is the only option.**
- ⚠️ No controlled public sd.cpp-vs-ComfyUI benchmark exists for exactly this config. If a
  decision ever becomes load-bearing, run the A/B locally (same GGUF, same steps/res) — it's
  an afternoon. `calibrate()` infrastructure can record the reference numbers.

## 3. Main recommendation: migrate per-image `sd-cli` spawns to a persistent `sd-server`

**What the code does today** (`src/managers/DiffusionServerManager.ts`): `start()` launches
no native process — it starts a ~250-line `node:http` wrapper; each generation spawns
`sd-cli`, which loads the entire model from disk, writes one PNG to `userData/temp/`, and
exits (`executeImageGeneration()`, spawn → read → delete). Every image pays full model-load
cost — tracked as a first-class `stageMs.loadMs` in calibration reports, and multiple
seconds of the ~10 s on the reference machine.

**What upstream now ships:** the release zip pinned in `src/config/defaults.ts`
(`master-782-b290693`) already contains `sd-server(.exe)`, currently marked "unused" in
`docs/dev/UPDATING-BINARIES.md`. Its API (upstream `examples/server/api.md`):

- Native async: `POST /sdcpp/v1/img_gen` (202) → `GET /sdcpp/v1/jobs/{id}` (status,
  `queue_position`) → `POST /sdcpp/v1/jobs/{id}/cancel`; `GET /sdcpp/v1/capabilities`;
  queue-full = 429, expired = 410.
- OpenAI-compatible: `POST /v1/images/generations`, `/v1/images/edits` (sync).
- A1111-compatible: `txt2img`, `img2img`, plus discovery endpoints (loras, upscalers,
  samplers, sd-models).
- `--listen-ip`/`--listen-port`; embedded web UI.

DESIGN.md explicitly planned for this ("monitor stable-diffusion.cpp for a potential native
server implementation… straightforward to switch backends") — the trigger condition has
fired; it just hasn't been acted on.

**What migration buys:**

1. **Latency:** the full model-load cost disappears from every image after the first.
   Cheapest speed win available — no model, quant, or hardware change.
2. **Deleting our riskiest code.** Progress today is regex over sd.cpp stdout literals
   (`loading model from`, `generating image:`, `decoding 1 latents`, …), which already broke
   once at `master-746`. Job-status polling replaces it. The hand-rolled busy/cancel logic —
   which has a real race (two POSTs landing before `currentGeneration` is assigned can both
   pass the busy gate and both spawn) — is replaced by upstream's queue.
3. **Pattern convergence:** managing a long-lived `sd-server` child is exactly what
   `LlamaServerManager` already does with llama-server (spawn, health-probe, restart to
   switch models). Per-request model switching is lost, but we never had it (model fixed at
   `start()`).
4. **Feature ceiling opens cheaply:** img2img, LoRA, upscaling currently have zero design
   placeholder here; via sd-server they become API passthrough decisions instead of new argv
   plumbing.

**Caveats / design points:**

- `sd-server` has no documented `/health`; probe `/sdcpp/v1/capabilities` instead.
- Verify flags and API behavior **at the pinned build**, not master docs (`--max-vram` /
  `--stream-layers` are documented at master; existence at build 782 unconfirmed).
- **Calibration semantics change.** With a resident model, `loadMs` is paid once, so
  offload-combo rankings must be re-derived on warm-generation time — some combos look bad
  today only because of reload cost.
- **Residency is a policy question, not free.** A resident sd-server holds VRAM permanently;
  the current spawn-per-image design accidentally gives us "diffusion frees VRAM between
  images," which the ResourceOrchestrator dance implicitly relies on. Reasonable middle
  path: keep sd-server warm when no LLM is loaded; stop it entirely (not just offload the
  LLM) when the LLM needs the GPU. This should be an explicit orchestrator mode.
  **Proposed API:** an optional usage-mode flag on the generation API — `'burst'` (keep
  sd-server and its loaded model resident after the image, expecting follow-up
  generations) vs `'single'` (release the server and its VRAM immediately after the
  image). When the caller does not set it, the default is computed at generation time from
  orchestrator state (which it already tracks for its reload logic), not stored config:
  `single` when the orchestrator just offloaded an LLM to make room for this generation
  (hand the VRAM back right away), `burst` otherwise (nothing is waiting on the GPU, so
  stay warm). An explicit caller value always wins — including `burst` in the
  just-offloaded case, for hosts that know the user is iterating on images and the LLM
  won't be needed for a while.

## 4. The model bet: right default, wrong hard-commit

**Why klein 4B is the correct default** (mostly not about image quality):

- **License.** klein 4B *and* its Qwen3-4B text encoder are genuinely Apache 2.0 — the only
  FLUX.2 checkpoint that is. klein **9B is a non-commercial trap** (as are Ideogram 4, Sana,
  PiD). Subtle sub-trap: pull the VAE from the Apache-2.0 klein-4B repo, not the
  non-commercial FLUX.2-dev repo — same file family, different license.
- **First-party GGUFs** from leejet himself (`leejet/FLUX.2-klein-4B-GGUF`; Q4_0 2.46 GB …
  Q8_0 4.3 GB for the DiT) — the tightest possible runtime coupling.
- **4 steps sits exactly on the 2026 distillation sweet spot.** Current results
  (MeanFlow/DMD2 line, arXiv:2512.13006): teacher-level parity at NFE=4, visible breakdown
  at NFE≤2. Ollama picked klein as one of its two launch models — a signal about
  default-tier expectations.
- **Note the real footprint:** klein 4B is effectively an *8B deployment* (4B DiT + 4B Qwen3
  encoder). It works on 8 GB because both halves quantize.

**The honest asterisk:** klein 4B is the fastest of the leading small models, not the
best-looking. Arena and community signals consistently place **Z-Image Turbo (6B, Apache
2.0, 8 steps)** ahead on realism and prompt adherence, at ~3× the per-image compute
(6B×8 vs 4B×4 DiT forwards ⇒ expect ~30 s where klein takes ~10 s). **Mage-Flow 4B
(Microsoft, MIT, July 2026)** is a same-shape, newer, more-permissive competitor claiming a
GenEval lead over klein — top candidate to benchmark as a straight replacement.

**Recommendation: bet on the shape, not the checkpoint.** Supported profile = "4B-class DiT
+ ~4B LLM encoder + GGUF Q4/Q5 + 4–8 steps at cfg 1", with the checkpoint swappable and
metadata-described. Two things make this nearly free here:

- klein 4B and Z-Image Turbo **share the Qwen3-4B text encoder**, and the multi-component
  design already supports shared directories with per-file dedup — offering both costs one
  extra DiT download plus per-model metadata.
- Model metadata should carry the **generation contract** (native steps / cfgScale /
  resolution) per model, because distilled models are not tunable: a 4-step model at 20
  steps produces garbage, and cfg≠1 silently doubles compute (a lesson the calibration API
  already encodes by refusing to default `steps`/`cfgScale`/`sampler`).

**Cheap quality experiments worth running on real hardware:**

- **Q5_K_S vs Q4** on the DiT: a 4B DiT has less redundancy to absorb quant error than a
  12B one; the extra ~0.5 GB likely pays off disproportionately. sd.cpp's `imatrix` support
  can recover Q4 quality further.
- **1024² vs 768²**: 1024 is FLUX.2's native resolution; at 4 steps (especially
  post-sd-server) it may be affordable — potentially free quality.

**Model menu by use case** (all sd.cpp-supported unless noted):

| Prefer | When |
|---|---|
| Z-Image Turbo 6B (Apache 2.0) | Photorealism, prompt adherence, in-image text; ~3× time; shares klein's encoder |
| Mage-Flow-Turbo 4B (MIT) | Same speed class as klein, newer, claimed better GenEval — benchmark it |
| ERNIE-Image-Turbo 8B (Apache 2.0) | Text rendering / posters; tiny Ministral-3B encoder makes the 8B DiT affordable |
| klein Base 4B / Z-Image base | When users need negative prompts / CFG steering (distilled models structurally cannot) |
| SeFi-Image 2B Turbo (MIT) | Below klein's footprint |
| SDXL + Illustrious / Anima 2B | Stylized/anime/LoRA-heavy workflows (ecosystem depth, not 2026 prompt adherence) |
| Sana / Sana-Sprint | **Never** — non-commercial license, no sd.cpp support, team moved on |

## 5. Code-level findings (independent of the big decisions)

Overall the audit was positive: the HTTP seam (genai-lite sees just another provider at the
wire), the calibration methodology (fixed seed, warmup discard, median-of-samples, per-stage
splits, OOM classification, fewer-flags tie-break), report-only/host-applies discipline, and
binary provisioning with real-inference Phase-2 validation are all strong. Items to fix or
track:

1. **Wrapper binds all interfaces, CORS `*`, no auth** — `httpServer.listen(port)` with no
   host (`DiffusionServerManager.ts` `createHTTPServer`), and `DiffusionServerConfig` has no
   `host` field at all (llama-server gets an explicit `--host`). Should bind `127.0.0.1`.
   **Fix regardless of any other decision.**
2. **Busy-check race:** `handleStartGeneration` gates on `this.currentGeneration`, which is
   assigned only deep inside `executeImageGeneration` several awaits later; two concurrent
   POSTs can both pass the gate, both spawn, and corrupt cancellation targeting. (Resolved
   for free by the sd-server migration; otherwise needs a synchronous claim.)
3. **Batch (`count > 1`) bypasses resource orchestration entirely** — the highest-VRAM
   operation is the one that won't offload the LLM. Known since Phase 2, still open.
4. **Two uncoordinated VRAM heuristics:** ResourceOrchestrator's 75%-of-total rule (which
   ignores resolved offload flags) vs `computeDiffusionOptimizations`' 6 GB / 2 GB / 85%
   thresholds (which ignore imminent LLM offload). The diffusion-side estimator
   (`size × 1.2` against both RAM *and* VRAM, hardcoded 6.5 GB fallback) is far cruder than
   the careful LLM-side one. Newer sd.cpp flags (`--max-vram -1`, `--stream-layers`) could
   delegate much of this to the runtime — verify availability at the pinned build first.
5. **Temp PNG leak:** `sd-output-<ts>.png` deleted only on success; failure/cancel paths
   accumulate partials in `userData/temp`.
6. **`darwin-x64` has an empty binary-variant array** → Intel Macs fail with an opaque error
   at first `start()`; Linux NVIDIA users silently get Vulkan (no CUDA asset), and Vulkan
   quality is uneven across GPUs (upstream #1114: Vulkan slower than CPU on an RX 6750 XT).
7. **API leaks to keep in mind for any backend abstraction:** `ImageSampler` union =
   sd.cpp CLI strings; `DiffusionOffloadCombo` + entire `calibrate()` surface = four sd.cpp
   flags; `DiffusionComponentRole` = 1:1 sd.cpp flags persisted in on-disk `ModelInfo`;
   `gpuLayers` accepted-but-ignored (a llama.cpp-ism telling users something untrue);
   `sd35LargePattern` upstream-bug regex shipped in defaults (should carry an expiry check
   against leejet/stable-diffusion.cpp#1578). The wire protocol is swappable; the TypeScript
   API currently is not. The sd-server migration is the natural forcing function to extract
   a `DiffusionEngine`-style seam.

## 6. Risks of the sd.cpp bet (accepted, with mitigations)

| Risk | Severity | Mitigation |
|---|---|---|
| ggml churn → silent perf regressions (upstream #1818: 2× Turing slowdown from a submodule bump, unresolved) | High | Treat every binary bump as a perf-regression risk; use `calibrate()` as a regression gate (record reference time per machine, refuse bump on big delta) |
| Rolling `master-N-sha` tags, no semver/release notes; CLI flags can change under us | Medium | Pin conservatively (currently 782 vs head 827 — fine), bump deliberately with the UPDATING-BINARIES checklist; sd-server migration removes the stdout-parsing exposure |
| Non-CUDA/Metal backend quality uneven (Vulkan) | Medium | Keep variant-fallback validation (already good); consider CPU-vs-Vulkan sanity timing in Phase-2 validation |
| Quantization ceiling: locked out of FP8/NVFP4 as users get 16–32 GB Blackwell cards | Medium | Acceptable at 8 GB (only option anyway); revisit if a `libnunchaku` C API ever appears |
| Maintainer concentration (leejet is the architectural center) | Low-Med | 12–15 recent authors is healthy; monitor |
| Dependence on leejet's CI release assets (URLs + digests) | Low-Med | Already checksum-pinned; asset-naming changes break loudly, not silently |

## 7. Watch list

1. **FLUX 3** — dev open weights "later in 2026"; a FLUX.3 klein is the likeliest event to
   obsolete the current default. (FLUX 3 unveiled 2026-07-23 as multimodal; video GA'd
   2026-08-05.)
2. **Mage-Flow adoption** — if quality claims hold, a straight MIT-licensed swap-in.
3. **Text-encoder inflation** — DiTs stopped growing; encoders didn't (Lens: 3.8B DiT with a
   20B encoder). Budget encoder+DiT+VAE as one number when evaluating "small" models.
4. **`libnunchaku` / any embeddable SVDQuant** — the only credible >2× consumer-NVIDIA win.
5. **sd.cpp News section + `docs/`** — empirically the best early-warning feed for what
   becomes locally runnable (typically days after release).
6. **Ollama image-gen on Windows/Linux** — if they port to ggml rather than MLX, it
   validates and accelerates sd.cpp.

## 8. Recommended actions, ranked

1. **Bind the diffusion wrapper to `127.0.0.1`** (and add a `host` config field). Small,
   security-relevant, unconditional.
2. **Design + execute the `sd-cli` → `sd-server` migration** (persistent child managed like
   llama-server; async job API mapped onto the existing
   `POST/GET/DELETE /v1/images/generations` surface; residency policy coordinated with
   ResourceOrchestrator via the `burst`/`single` usage-mode flag; calibration re-based on
   warm generations). Use it as the forcing function for a backend seam.
3. **Introduce per-model generation contracts** (native steps/cfg/sampler/resolution in
   model metadata) and ship **Z-Image Turbo as a first-class second option** (shared Qwen3-4B
   encoder makes it ~one extra DiT file).
4. **Make `calibrate()` a binary-bump regression gate** (reference timings per machine;
   delta threshold blocks the bump).
5. **Evaluate `--max-vram` / `--stream-layers` / Q5_K_S / 1024²** on real hardware; expose
   the flags if present at the pinned build.
6. Fix the small stuff: busy-gate race (if migration is deferred), temp-PNG cleanup on
   failure paths, `darwin-x64` explicit unsupported error, expiry note on
   `sd35LargePattern`, drop or honor `gpuLayers` on the diffusion config.
7. **Benchmark Mage-Flow 4B vs klein 4B** on the reference machine before considering a
   default change.

---

## Post-implementation notes (2026-08-21)

The migration landed on `feat/sd-server-backend`. What the live smoke on the reference machine
(RTX 4060 Laptop 8 GB, FLUX.2 klein 4B Q4_0, 768², 4 steps, cfg 1, euler) showed against the
**pinned `master-782-b290693`** binary, which is the number set that supersedes the `master-746`
figures quoted earlier in this document:

- **Cold image ≈ 10.3–11.4 s** in steady state; the very first run after provisioning was **16.5 s**
  (cold OS page cache for the model files, not a runtime cost).
- **Warm image 6.3 s** with the backend resident — the ~35–40 % burst saving the plan predicted.
- **Peak 4249 MiB** with `--offload-to-cpu --diffusion-fa`, i.e. roughly half the all-resident peak,
  which is what makes the LLM + diffusion coexistence question interesting on 8 GB at all.
- Cancel (queued and generating), a deliberate `taskkill` of the backend mid-job, the idle timeout,
  and Phase-2 re-validation after deleting `.validation.json` all behaved as designed.

Two findings from that smoke were fixed before release, and both are worth recording because
neither was visible to the unit tests as they stood:

1. **`prepareForLLMStart()` never fired.** The hook is handed the *raw* start configuration, in
   which `gpuLayers` is normally absent — `start()` auto-configures it later. Reading the raw value
   priced the LLM at 0 VRAM, so "both fit" was always true and a resident backend was never yielded.
   The estimate now resolves an omitted `gpuLayers` the way auto-configuration will (an explicit
   `gpuLayers: 0` is still honoured as a CPU-only LLM).
2. **`'burst'` + cancel stranded the LLM.** A cancelled generation kills the backend and then ends;
   with the reload set as originally specified (`idle-timeout | explicit | crashed | stop`) nothing
   would ever have released the VRAM afterwards, so an offloaded LLM stayed down indefinitely.
   `'cancel'` is now a qualifying release reason, and a later non-offload request settling `'single'`
   is a second safety net.

---

## Sources (primary unless noted)

**Upstream runtime**
- https://github.com/leejet/stable-diffusion.cpp — README news/model list; `docs/performance.md`
  (`--diffusion-fa`, `--offload-to-cpu`, `--max-vram`, `--stream-layers`); `docs/flux2.md`;
  `docs/z_image.md`; `docs/imatrix.md`; `examples/server/api.md` (sd-server API families)
- Issues: #754 (perf vs PyTorch, open), #1818 (Turing 2× regression from ggml bump, open),
  #1114 (Vulkan slower than CPU on RX 6750 XT, closed unfixed)
- arXiv:2412.05781 — conv2d as sd.cpp's UNet-era bottleneck; ggml-org/ggml#971 (Winograd,
  closed unmerged)
- cmdr2's notes (Oct 2024): SD1.5 ~1.5× slower than diffusers, "Flux… runs as fast as Forge"

**Models**
- https://github.com/black-forest-labs/flux2 — klein specs/licensing (4B = Apache 2.0 incl.
  Qwen3-4B encoder; 9B/dev = non-commercial)
- https://github.com/Tongyi-MAI/Z-Image (Apache 2.0, verified); https://github.com/microsoft/Mage
  (Mage-Flow, MIT); baidu/ernie-image (Apache 2.0); jmliu206/SeFi-Image (MIT);
  ModelTC/Qwen-Image-Lightning; NVlabs/Sana (non-commercial license — avoid)
- leejet/FLUX.2-klein-4B-GGUF (first-party GGUFs; also unsloth mirrors)
- arXiv:2512.13006 + github.com/alibaba-damo-academy/T2I-Distill — few-step distillation:
  teacher parity at NFE=4, breakdown at NFE≤2

**Ecosystem**
- Ollama image generation (2026-01-20, MLX, macOS-only as of Aug 2026); ships exactly
  klein + Z-Image-Turbo
- nunchaku-ai/nunchaku — SVDQuant; Python + NVIDIA only, no C API (checked Aug 2026)
- Comfy-Org/Comfy-Desktop, invoke-ai/launcher — both provision Python at install time
- saddam213/AmuseAI — the one no-Python multi-vendor app (ONNX/DirectML, .NET; model
  coverage behind sd.cpp)
- Comfy-Org/ComfyUI#11913 — klein 4B VRAM overflow on small GPUs at launch
- Community benchmark tier (directional only): FurkanGozukara wiki GGUF/FP8/NVFP4
  comparisons; localaimaster.com 8 GB ComfyUI klein timings

**This repo (load-bearing references)**
- `src/managers/DiffusionServerManager.ts` — per-image spawn (`executeImageGeneration`),
  wrapper endpoints, stdout progress parsing, busy gate
- `src/config/defaults.ts` — `BINARY_VERSIONS.diffusionCpp.version: 'master-782-b290693'`,
  `DIFFUSION_CALIBRATION_DEFAULTS`, `sd35LargePattern`
- `src/managers/ResourceOrchestrator.ts` — offload heuristics, diffusion estimator
- `docs/dev/UPDATING-BINARIES.md` — sd-server marked unused; `master-746` progress-parsing
  breakage
- `DESIGN.md` — "monitor stable-diffusion.cpp for a potential native server implementation"
