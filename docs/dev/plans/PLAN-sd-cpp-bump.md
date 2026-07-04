# Plan: stable-diffusion.cpp bump — `master-504-636d3cb` → `master-746-2574f59` (v0.10.0)

Created: 2026-07-03
Status: COMPLETE — all phases done. PR #36 (batch) + PR #37 (release) merged, tag `v0.10.0` + GitHub release published 2026-07-04. Remaining outside this plan: `npm publish` (maintainer-side, guarded by `prepublishOnly`). (Tracking: `[ ]` todo, `[~]` in progress, `[x]` done, `[!]` blocked)

## Summary

Bump the pinned stable-diffusion.cpp binaries by 242 releases (2026-02-10 → 2026-07-02). Upstream research confirms the CLI surface we use is fully backward-compatible (every flag intact, including underscore forms; sampling progress line format unchanged; binary still `sd-cli`), so the bump is mostly a config refresh — plus one mandatory asset rename (Windows CPU), a new Linux Vulkan variant, a live re-test of the CUDA CPU-offload crash workaround (retire the guard if fixed), and two small riders (progress-parser hardening, sampler enum extension). Ends in a v0.10.0 release that also folds in the already-merged genai-lite 0.11 pairing work (`36952da`).

## Scope

- **In scope**:
  - `src/config/defaults.ts`: new pin, URLs, checksums; `win-avx2` → `win-cpu` asset rename; add Linux Vulkan variant; comment cleanup
  - CUDA offload guard: live re-test on this box; retire if fixed (code + JSDoc + tests + docs), else refresh references to the new tag
  - Progress parsing: require `it/s`/`s/it` unit on the sampling-step regex; add loading-stage parsing for the new `#`-style byte-progress bar if observed
  - Sampler enum: add `er_sde`, `euler_cfg_pp`, `euler_a_cfg_pp` (types + docs + example-app select)
  - `docs/dev/UPDATING-BINARIES.md`: generalize for sd.cpp; fix stale 30 s test-timeout claim
  - Live smoke on the Windows/NVIDIA dev box: CUDA provisioning + generation, Flux 2 Klein multi-component, forced Vulkan and forced CPU variants, offload-flag matrix
  - PROGRESS.md Unreleased entry; release PR → tag `v0.10.0` → GitHub release (npm publish by user), folding in `36952da` (genai-lite 0.11 pairing notes; example pins genai-lite ^0.11.0)
- **Out of scope**:
  - darwin-x64 via the universal2 macOS zip (deferred — can't run-test; revisit on request)
  - Checksum-based skip of byte-identical dependency re-downloads (cudart is 563 MB and unchanged; filed as follow-up)
  - ROCm variants (existing follow-up; blocked on Windows AMD GPU detection, DESIGN Phase 4)
  - New upstream features (`--max-vram`, hi-res-fix suite, `--prompt-file`, `metadata` mode, `sd-server`) — future candidates only

## Reference: upstream facts (verified 2026-07-03 via GitHub API + source diff)

- Latest release: `master-746-2574f59` (commit `2574f5936571645f784b77623e1f09bad97d948a`, published 2026-07-02). Exactly 242 releases past our pin; release bodies are empty (auto-generated per commit).
- All flags we pass exist unchanged: `-m`, `--diffusion-model`, `--clip_l`, `--clip_g`, `--t5xxl`, `--llm`, `--llm_vision`, `--vae`, `-p`, `-n`, `-W`, `-H`, `--steps`, `--cfg-scale`, `-s`, `--sampling-method`, `-t`, `-b`, `-o`, `--clip-on-cpu`, `--vae-on-cpu`, `--offload-to-cpu`, `--diffusion-fa`. Only removal in the whole range: `--cache-preset` (unused by us). Sampler list is a superset (adds `er_sde`, `euler_cfg_pp`, `euler_a_cfg_pp`).
- Sampling progress line unchanged: `\r  |======>          | 3/20 - 1.23s/it\033[K` (pipe bar, `N/M`, ` - `, `it/s`/`s/it`). New: `pretty_bytes_progress()` prints a `#`-style bar with `N/M` and `MB/s`/`GB/s` for byte/loading progress.
- Binary is `sd-cli(.exe)` (true at our current pin too); zips also contain `sd-server` and, in the new win-cpu build, runtime-dispatch `ggml-cpu-*` backend DLLs (`GGML_BACKEND_DL=ON`, `GGML_CPU_ALL_VARIANTS=ON`).
- Windows CPU zips consolidated 4 → 1: `sd-master-2574f59-bin-win-cpu-x64.zip` replaces the avx/avx2/avx512/noavx set.
- `cudart-sd-bin-win-cu12-x64.zip` is byte-identical to the old one (same sha256) — only the URL tag changes.
- Asset digests (sha256, from the releases API `digest` field — re-verify in Phase 0):

| Asset | sha256 |
|---|---|
| `sd-master-2574f59-bin-Darwin-macOS-15.7.7-arm64.zip` | `570213614f4021ee99f832169da5c0abb73b53d48c8be2252eda30e4df3c4a1d` |
| `sd-master-2574f59-bin-win-cuda12-x64.zip` | `baa07994a81dcdf1b3895c9dd290aa87683a65120d196501e3d015daca71d2d5` |
| `cudart-sd-bin-win-cu12-x64.zip` | `fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d` (unchanged) |
| `sd-master-2574f59-bin-win-vulkan-x64.zip` | `b6c9551a4e47cb7ce0b7ff41d382c12ec7f62f930a7d47fdc484851f19153248` |
| `sd-master-2574f59-bin-win-cpu-x64.zip` | `add4a495403e6170bb8ed6e68a5c6c59568f7d2ad28e773a9264a2a0537fc722` |
| `sd-master-2574f59-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip` | `79ea8096d1fdf35bdc9cf92f8008713cd5a0b2f0c23fa067e1c8144f89f902e2` |
| `sd-master-2574f59-bin-Linux-Ubuntu-24.04-x86_64.zip` | `80c6597f2ec18e7d2473bd3169db8b72500e50244110548d904216549993483c` |

- Relevant open upstream issues: #1578 (`--clip-on-cpu` broken for SD3.5-Large, all backends), #1665 (Vulkan img2img white image — we only do img_gen/txt2img), #1647 (Vulkan perf regression). CUDA path has no open correctness regression.

## Phases

### Phase 0: Preflight
**Goal**: Confirm upstream state before editing anything.

**Steps**:
1. [x] (2026-07-03: `master-746-2574f59` still latest) Re-query `https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest`. If a newer tag than `master-746-2574f59` exists, stay on `master-746-2574f59` — user-confirmed 2026-07-03 (upstream cuts a release per commit; don't chase the head — all digests and surface diffs were verified against this tag).
2. [x] (all 7 match) Re-pull the `digest` fields for the 7 assets above from `releases/tags/master-746-2574f59` and diff against the table (guards against a re-cut release).
3. [x] Create batch branch `feat/sd-cpp-bump` off current `main` (includes `36952da` AND `fcddb22`, a second concurrent docs commit — both fold into the Phase 5 PROGRESS entry).

**Verification**:
- [x] Digests match the table (or table corrected from live API)

### Phase 1: Config bump (`src/config/defaults.ts`)
**Goal**: New pin compiles and passes the existing suite.

**Work** (diffusionCpp block, lines ~174-227):
- `version: 'master-504-636d3cb'` → `'master-746-2574f59'`
- All URLs: tag path → `master-746-2574f59`, basename hash → `2574f59`; darwin-arm64 stamp `15.7.3` → `15.7.7`
- Checksums per the table; cudart URL tag changes, checksum stays
- Windows CPU: basename `win-avx2-x64` → `win-cpu-x64`; replace the "AVX2 variant (most compatible CPU version)" comment with "runtime CPU dispatch — single zip ships all ISA variants as loadable ggml backends"; delete the obsolete AVX512/AVX/No-AVX/ROCm checksum comment block (lines 213-217)
- Linux: add `vulkan` variant (new `-vulkan.zip` asset) **before** the existing `cpu` variant, mirroring the llama.cpp Linux chain; fix the stale "Works with both CPU and CUDA (auto-detects)" comment on the CPU entry

**Steps**:
1. [x] Edit defaults.ts as above
2. [x] `npm run build`, `npm run lint`, `npm test` (unit tests mock URLs/checksums — expect green with no test edits)

**Verification**:
- [x] 0 TypeScript errors, lint 0 errors (45 pre-existing warnings), 539/539 tests pass
- [x] `grep -r "636d3cb\|master-504" src/` returns only the DiffusionServerManager comment (handled in Phase 4)

### Phase 2: Code riders (pre-smoke)
**Goal**: Hardening + trivial additions that ship with the bump. Loading-stage parser work is deliberately NOT here — it depends on stdout observed in Phase 3 and lands in Phase 4.

**Work**:
- [x] **Sampling-step regex hardening** (`DiffusionServerManager.ts:1342`): `/\|\s*(\d+)\/(\d+)\s*-/` → require an it-rate unit: `/\|\s*(\d+)\/(\d+)\s*-\s*[\d.]+\s*(?:it\/s|s\/it)/`. This is defensive-only: the known upstream byte bar is `#`-style (no `|`) and already fails the current regex; the unit requirement guards against pipe-decorated byte bars and future format drift. Verified: all existing fixtures and the upstream `|======>          | 3/20 - 1.23s/it` format still match. Accepted tradeoff: requiring the trailing unit slightly widens the window where a mid-line stdout chunk split drops one update — harmless, since progress lines are single `\r` writes and the next step's line self-heals.
- [x] **Sampler enum** (`src/types/images.ts:11-19`): add `'er_sde' | 'euler_cfg_pp' | 'euler_a_cfg_pp'`; extend the sampler `<select>` in `examples/electron-control-panel/renderer/components/DiffusionServerControl.tsx` (options at ~559-574); update sampler lists in `genai-electron-docs/image-generation.md` (~101, 173, 309) and `genai-electron-docs/typescript-reference.md` (~508-518).
- [x] **Tests** (`tests/unit/DiffusionServerManager.test.ts`): existing pipe-bar fixtures (`| 5/30 - 2.50it/s`) still match the hardened regex; add a negative fixture that actually exercises the new guard — a **pipe-decorated** byte-style line (`|#####     | 3/10 - 12.3MB/s`) during the diffusion stage must not update step progress. (A pipe-less `#` line passes under both regexes and proves nothing.)

**Verification**:
- [x] Build/lint/tests green (540/540 — new byte-bar guard test added)
- [x] Negative fixture fails against the OLD regex and passes against the hardened one (demonstrated: byte-bar old=match/new=no-match, step-bar both match)

### Phase 3: Live smoke (Windows/NVIDIA dev box, driven autonomously)
**Goal**: Prove all three Windows variants + both model shapes on the new pin; produce the CUDA-guard verdict. One generation at a time (single heavy-compute rule).

**Execution mode** (agreed 2026-07-03): Claude drives this unattended — the user is away (checking in via the phone interface) and cannot intervene. Host the library in a minimal headless Electron smoke script (scratchpad; calls `diffusionServer.start()` directly and reuses the example app's `userData` via `app.setPath('userData', …)` so its model store and binary cache are shared), or the example app itself if simpler. Drive generations against the diffusion HTTP wrapper (`POST http://127.0.0.1:8081/v1/images/generations`, poll `GET …/generations/:id`) with curl/scripts; verify outcomes from server logs, HTTP responses, and the output PNGs on disk — no renderer/UI interaction. If a step genuinely can't be verified without the UI, record it as a leftover for the user rather than blocking.

**Prerequisites**: a single-file SD model (SD 1.5/SDXL) and the Flux 2 Klein multi-component model are expected in the example app's model store from earlier diffusion work (user-confirmed 2026-07-03); if one is missing, download it via ModelManager first. Capture raw sd-cli stdout via the server log / `GENAI_ELECTRON_DEBUG` for the parser follow-through in Phase 4.

**Steps**:
1. [x] (CUDA provisioned clean: Phase 1 --help + Phase 2 real-inference passed; SDXL 512²/20-step in 11.1s, valid PNG. FINDING: new build renamed the loading literal to `loading model from` + loading now uses `#` byte bars `|####| N/M - GB/s` — loading-stage fix implemented immediately, evidence-driven, live-verified; first step prints `s/it` confirming dual-unit regex was right) **CUDA provisioning + generation**: delete `userData/binaries/diffusion/` (incl. `.variant.json`/`.validation.json`); start diffusion server on the single-file model; confirm CUDA variant downloads (~925 MB incl. cudart), passes `--help` + the 64×64/1-step real test, and is cached. Generate 512²/20-step/`euler_a`; confirm all three progress stages advance sanely (watch for a loading-progress stall → feeds the Phase 4 loading-branch decision).
2. [x] (flux-2-klein-q40: `--diffusion-model/--llm/--vae --diffusion-fa` verified in spawn cmd, 5.95 GB VRAM, 512²/4-step in 8.0s, valid PNG) **Multi-component**: start on Flux 2 Klein; generate. Exercises `--diffusion-model/--clip_l/.../--llm`, auto `--diffusion-fa`, and the 120 s multi-component test timeout.
3. [x] **VERDICT: crash FIXED — guard retirement GO.** Flux-2-Klein/CUDA, all valid PNGs, flags verified in spawn cmds: clipOnCpu ✓ 14.8s; vaeOnCpu ✓ 22.1s; offloadToCpu ✓ 7.9s (output byte-identical to baseline, same seed); all three ✓ 30.9s; er_sde sampler on SDXL ✓ 5.9s. **CUDA offload matrix (guard decision gate)**: with the CUDA variant installed, force each of `clipOnCpu: true`, `vaeOnCpu: true`, `offloadToCpu: true` (one at a time, then all three) and generate. Record per-flag: success or crash (historical signature: silent exit `0xC0000005`). Also try one new sampler (e.g. `er_sde`) in a run.
4. [x] (Vulkan provisioned clean, both phases passed; SDXL 512²/20-step in 34.1s, valid PNG — slower than CUDA's 11.1s, consistent with upstream Vulkan perf issue #1647; correctness fine) **Forced Vulkan**: temporarily comment out the CUDA entry in defaults.ts (local only, never committed), rebuild, delete `userData/binaries/diffusion/`, re-provision → Vulkan variant; generate 512²/20-step. NVIDIA runs Vulkan fine; this validates our chain's middle tier despite upstream's open Vulkan issues (which are img2img/perf, not img_gen correctness).
5. [x] (win-cpu provisioned; all 9 `ggml-cpu-*.dll` dispatch backends survived extract/copy alongside `sd-cli.exe`, no vulkan/cuda DLLs; SDXL 256²/4-step in 57s, valid PNG) **Forced CPU**: same trick leaving only the CPU entry; verify the runtime-dispatch zip survives extract/copy (binaries dir must contain `sd-cli.exe` + `ggml-cpu-*.dll` backends) and a small generation works (256²/4-step is enough — CPU is slow). This is the most structurally changed asset.
6. [x] (defaults restored via git checkout; CUDA re-provisioned clean on the guard-retired build; live proof: Flux auto-config on CUDA now logs `auto: clip=true` and generates a valid PNG byte-identical to the explicit-flag run — box ends on CUDA) Restore defaults.ts (git checkout), rebuild, delete `userData/binaries/diffusion/` once more so the box ends on the CUDA variant.

**Verification**:
- [x] All three variants provision, pass the real-inference test, and generate a valid PNG
- [x] Multi-component generation works; component flags visible in server log
- [x] Offload matrix results recorded (verbatim outcomes per flag) for Phase 4
- [x] Observed stdout: `generating image:`/`sampling using`/`decoding 1 latents`/`decode_first_stage completed` unchanged; **`loading tensors from` RENAMED to `loading model from`** and loading now uses `#` byte bars — parser fixed accordingly (see Phase 4)

### Phase 4: CUDA-guard decision + documentation
**Goal**: Apply the smoke verdict; make docs truthful for the new pin.

**Work — if the offload flags are clean on CUDA (expected path)** — TAKEN, all items done:
- Remove the `isCuda` gating in `computeDiffusionOptimizations()` (`DiffusionServerManager.ts:1055-1073`); delete `isInstalledVariantCuda()` (single caller — becomes unused)
- Update JSDoc on `clipOnCpu`/`vaeOnCpu`/`offloadToCpu` in `src/types/images.ts` (drop "Disabled for CUDA backend" text at ~141, 153-154, 172)
- Tests: the existing VRAM auto-detection suite (`DiffusionServerManager.test.ts` ~1455-1640) never exercises the guard — it doesn't mock `.variant.json`, so `isInstalledVariantCuda()` returns `false` throughout, and it already asserts NVIDIA GPUs get the auto flags. It stays green untouched. The suppression path has **zero coverage today**, so **add** a new test that mocks `.variant.json` = `{"variant":"cuda"}` and asserts CUDA now receives the same auto flags — the behavior change must not ship untested
- `genai-electron-docs/troubleshooting.md`: rewrite "CUDA + CPU Offloading Crash" (§~46-50) as a historical note (fixed as of `master-746-2574f59`); add the #1578 caveat (SD3.5-Large + `--clip-on-cpu`, any backend); update the `master-504-636d3cb` mention at ~line 200
- `genai-electron-docs/image-generation.md`: replace the "CUDA Backend Warning" (~line 53) with the #1578 caveat; note this is a behavior change (CUDA setups may now auto-enable offload flags under low VRAM — override with explicit `false` to restore old behavior); drop the stale "regardless of ... user config" wording (explicit config always won)

**Work — if any flag still crashes**: keep the guard (narrow it to the still-crashing flags if the matrix is mixed), update the comment tag reference to `master-746-2574f59` in `DiffusionServerManager.ts` + both docs, and record the retest in PROGRESS. Add the missing suppression-coverage test (mock `.variant.json` = `{"variant":"cuda"}`, assert the auto flags are suppressed) — the coverage gap gets closed either way.

**Work — either way**:
- [x] (done EARLY during Phase 3, evidence-driven: added `loading model from` stage literal + a byte-bar parser branch `| N/M - MB/s|GB/s` routed to loading only; live-verified + 3 unit tests) **Progress-parser follow-through** (from Phase 3 observations): if tensor loading now prints the `#`-style byte bar, add a parser branch in `processStdoutForProgress()` matching it (unit `MB/s|GB/s`) and routing to `loadProgress` only, with fixtures taken from the captured stdout; if the pipe bar still appears during loading, no change needed
- [x] `docs/dev/UPDATING-BINARIES.md`: add a stable-diffusion.cpp section (repo, `master-<count>-<sha>` tag scheme, asset naming incl. the win-cpu consolidation and per-release macOS version stamp, cudart dependency, `sd-cli`/`sd-server`/ggml-DLL zip contents, digest-based checksum workflow); fix the stale "Timeout: 30 seconds" claim (actual: 120 s multi-component / 15 s single-file, `BinaryManager.ts:863`); retitle so it covers both binaries

**Verification**:
- [x] Build/lint/tests green after guard change (543/543, 0 TS errors, lint 0 errors)
- [x] `grep -ri "master-504\|636d3cb" src/ genai-electron-docs/ README.md` → 4 hits, all deliberate historical references ("crashed up to master-504…, fixed") in why-comments and the behavior-change docs; zero stale current-pin claims

### Phase 5: PROGRESS + release (v0.10.0)
**Goal**: Record the batch; release when the user gives the word.

**Steps**:
1. [x] PROGRESS.md: new v0.10.0 section — bump details (242 releases, backward-compatible surface, win-cpu consolidation, Linux Vulkan variant added), guard outcome with smoke evidence (box specs, models, per-flag matrix), riders; **fold-in line for `36952da`** (genai-lite 0.11 pairing notes; example pins genai-lite ^0.11.0 — already on main, previously unrecorded); strike the sd-bump follow-up (~line 501); add the cudart re-download-skip follow-up; refresh the status block (test counts, date)
2. [x] Update README status line (version/status) as part of the release PR
3. [x] (PR #36: https://github.com/lacerbi/genai-electron/pull/36) Push branch, open PR (single batch PR per release workflow), request user review
4. [x] (PR #37 merged, tag `v0.10.0` pushed, GitHub release published 2026-07-04; `npm publish` remains with the user) On user go-ahead: release PR mechanics — `package.json` version 0.10.0, migration note if the guard was retired (behavior change), merge → tag `v0.10.0` → GitHub release; **user runs `npm publish`** (guarded by `prepublishOnly`)

**Verification**:
- [x] CI green on the PR (all 6 checks: Code Quality, Package Validation, Security Audit, Node 22 tests on macos/ubuntu/windows)
- [x] PROGRESS entry includes live-smoke evidence and the 36952da fold-in
- [x] No version bump/tag until the user explicitly says release (respected — step 4 awaits go-ahead)

## Documentation (consolidated)
- `genai-electron-docs/troubleshooting.md` — CUDA offload section rewrite/refresh + tag references (Phase 4)
- `genai-electron-docs/image-generation.md` — CUDA warning, sampler list, offload JSDoc-mirroring text (Phases 2, 4)
- `genai-electron-docs/typescript-reference.md` — `ImageSampler` union (Phase 2)
- `docs/dev/UPDATING-BINARIES.md` — sd.cpp section, timeout fix, retitle (Phase 4)
- `PROGRESS.md`, `README.md` — release records (Phase 5)

## Risks
- **Tag is <24 h old.** Mitigation: our own five-part live smoke is the gate; upstream's open issues are Vulkan img2img/perf, not our path. Rollback: revert the defaults.ts commit — old release assets remain downloadable forever.
- **win-cpu runtime dispatch** could break if extract/copy drops a backend DLL → explicitly checked in Phase 3 step 5.
- **Guard retirement is a behavior change** for low-VRAM CUDA users (auto offload flags may now engage) → migration note + explicit-`false` override documented.
- **Loading-progress format unknown** until smoke → Phase 2 keeps that branch open rather than guessing.
- **Smoke downloads**: ~1 GB of binaries plus possibly model downloads on this box.

## Open Questions
- None. Confirmed 2026-07-03: smoke models expected on the box; Claude drives the smoke unattended (user checking in via phone); stay on `master-746-2574f59` even if newer tags exist at implementation time; sampler additions include the example-app select.

---
**Please review. Edit directly if needed, then confirm to proceed.**
