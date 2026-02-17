# Plan: Fix Documentation Deviations from Codebase

Created: 2026-02-17
Status: COMPLETE

## Summary

Fix all documentation deviations found by auditing `genai-electron-docs/` against the source code. 35+ issues across all 11 doc files. Also remove dead code found during audit (`DEFAULT_SERVER_CONFIG`, `HEALTH_CHECK_CONFIG`, `MODEL_SIZE_ESTIMATES` — all already removed).

## Scope

- **In scope**: All `genai-electron-docs/*.md` files, `src/index.ts` version tag + `BinaryLogEvent` export, `README.md` and `docs/SETUP.md` version references
- **Out of scope**: DESIGN.md, PROGRESS.md, example app code

## Code changes already done

- Removed dead `DEFAULT_SERVER_CONFIG` from `src/config/defaults.ts` (never imported anywhere)
- Removed dead `HEALTH_CHECK_CONFIG` from `src/config/defaults.ts` (never imported anywhere)
- Removed dead `MODEL_SIZE_ESTIMATES` from `src/config/defaults.ts` (never imported anywhere)
- Cleaned up unused `ServerConfig` import in `src/config/defaults.ts`

---

## Phase 1: `index.md` + `src/index.ts` + version refs

### Fixes:
- [x] 1. **[HIGH] Version 0.3.0 → 0.5.0** — Update `@version` in `src/index.ts` line 9. Also fix in `README.md` and `docs/SETUP.md`.
- [x] 2. **[MEDIUM] "Zero runtime dependencies" → accurate description** — Change to "Minimal runtime dependencies" and note the 3 deps (adm-zip, @huggingface/gguf, tar).
- [x] 3. **[MEDIUM] Quick start null safety** — Add optional chaining for `gpu.type` and `gpu.vram` in ALL quick start examples (both the LLM-only and the LLM+Image examples).
- [x] 4. **[MEDIUM] Variant fallback order** — Replace generic "CUDA → Vulkan → CPU" with a note that variant order is platform-specific.
- [x] 5. **[LOW] Phase status** — Update to current phase status per PROGRESS.md.

---

## Phase 2: `installation-and-setup.md`

### Fixes:
- [x] 6. **[MEDIUM] "Zero runtime dependencies" repeated** — Same fix as #2.
- [x] 7. **[MEDIUM] Variant fallback order repeated** — Same fix as #4.
- [x] 8. **[LOW] "2-10 seconds" timing** — Clarify that this is the variant testing time, not including download.

---

## Phase 3: `system-detection.md`

### Fixes:
- [x] 9. **[HIGH] `flashAttention` in `getOptimalConfig()`** — Remove `flashAttention` from documented return fields and example `console.log`. The method does not set it.
- [x] 10. **[HIGH] Context size algorithm** — Replace the RAM-based tiered description with the truth: always returns 4096 (llama.cpp default). Note the TODO/placeholder status.
- [x] 11. **[MEDIUM] `canRunModel()` options** — Add `gpuLayers` and `totalLayers` to the documented options parameter.
- [x] 12. **[MEDIUM] `parallelRequests` description** — Change from "concurrent request slots based on resources" to "always 1 (single-user Electron apps)".
- [x] 13. **[MEDIUM] GPU example `vulkan: true`** — Remove `vulkan: true` from NVIDIA and AMD GPU example outputs.
- [x] 14. **[MEDIUM] macOS VRAM** — Fix example to show ~70% of total RAM, add note about the estimation.
- [x] 15. **[LOW] Thread algorithm** — Replace "cores - 1 or cores / 2" with accurate tiered description.
- [x] 16. **[LOW] GPU layers description** — Add note about 2GB buffer reservation.

---

## Phase 4: `resource-orchestration.md`

### Fixes:
- [x] 17. **[MEDIUM] Offload threshold distinction** — Clarify GPU path uses `totalVRAM * 0.75`, CPU path uses `availableRAM * 0.75`.
- [x] 18. **[MEDIUM] CPU-only example** — Fix example to use available RAM, not total RAM.
- [x] 19. **[MEDIUM] `clearSavedState()` race** — Add note that reload is fire-and-forget; `clearSavedState()` after `orchestrateImageGeneration()` may not prevent a reload already in-flight.

---

## Phase 5: `model-management.md`

### Fixes:
- [x] 20. **[HIGH] `verifyModel()` behavior** — Document that it throws `ChecksumError` on mismatch, returns `false` only when no checksum is stored. Add multi-component behavior (throws `FileSystemError` on missing files).
- [x] 21. **[HIGH] `fetchGGUFMetadata` example** — Fix to use `parsed.metadata` and `getArchField(parsed.metadata, ...)` instead of top-level access.
- [x] 22. **[HIGH] `getArchField` example** — Fix from `metadata.raw` to `parsed.metadata`.
- [x] 23. **[MEDIUM] `deleteModel()` shared files** — Add note about shared-file protection for multi-component models.
- [x] 24. **[MEDIUM] `error.details` typing** — Add note that `details` is typed `unknown`; show proper type narrowing.
- [x] 25. **[MEDIUM] GGUF metadata failure asymmetry** — Document that metadata fetch failure is fatal for single-file downloads but non-fatal for multi-component.

---

## Phase 6: `llm-server.md`

### Fixes:
- [x] 26. **[HIGH] `'crashed'` event payload** — Change from `(error: Error)` to `(data: { code: number | null, signal: NodeJS.Signals | null })`. Fix in ALL occurrences (lines 371-372, 390-391).
- [x] 27. **[MEDIUM] `LlamaServerConfig` fields** — Add 5 missing fields: `modelAlias`, `continuousBatching`, `batchSize`, `useMmap`, `useMlock`. Show `extends ServerConfig`.
- [x] 28. **[MEDIUM] `start()` signature** — Note that TypeScript signature is `ServerConfig` but `LlamaServerConfig` fields are accepted at runtime via validation.
- [x] 29. **[MEDIUM] Undocumented public methods** — Add section for inherited `ServerManager` methods: `getPort()`, `getPid()`, `isRunning()`, `isStopped()`, `isStarting()`, `isStopping()`, `hasCrashed()`, `getConfig()`, `clearLogs()`, `getLogPath()`.
- [x] 30. **[MEDIUM] Missing events** — Add `'restarted'` and `'status'` events.
- [x] 31. **[MEDIUM] `getInfo().health`** — Add note that `health` always returns `'unknown'`; use `getHealthStatus()` for real health.
- [x] 32. **[MEDIUM] Variant pre-filtering** — Add note about CUDA GPU pre-filtering and platform-specific variant availability.

---

## Phase 7: `image-generation.md`

### Fixes:
- [x] 33. **[HIGH] CUDA offloading exception** — Add prominent warning that `--offload-to-cpu`, `--clip-on-cpu`, `--vae-on-cpu` are all auto-disabled for CUDA variants to prevent silent crashes.
- [x] 34. **[HIGH] `'crashed'` event does not exist** — DiffusionServerManager never emits `'crashed'`. Remove it from the events list or mark as unimplemented.
- [x] 35. **[MEDIUM] `batchSize` default** — Remove "(default: 1)" — no default is applied; sd.cpp uses its own internal default.
- [x] 36. **[MEDIUM] `clipOnCpu`/`vaeOnCpu` auto-detection** — Document auto-detection thresholds (6GB headroom for CLIP, 2GB for VAE) and CUDA exception.
- [x] 37. **[MEDIUM] `count` parameter behavior** — Clarify that `generateImage()` always returns 1 image; `count` is only used by the HTTP async API for batch.
- [x] 38. **[MEDIUM] `GenerationRegistry` env vars** — Clarify that env vars only work via the singleton `diffusionServer`, not direct `GenerationRegistry` construction.

---

## Phase 8: `integration-guide.md`

### Fixes:
- [x] 39. **[HIGH] `'crashed'` event payload** — Same fix as #26. Change `(error) => { ... error.message ... }` to `(data) => { ... data.code, data.signal ... }` (line 281-282).

---

## Phase 9: `typescript-reference.md`

### Fixes:
- [x] 40. **[HIGH] `BinaryLogEvent` export** — Add `BinaryLogEvent` to `src/index.ts` type exports (it's emitted by public `ServerManager` events).

---

## Phase 10: `troubleshooting.md`

### Fixes:
- [x] 41. Review for consistency with changes made above (version numbers, dependency claims). No specific issues identified. Verified clean.

---

## Phase 11: Final Validation

- [x] 42. Run `npm run build` to ensure code changes compile — ✅ 0 errors
- [x] 43. Run `npm test` to ensure no regressions — ✅ 418/418 passing
- [x] 44. Grep for remaining "0.3.0" references — ✅ Only in plan file and historical `docs/dev/` (out of scope)
- [x] 45. Grep for remaining "zero runtime dependencies" claims — ✅ Fixed in README.md, CLAUDE.md, PROGRESS.md. Only `docs/dev/phase1/` remains (historical archive, out of scope)
- [x] 46. Grep for remaining `(error: Error)` in crashed event handlers across all docs — ✅ None found. Also fixed JSDoc example in `src/index.ts`
- [x] 47. Review all changed docs for internal cross-doc consistency — ✅ Verified variant order language, version refs, dependency claims, crashed event patterns all consistent

---

**Please review. Edit directly if needed, then confirm to proceed.**
